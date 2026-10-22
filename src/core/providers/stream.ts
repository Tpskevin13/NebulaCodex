import type { EffortLevel, Msg, ResolvedProvider, StreamEvent, ToolCall, ToolDef } from "../types.js";
import { fetchWithRetry } from "./http.js";

function parseToolArgs(raw: string): Record<string, any> | null {
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, any>)
      : null;
  } catch {
    return null;
  }
}

const MAX_SSE_BUFFER_CHARS = 2 * 1024 * 1024;
const SSE_IDLE_TIMEOUT_MS = 120_000;

async function* sseData(res: Response): AsyncGenerator<string> {
  if (!res.body) throw new Error("El proveedor devolvió una respuesta sin contenido.");
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let dataLines: string[] = [];
  let firstChunk = true;

  const readLine = (rawLine: string): string | null => {
    const line = rawLine.replace(/\r$/, "");
    if (!line) {
      if (!dataLines.length) return null;
      const data = dataLines.join("\n");
      dataLines = [];
      return data;
    }
    if (line.startsWith(":")) return null;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    if (field !== "data") return null;
    let value = separator < 0 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    dataLines.push(value);
    return null;
  };

  const readChunk = async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("El proveedor dejó de enviar datos durante más de 120 segundos.")),
        SSE_IDLE_TIMEOUT_MS,
      );
    });
    try {
      return await Promise.race([reader.read(), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  try {
    while (true) {
      const { value, done } = await readChunk();
      let decoded = done ? dec.decode() : dec.decode(value, { stream: true });
      if (firstChunk && decoded) {
        // Algunos gateways anteponen un BOM; JSON.parse lo rechazaría.
        decoded = decoded.replace(/^﻿/, "");
        firstChunk = false;
      }
      buf += decoded;
      if (buf.length > MAX_SSE_BUFFER_CHARS) {
        throw new Error("El proveedor envió una línea SSE demasiado grande.");
      }
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        const data = readLine(line);
        if (data !== null) yield data;
      }
      if (done) {
        if (buf) {
          const data = readLine(buf);
          if (data !== null) yield data;
          buf = "";
        }
        if (dataLines.length) yield dataLines.join("\n");
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** OpenAI solo acepta `minimal|low|medium|high`; `xhigh` queda para los modelos Codex Max. */
function openAIReasoningEffort(model: string, effort: EffortLevel): string {
  if (effort === "max") return /codex-max/i.test(model) ? "xhigh" : "high";
  return effort;
}

function openAIEffortSupported(model: string): boolean {
  return /^(?:gpt-[5-9]|o[134](?:-|$)|gpt-oss)/i.test(model);
}

/**
 * Limita la salida y elige el nombre correcto del campo.
 *
 * Sin este tope algunos gateways (OpenRouter) reservan el máximo del modelo —hasta 131k tokens—
 * antes de responder, lo que agota el crédito o directamente devuelve 402. Los modelos de
 * razonamiento de OpenAI usan `max_completion_tokens`; el resto, `max_tokens`.
 */
function outputTokenLimit(provider: ResolvedProvider, maxTokens: number): Record<string, number> {
  const value = Math.max(256, Math.min(Math.floor(maxTokens), 65_536));
  if (provider.id === "openai" && /^(?:gpt-[5-9]|o[1-4])(?:[.-]|$)/i.test(provider.model)) {
    return { max_completion_tokens: value };
  }
  return { max_tokens: value };
}

function requestHeaders(p: ResolvedProvider, stream: boolean): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(stream ? { accept: "text/event-stream" } : {}),
    ...(p.apiKey
      ? p.authHeader === "api-key"
        ? { "api-key": p.apiKey }
        : { authorization: `Bearer ${p.apiKey}` }
      : {}),
  };
}

// ---------- OpenAI-compatible (NVIDIA, Ollama, Gemini, Groq, OpenRouter, OpenAI) ----------

function toOpenAIMessages(system: string, msgs: Msg[]) {
  const out: any[] = [{ role: "system", content: system }];
  for (const m of msgs) {
    if (m.role === "user") out.push({ role: "user", content: m.content });
    else if (m.role === "assistant") {
      const o: any = { role: "assistant", content: m.content || null };
      if (m.toolCalls?.length)
        o.tool_calls = m.toolCalls.map((t) => ({
          id: t.id,
          type: "function",
          function: { name: t.name, arguments: JSON.stringify(t.args) },
        }));
      out.push(o);
    } else out.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
  }
  return out;
}

async function* streamOpenAI(
  p: ResolvedProvider,
  system: string,
  msgs: Msg[],
  tools: ToolDef[],
  signal: AbortSignal,
  effort: EffortLevel,
  maxTokens: number,
): AsyncGenerator<StreamEvent> {
  const supportsReasoningEffort = openAIEffortSupported(p.model);
  const res = await fetchWithRetry(
    p.baseUrl.replace(/\/$/, "") + "/chat/completions",
    {
      method: "POST",
      signal,
      headers: requestHeaders(p, true),
      body: JSON.stringify({
        model: p.model,
        stream: true,
        ...outputTokenLimit(p, maxTokens),
        ...(supportsReasoningEffort ? { reasoning_effort: openAIReasoningEffort(p.model, effort) } : {}),
        messages: toOpenAIMessages(system, msgs),
        ...(tools.length ? { tools: tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.parameters },
        })) } : {}),
      }),
    },
    { signal },
  );

  const acc: Record<number, { id: string; name: string; args: string }> = {};
  let lastToolIndex = -1;
  let completed = false;
  for await (const data of sseData(res)) {
    if (data === "[DONE]") {
      completed = true;
      break;
    }
    let j: any;
    try {
      j = JSON.parse(data);
    } catch {
      continue;
    }
    if (j.error) {
      throw new Error(j.error.message ?? JSON.stringify(j.error));
    }
    const choice = j.choices?.[0];
    if (choice?.finish_reason != null) completed = true;
    const delta = choice?.delta;
    if (!delta) continue;
    if (delta.content) yield { type: "text", text: delta.content };
    for (const tc of delta.tool_calls ?? []) {
      // Some OpenAI-compatible providers (e.g. Gemini) omit `index`; a new `id` then starts a new call
      // instead of merging parallel calls into one invalid JSON string.
      let idx: number;
      if (typeof tc.index === "number") idx = tc.index;
      else if (tc.id && acc[lastToolIndex] && acc[lastToolIndex].id !== tc.id) idx = lastToolIndex + 1;
      else idx = Math.max(lastToolIndex, 0);
      lastToolIndex = idx;
      const a = (acc[idx] ??= { id: "", name: "", args: "" });
      if (tc.id) a.id = tc.id;
      const nameChunk = tc.function?.name;
      if (nameChunk) {
        // Standard streaming sends the name once; a few gateways repeat the full name in each chunk.
        if (!a.name) a.name = nameChunk;
        else if (nameChunk !== a.name && !a.name.endsWith(nameChunk)) a.name += nameChunk;
      }
      if (tc.function?.arguments) a.args += tc.function.arguments;
    }
  }
  if (!completed) throw new Error("El proveedor cerró el flujo antes de completar la respuesta.");
  const toolCalls: ToolCall[] = Object.values(acc).map((a, i) => {
    const args = parseToolArgs(a.args || "{}");
    return {
      id: a.id || `call_${Date.now().toString(36)}_${i}`,
      name: args ? a.name : "__invalid_tool_call__",
      args: args ?? {},
    };
  });
  yield { type: "done", toolCalls };
}

