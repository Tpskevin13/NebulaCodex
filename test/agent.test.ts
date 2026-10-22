import assert from "node:assert/strict";
import { test } from "node:test";
import {
  batchSignature,
  createLoopGuard,
  normalizeConversation,
  recoverHistory,
  registerToolBatch,
  toolSignature,
} from "../src/core/agent.ts";
import type { Msg, ToolCall } from "../src/core/types.ts";

const readFile: ToolCall = { id: "call-a", name: "read_file", args: { path: "a.txt" } };
const writeFile: ToolCall = { id: "call-b", name: "write_file", args: { path: "b.txt", content: "x" } };

test("tool signatures ignore object key order but keep distinct calls apart", () => {
  const first: ToolCall = { id: "1", name: "edit_file", args: { path: "a", old: "x", new: "y" } };
  const second: ToolCall = { id: "2", name: "edit_file", args: { new: "y", old: "x", path: "a" } };
  assert.equal(toolSignature(first), toolSignature(second));
  assert.notEqual(toolSignature(first), toolSignature({ ...second, args: { path: "a", old: "x", new: "z" } }));
  assert.equal(batchSignature([readFile, writeFile]), `${toolSignature(readFile)}\u0000${toolSignature(writeFile)}`);
});

test("the loop guard stops after the configured number of identical batches", () => {
  const guard = createLoopGuard();
  assert.deepEqual(registerToolBatch(guard, []), { signature: "", repeats: 0, repeated: false });
  assert.equal(registerToolBatch(guard, [readFile]).repeated, false);
  assert.equal(registerToolBatch(guard, [readFile]).repeats, 2);
  const third = registerToolBatch(guard, [readFile]);
  assert.equal(third.repeats, 3);
  assert.equal(third.repeated, true);

  assert.equal(registerToolBatch(guard, [writeFile]).repeats, 1);
  assert.equal(registerToolBatch(guard, [writeFile], 2).repeated, true);
});

test("recoverHistory keeps completed work and closes interrupted tool calls", () => {
  const messages: Msg[] = [
    { role: "user", content: "old" },
    { role: "assistant", content: "old reply" },
    { role: "user", content: "change both files" },
    { role: "assistant", content: "", toolCalls: [readFile, writeFile] },
    { role: "tool", content: "contents", toolCallId: readFile.id, toolName: readFile.name },
  ];

  const recovered = recoverHistory(messages, 2, "Interrumpido");
  assert.deepEqual(recovered.slice(0, 2), messages.slice(0, 2));
  assert.equal(recovered[2].role, "user");
  assert.equal(recovered[2].content, "change both files");
  assert.equal(recovered[3].role, "assistant");
  assert.equal(recovered[3].toolCalls?.length, 2);
  assert.equal(recovered[4].content, "contents");
  assert.equal(recovered[5].role, "tool");
  assert.equal(recovered[5].toolCallId, writeFile.id);
  assert.match(recovered[5].content, /se interrumpió/);
  // El aviso no puede quedar después de un resultado de herramienta: se agrega como turno del asistente.
  assert.equal(recovered.at(-1)?.role, "assistant");
  assert.equal(recovered.at(-1)?.content, "Interrumpido");
});

test("recoverHistory drops orphan results and empty assistants, and merges the notice into a final reply", () => {
  const messages: Msg[] = [
    { role: "user", content: "hello" },
    { role: "tool", content: "orphan", toolCallId: "missing" },
    { role: "assistant", content: "   " },
    { role: "assistant", content: "final answer" },
  ];
  const recovered = recoverHistory(messages, 0, "nota");
  assert.deepEqual(recovered, [
    { role: "user", content: "hello" },
    { role: "assistant", content: "final answer\n\nnota" },
  ]);
});

test("recoverHistory sanitises malformed tool calls and duplicate ids", () => {
  const malformed = [
    { id: "same", name: "read_file", args: { path: "a" } },
    { id: "same", name: "read_file", args: { path: "b" } },
    { id: "", name: "read_file", args: {} },
    { id: "array", name: "read_file", args: [] },
  ] as unknown as ToolCall[];
  const recovered = recoverHistory(
    [
      { role: "user", content: "go" },
      { role: "assistant", content: "", toolCalls: malformed },
      { role: "tool", content: "ok", toolCallId: "same", toolName: "read_file" },
      { role: "tool", content: "extra", toolCallId: "array" },
    ],
    0,
  );
  assert.equal(recovered[1].toolCalls?.length, 2);
  assert.deepEqual(recovered[1].toolCalls?.[1].args, {});
  assert.equal(recovered.filter((message) => message.toolCallId === "same").length, 1);
  assert.equal(recovered.at(-1)?.role, "tool");
  assert.equal(recovered.at(-1)?.toolCallId, "array");
});

test("normalizeConversation discards everything before the first user and repairs loaded chats", () => {
  const loaded: Msg[] = [
    { role: "assistant", content: "stale" },
    { role: "tool", content: "orphan", toolCallId: "x" },
    { role: "user", content: "question" },
    { role: "assistant", content: "", toolCalls: [{ id: "open", name: "read_file", args: { path: "a" } }] },
  ];
  const normalized = normalizeConversation(loaded);
  assert.equal(normalized[0].role, "user");
  assert.equal(normalized.length, 3);
  assert.equal(normalized[2].role, "tool");
  assert.equal(normalized[2].toolCallId, "open");
});
