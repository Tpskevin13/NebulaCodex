import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchWithRetry, HttpError, readTextLimited } from "../src/core/providers/http.ts";
import { listModels } from "../src/core/providers/models.ts";
import { streamChat } from "../src/core/providers/stream.ts";
import type { Msg, ResolvedProvider } from "../src/core/types.ts";

function sseResponse(chunks: string[], headers: Record<string, string> = {}): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { headers: { "content-type": "text/event-stream", ...headers } });
}

async function collect(provider: ResolvedProvider, messages: Msg[] = [], effort: "low" | "medium" | "high" | "max" = "medium", maxTokens?: number) {
  const events = [];
  for await (const event of streamChat(provider, "system", messages, [], new AbortController().signal, effort, maxTokens)) {
    events.push(event);
  }
  return events;
}

const openaiProvider: ResolvedProvider = {
  id: "custom",
  label: "Test",
  kind: "openai",
  baseUrl: "https://example.invalid/v1",
  model: "test-model",
  needsKey: false,
  apiKey: "",
  hint: "test",
};

const anthropicProvider: ResolvedProvider = {
  id: "anthropic",
  label: "Anthropic",
  kind: "anthropic",
  baseUrl: "https://api.anthropic.com",
  model: "claude-sonnet-4-5",
  needsKey: true,
  apiKey: "secret",
  hint: "test",
};

test("readTextLimited stops exactly at the byte limit and cancels the rest", async () => {
  const encoder = new TextEncoder();
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("abc"));
      controller.enqueue(encoder.encode("def"));
      controller.enqueue(encoder.encode("ghi"));
      controller.close();
    },
  }));
  assert.deepEqual(await readTextLimited(response, 4), { text: "abcd", truncated: true });

  const exact = new Response("abcdef");
  assert.deepEqual(await readTextLimited(exact, 6), { text: "abcdef", truncated: false });
  assert.deepEqual(await readTextLimited(new Response(null), 10), { text: "", truncated: false });
});

