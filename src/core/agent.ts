import type { Msg, ToolCall } from "./types.js";

const INTERRUPTED_TOOL_RESULT =
  "Error: la ejecución se interrumpió antes de devolver un resultado. No vuelvas a ejecutar la acción sin comprobar su efecto.";

function stableValue(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  }
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableValue(record[key])}`)
    .join(",")}}`;
}

/** Firma estable para comparar llamadas aunque el modelo cambie el orden de las claves. */
export function toolSignature(call: ToolCall): string {
  return `${call.name}:${stableValue(call.args ?? {})}`;
}

export function batchSignature(calls: readonly ToolCall[]): string {
  return calls.map(toolSignature).join("\u0000");
}

export interface LoopGuardState {
  lastBatch: string;
  repeats: number;
}

export function createLoopGuard(): LoopGuardState {
  return { lastBatch: "", repeats: 0 };
}

/**
 * Detecta al modelo pidiendo exactamente el mismo lote de herramientas una y otra vez.
 * El primer lote cuenta como repetición 1; al llegar a `maxRepeats` conviene cortar en vez de
 * ejecutar la misma acción por tercera vez.
 */
export function registerToolBatch(
  state: LoopGuardState,
  calls: readonly ToolCall[],
  maxRepeats = 3,
): { signature: string; repeats: number; repeated: boolean } {
  if (!calls.length) return { signature: "", repeats: 0, repeated: false };
  const signature = batchSignature(calls);
  if (signature === state.lastBatch) state.repeats += 1;
  else {
    state.lastBatch = signature;
    state.repeats = 1;
  }
  return { signature, repeats: state.repeats, repeated: state.repeats >= maxRepeats };
}

function validCalls(calls: readonly ToolCall[] | undefined): ToolCall[] {
  if (!calls?.length) return [];
  const seen = new Set<string>();
  const out: ToolCall[] = [];
  for (const call of calls) {
    if (!call || typeof call.id !== "string" || !call.id.trim()) continue;
    if (typeof call.name !== "string" || !call.name.trim()) continue;
    if (seen.has(call.id)) continue;
    seen.add(call.id);
    out.push({
      id: call.id,
      name: call.name,
      args: call.args && typeof call.args === "object" && !Array.isArray(call.args) ? call.args : {},
    });
  }
  return out;
}

/**
 * Deja un historial válido después de un corte o un error.
 *
 * - Conserva los turnos completos de la ejecución en curso (antes se descartaban todos, por lo que
 *   el modelo podía repetir acciones que ya habían modificado archivos).
 * - Cierra las llamadas a herramientas que quedaron sin resultado con un mensaje de error, para que
 *   el próximo turno no tenga `tool_use` huérfanos (Anthropic y OpenAI lo rechazan).
 * - Elimina resultados de herramientas sin llamada previa y asistentes vacíos.
 */
export function recoverHistory(messages: readonly Msg[], runStart: number, notice?: string): Msg[] {
  const start = Math.min(Math.max(0, runStart), messages.length);
  const out: Msg[] = messages.slice(0, start).map((message) => ({ ...message }));
  const pending = new Map<string, ToolCall>();

  const flushPending = () => {
    for (const call of pending.values()) {
      out.push({
        role: "tool",
        content: INTERRUPTED_TOOL_RESULT,
        toolCallId: call.id,
        toolName: call.name,
      });
    }
    pending.clear();
  };

  for (const message of messages.slice(start)) {
    if (!message || typeof message.content !== "string") continue;
    if (message.role === "user") {
      flushPending();
      out.push({ role: "user", content: message.content });
    } else if (message.role === "assistant") {
      flushPending();
      const calls = validCalls(message.toolCalls);
      if (calls.length) {
        out.push({ role: "assistant", content: message.content, toolCalls: calls });
        for (const call of calls) pending.set(call.id, call);
      } else if (message.content.trim()) {
        out.push({ role: "assistant", content: message.content });
      }
    } else if (message.role === "tool") {
      if (!message.toolCallId || !pending.has(message.toolCallId)) continue;
      out.push({
        role: "tool",
        content: message.content,
        toolCallId: message.toolCallId,
        toolName: message.toolName ?? pending.get(message.toolCallId)?.name,
      });
      pending.delete(message.toolCallId);
    }
  }
  flushPending();

  if (notice?.trim()) {
    const last = out[out.length - 1];
    if (last?.role === "assistant") {
      out[out.length - 1] = { ...last, content: `${last.content}\n\n${notice}`.trim() };
    } else {
      out.push({ role: "assistant", content: notice });
    }
  }
  return out;
}

/** Historial cargado de disco: repara pares herramienta/resultado y descarta un encabezado inválido. */
export function normalizeConversation(messages: readonly Msg[]): Msg[] {
  const repaired = recoverHistory(messages, 0);
  let firstUser = 0;
  while (firstUser < repaired.length && repaired[firstUser].role !== "user") firstUser++;
  return repaired.slice(firstUser);
}