// ---------- Anthropic ----------

function toAnthropicMessages(msgs: Msg[]) {
  const out: any[] = [];
  const appendUser = (blocks: any[]) => {
    const last = out[out.length - 1];
    if (last?.role === "user") {
      if (typeof last.content === "string") {
        last.content = last.content ? [{ type: "text", text: last.content }] : [];
      }
      last.content.push(...blocks);
    } else {
      out.push({
        role: "user",
        content: blocks.length === 1 && blocks[0].type === "text" ? blocks[0].text : blocks,
      });
    }
  };
  for (const m of msgs) {
    if (m.role === "user") {
      appendUser([{ type: "text", text: m.content }]);
    } else if (m.role === "assistant") {
      const content: any[] = [];
      // Anthropic rejects text blocks that are empty or only whitespace (models often emit "\n" before a tool call).
      if (m.content.trim()) content.push({ type: "text", text: m.content });
      for (const t of m.toolCalls ?? [])
        content.push({ type: "tool_use", id: t.id, name: t.name, input: t.args });
      // Un asistente vacío no aporta nada y la API lo rechaza.
      if (content.length) out.push({ role: "assistant", content });
    } else {
      appendUser([{ type: "tool_result", tool_use_id: m.toolCallId, content: m.content }]);
    }
  }
  return out;
}

