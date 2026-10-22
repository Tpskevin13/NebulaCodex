import { setTimeout as delay } from "node:timers/promises";

/**
 * Capa HTTP compartida por los proveedores.
 *
 * Los reintentos solo se aplican antes de empezar a consumir el cuerpo de una respuesta correcta:
 * repetir un stream que ya emitió texto duplicaría contenido. Los errores transitorios (red, 429, 5xx)
 * se reintentan con espera exponencial y se respeta `Retry-After`.
 */

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Tiempo máximo para recibir las cabeceras; el cuerpo en streaming no tiene este límite. */
  headersTimeoutMs?: number;
  signal?: AbortSignal;
}

export class HttpError extends Error {
  readonly status: number;
  readonly detail: string;

  constructor(status: number, detail: string) {
    super(`HTTP ${status}${detail ? `: ${detail}` : ""}`);
    this.name = "HttpError";
    this.status = status;
    this.detail = detail;
  }
}

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 350;
const DEFAULT_MAX_DELAY_MS = 8_000;
const DEFAULT_HEADERS_TIMEOUT_MS = 90_000;

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function abortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const error = new Error("La operación fue cancelada.");
  error.name = "AbortError";
  return error;
}

function retryAfterMs(response: Response): number | null {
  const value = response.headers.get("retry-after")?.trim();
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, Math.min(date - Date.now(), 60_000));
}

function backoffMs(attempt: number, base: number, max: number): number {
  const exponential = Math.min(max, base * 2 ** attempt);
  // Jitter para que varias solicitudes no reintenten exactamente al mismo tiempo.
  return Math.round(exponential * (0.8 + Math.random() * 0.4));
}

/** Lee como texto hasta `maxBytes`, cancelando el resto del cuerpo. */
export async function readTextLimited(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) {
    const text = await response.text();
    return { text: text.slice(0, maxBytes), truncated: text.length > maxBytes };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let received = 0;
  let truncated = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        text += decoder.decode();
        break;
      }
      const chunkBytes = value.byteLength;
      if (received + chunkBytes > maxBytes) {
        const remaining = Math.max(0, maxBytes - received);
        if (remaining > 0) text += decoder.decode(value.subarray(0, remaining), { stream: true });
        truncated = true;
        await reader.cancel().catch(() => {});
        break;
      }
      received += chunkBytes;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  return { text, truncated };
}

export async function fetchWithRetry(
  input: string | URL,
  init: RequestInit = {},
  options: RetryOptions = {},
): Promise<Response> {
  const attempts = Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS);
  const baseDelay = Math.max(1, options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS);
  const maxDelay = Math.max(baseDelay, options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS);
  const headersTimeout = Math.max(1, options.headersTimeoutMs ?? DEFAULT_HEADERS_TIMEOUT_MS);
  const signal = options.signal ?? init.signal ?? undefined;

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (signal?.aborted) throw abortError(signal);

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, headersTimeout);
    const forwardAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", forwardAbort, { once: true });

    let response: Response;
    try {
      response = await fetch(input, { ...init, signal: controller.signal });
    } catch (error) {
      if (signal?.aborted) throw abortError(signal);
      if (timedOut) {
        if (attempt < attempts - 1) {
          await delay(backoffMs(attempt, baseDelay, maxDelay), undefined, { signal });
          continue;
        }
        throw new Error(`El proveedor tardó más de ${Math.round(headersTimeout / 1000)} segundos en responder.`);
      }
      if (attempt < attempts - 1) {
        await delay(backoffMs(attempt, baseDelay, maxDelay), undefined, { signal });
        continue;
      }
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", forwardAbort);
    }

    if (response.ok) return response;

    const body = await readTextLimited(response, 4096).catch(() => ({ text: "", truncated: false }));
    if (RETRYABLE_STATUS.has(response.status) && attempt < attempts - 1) {
      const wait = retryAfterMs(response) ?? backoffMs(attempt, baseDelay, maxDelay);
      await delay(wait, undefined, { signal });
      continue;
    }
    throw new HttpError(response.status, body.text.trim().slice(0, 1200));
  }

  throw new Error("No se pudo completar la solicitud al proveedor.");
}