test("fetchWithRetry retries transient statuses and honours Retry-After", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return new Response("slow down", { status: 429, headers: { "retry-after": "0" } });
    return new Response("ok", { status: 200 });
  };
  try {
    const response = await fetchWithRetry("https://example.invalid", {}, { attempts: 3, baseDelayMs: 1 });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "ok");
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchWithRetry retries network failures and gives up after the last attempt", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls < 3) throw new TypeError("fetch failed");
    return new Response("ok");
  };
  try {
    const response = await fetchWithRetry("https://example.invalid", {}, { attempts: 3, baseDelayMs: 1 });
    assert.equal(await response.text(), "ok");
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }

  calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new TypeError("fetch failed");
  };
  try {
    await assert.rejects(
      fetchWithRetry("https://example.invalid", {}, { attempts: 2, baseDelayMs: 1 }),
      /fetch failed/,
    );
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchWithRetry does not retry client errors and exposes the response body", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response("bad request detail", { status: 400 });
  };
  try {
    await assert.rejects(
      fetchWithRetry("https://example.invalid", {}, { attempts: 3, baseDelayMs: 1 }),
      (error: unknown) => {
        assert.ok(error instanceof HttpError);
        assert.equal(error.status, 400);
        assert.match(error.detail, /bad request detail/);
        return true;
      },
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchWithRetry aborts promptly and reports header timeouts", async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  controller.abort();
  try {
    await assert.rejects(
      fetchWithRetry("https://example.invalid", {}, { signal: controller.signal }),
      (error: unknown) => error instanceof Error && error.name === "AbortError",
    );

    globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
    await assert.rejects(
      fetchWithRetry("https://example.invalid", {}, { attempts: 1, headersTimeoutMs: 20 }),
      /tardó más de 0 segundos/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAI-compatible streams assemble parallel tool calls even without indexes", async () => {
  const originalFetch = globalThis.fetch;
  const payload = [
    'data: {"choices":[{"delta":{"tool_calls":[{"id":"call_1","function":{"name":"read_file","arguments":"{\\"path\\":\\"a"}}]}}]}',
    "",
    'data: {"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"\\"}"}}]}}]}',
    "",
    'data: {"choices":[{"delta":{"tool_calls":[{"id":"call_2","function":{"name":"write_file","arguments":"{\\"path\\":\\"b\\"}"}}]}}]}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  globalThis.fetch = async () => sseResponse([payload]);
  try {
    const events = await collect(openaiProvider);
    assert.deepEqual(events, [{
      type: "done",
      toolCalls: [
        { id: "call_1", name: "read_file", args: { path: "a" } },
        { id: "call_2", name: "write_file", args: { path: "b" } },
      ],
    }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAI-compatible streams ignore repeated full tool names and flag invalid JSON", async () => {
  const originalFetch = globalThis.fetch;
  const payload = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":"{\\"path\\":\\"a\\"}"}}]}}]}',
    "",
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"read_file","arguments":""}}]}}]}',
    "",
    'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_2","function":{"name":"read_file","arguments":"{broken"}}]}}]}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  globalThis.fetch = async () => sseResponse([payload]);
  try {
    const events = await collect(openaiProvider);
    const done = events.at(-1);
    assert.equal(done?.type, "done");
    if (done?.type !== "done") return;
    assert.equal(done.toolCalls[0].name, "read_file");
    assert.deepEqual(done.toolCalls[0].args, { path: "a" });
    assert.equal(done.toolCalls[1].name, "__invalid_tool_call__");
    assert.deepEqual(done.toolCalls[1].args, {});
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("streams strip a UTF-8 BOM before parsing the first event", async () => {
  const originalFetch = globalThis.fetch;
  const payload = '﻿data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
  globalThis.fetch = async () => sseResponse([payload.slice(0, 8), payload.slice(8)]);
  try {
    assert.deepEqual(await collect(openaiProvider), [
      { type: "text", text: "ok" },
      { type: "done", toolCalls: [] },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAI-compatible requests cap output tokens and use the right field name", async () => {
  const originalFetch = globalThis.fetch;
  const bodies: any[] = [];
  const payload = 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return sseResponse([payload]);
  };
  try {
    await collect(openaiProvider, [], "medium", 3000);
    assert.equal(bodies[0].max_tokens, 3000);
    assert.equal("max_completion_tokens" in bodies[0], false);
    assert.equal("reasoning_effort" in bodies[0], false);

    const directOpenAI: ResolvedProvider = {
      ...openaiProvider,
      id: "openai",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-5.5",
      apiKey: "sk-test",
    };
    await collect(directOpenAI, [], "max", 2000);
    assert.equal(bodies[1].max_completion_tokens, 2000);
    assert.equal("max_tokens" in bodies[1], false);
    assert.equal(bodies[1].reasoning_effort, "high");

    await collect(openaiProvider);
    assert.equal(bodies[2].max_tokens, 4096);
    await collect(openaiProvider, [], "medium", 1);
    assert.equal(bodies[3].max_tokens, 256);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Anthropic requests honour and clamp the output token cap", async () => {
  const originalFetch = globalThis.fetch;
  const bodies: any[] = [];
  const payload = 'data: {"type":"message_stop"}\n\n';
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return sseResponse([payload]);
  };
  try {
    await collect(anthropicProvider, [], "medium", 3000);
    assert.equal(bodies[0].max_tokens, 3000);
    await collect(anthropicProvider);
    assert.equal(bodies[1].max_tokens, 8192);
    await collect(anthropicProvider, [], "medium", 999_999);
    assert.equal(bodies[2].max_tokens, 65_536);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Anthropic requests merge consecutive user turns and omit empty assistant text", async () => {
  const originalFetch = globalThis.fetch;
  let body: any = null;
  const messages: Msg[] = [
    { role: "user", content: "first" },
    { role: "user", content: "second" },
    {
      role: "assistant",
      content: "\n",
      toolCalls: [{ id: "tool_1", name: "read_file", args: { path: "a.txt" } }],
    },
    { role: "tool", content: "contents", toolCallId: "tool_1", toolName: "read_file" },
  ];
  const payload = [
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tool_2","name":"write_file"}}',
    "",
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"b.txt\\",\\"content\\":\\"x\\"}"}}',
    "",
    'data: {"type":"message_stop"}',
    "",
  ].join("\n");
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return sseResponse([payload]);
  };
  try {
    const events = await collect(anthropicProvider, messages, "max");
    assert.deepEqual(events, [{
      type: "done",
      toolCalls: [{ id: "tool_2", name: "write_file", args: { path: "b.txt", content: "x" } }],
    }]);
    assert.equal(body.messages.length, 3);
    assert.deepEqual(body.messages[0], {
      role: "user",
      content: [{ type: "text", text: "first" }, { type: "text", text: "second" }],
    });
    assert.deepEqual(body.messages[1], {
      role: "assistant",
      content: [{ type: "tool_use", id: "tool_1", name: "read_file", input: { path: "a.txt" } }],
    });
    assert.deepEqual(body.messages[2], {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tool_1", content: "contents" }],
    });
    assert.deepEqual(body.thinking, { type: "adaptive" });
    assert.deepEqual(body.output_config, { effort: "high" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Anthropic streams fail closed when message_stop never arrives", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => sseResponse([
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n',
  ]);
  try {
    await assert.rejects(
      collect(anthropicProvider),
      /Anthropic cerró el flujo antes de completar/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("listModels adapts URLs, auth headers, and filters non-chat models", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; headers: any }> = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), headers: init?.headers });
    if (String(url).includes("/api/tags")) {
      return new Response(JSON.stringify({
        models: [{ name: "qwen3.5:4b" }, { name: "nomic-embed-text" }],
      }));
    }
    return new Response(JSON.stringify({
      data: [{ id: "models/gemini-3.8-flash" }, { id: "text-embedding-004" }],
    }));
  };
  try {
    assert.deepEqual(await listModels({
      id: "ollama",
      kind: "openai",
      baseUrl: "http://localhost:11434/v1",
      apiKey: "",
    }), ["qwen3.5:4b"]);
    assert.equal(requests[0].url, "http://localhost:11434/api/tags");

    assert.deepEqual(await listModels({
      id: "gemini",
      kind: "openai",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      apiKey: "key",
    }), ["gemini-3.8-flash"]);
    assert.equal(requests[1].url, "https://generativelanguage.googleapis.com/v1beta/openai/models");
    assert.equal(requests[1].headers.authorization, "Bearer key");

    assert.deepEqual(await listModels({
      id: "azure-openai",
      kind: "openai",
      baseUrl: "https://example.openai.azure.com/openai/v1/",
      apiKey: "azure-key",
      authHeader: "api-key",
    }), ["gemini-3.8-flash"]);
    assert.equal(requests[2].headers["api-key"], "azure-key");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