async function* streamAnthropic(
  p: ResolvedProvider,
  system: string,
  msgs: Msg[],
  tools: ToolDef[],
  signal: AbortSignal,
  effort: EffortLevel,
  maxTokens: number,
): AsyncGenerator<StreamEvent> {
  const supportsAdaptiveEffort = /(?:opus|sonnet|fable)-(?:4[.-](?:5|6|7|8)|5)(?:[.-]|$)/i.test(p.model);
  const res = await fetchWithRetry(
    p.baseUrl.replace(/\/$/, "") + "/v1/messages",
    {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        "x-api-key": p.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: p.model,
        max_tokens: Math.max(256, Math.min(Math.floor(maxTokens), 65_536)),
        ...(supportsAdaptiveEffort
          ? {
              thinking: { type: "adaptive" },
              // La API de esfuerzo usa low/medium/high; "max" se aproxima con "high".
              output_config: { effort: effort === "max" ? "high" : effort },
            }
          : {}),
        stream: true,
        system,
        messages: toAnthropicMessages(msgs),
        ...(tools.length ? { tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters,
        })) } : {}),
      }),
    },
    { signal },
  );

  const blocks: Record<number, { id: string; name: string; json: string }> = {};
  let completed = false;
  for await (const data of sseData(res)) {
    let j: any;
    try {
      j = JSON.parse(data);
    } catch {
      continue;
    }
    if (j.type === "content_block_start" && j.content_block?.type === "tool_use") {
      blocks[j.index] = { id: j.content_block.id, name: j.content_block.name, json: "" };
    } else if (j.type === "content_block_delta") {
      if (j.delta?.type === "text_delta") yield { type: "text", text: j.delta.text };
      else if (j.delta?.type === "input_json_delta" && blocks[j.index])
        blocks[j.index].json += j.delta.partial_json;
    } else if (j.type === "error") {
      throw new Error(j.error?.message ?? "Error de Anthropic");
    } else if (j.type === "message_stop") {
      completed = true;
    }
  }
  if (!completed) throw new Error("Anthropic cerró el flujo antes de completar la respuesta.");
  const toolCalls: ToolCall[] = Object.values(blocks).map((b) => {
    const args = parseToolArgs(b.json || "{}");
    return { id: b.id, name: args ? b.name : "__invalid_tool_call__", args: args ?? {} };
  });
  yield { type: "done", toolCalls };
}

export function streamChat(
  p: ResolvedProvider,
  system: string,
  msgs: Msg[],
  tools: ToolDef[],
  signal: AbortSignal,
  effort: EffortLevel = "medium",
  maxTokens: number = p.kind === "anthropic" ? 8192 : 4096,
): AsyncGenerator<StreamEvent> {
  return p.kind === "anthropic"
    ? streamAnthropic(p, system, msgs, tools, signal, effort, maxTokens)
    : streamOpenAI(p, system, msgs, tools, signal, effort, maxTokens);
}
