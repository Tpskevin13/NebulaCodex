import { fetchWithRetry, readTextLimited } from "./http.js";

/**
 * Trae los modelos reales de cada proveedor:
 *  - Ollama: GET /api/tags (los que tenés instalados)
 *  - Anthropic: GET /v1/models
 *  - Resto (Groq, OpenRouter, NVIDIA, Gemini, OpenAI, personalizado): GET {baseUrl}/models
 */
export async function listModels(p: {
  id: string;
  kind: string;
  baseUrl: string;
  apiKey: string;
  authHeader?: "authorization" | "api-key";
}): Promise<string[]> {
  const base = p.baseUrl.replace(/\/+$/, "");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    let url: string;
    const headers: Record<string, string> = {};
    if (p.id === "ollama") {
      url = base.replace(/\/v1$/, "") + "/api/tags";
    } else if (p.kind === "anthropic") {
      url = base + "/v1/models?limit=1000";
      headers["x-api-key"] = p.apiKey;
      headers["anthropic-version"] = "2023-06-01";
    } else {
      url = base + "/models";
      if (p.apiKey) {
        if (p.authHeader === "api-key") headers["api-key"] = p.apiKey;
        else headers.authorization = `Bearer ${p.apiKey}`;
      }
    }
    let res: Response;
    try {
      res = await fetchWithRetry(
        url,
        { headers, signal: ctrl.signal },
        { signal: ctrl.signal, attempts: 2, headersTimeoutMs: 8_000, baseDelayMs: 250 },
      );
    } catch (e: any) {
      throw new Error(
        e?.name === "AbortError" ? "tardó demasiado en responder" : "no se pudo conectar",
      );
    }
    const body = await readTextLimited(res, 4 * 1024 * 1024);
    if (body.truncated) throw new Error("la lista de modelos es demasiado grande");
    let data: any;
    try {
      data = JSON.parse(body.text);
    } catch {
      throw new Error("la respuesta no es JSON válido");
    }
    let names: string[] =
      p.id === "ollama"
        ? (data.models ?? []).map((m: any) => String(m.name))
        : (data.data ?? data.models ?? []).map((m: any) =>
            String(m.id ?? m.name ?? "").replace(/^models\//, ""),
          );
    names = names.filter(Boolean);
    // Saca los que no son de chat (audio, embeddings, moderación…) si quedan otros
    const chatOnly = names.filter((n) => !/whisper|embed|tts|moderation|guard|rerank|image|imagen|dall-e|stable-diffusion|transcribe|speech/i.test(n));
    return [...new Set(chatOnly.length ? chatOnly : names)].sort();
  } finally {
    clearTimeout(timer);
  }
}
