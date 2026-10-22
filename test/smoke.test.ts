import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { WriteStream } from "node:tty";
import { runCommand, runTool, undoLastChange } from "../src/core/tools.ts";
import { loadConfig, saveConfig } from "../src/core/providers/config.ts";
import { chatToMarkdown, exportChat } from "../src/core/export.ts";
import { trimHistory } from "../src/core/history.ts";
import { streamChat } from "../src/core/providers/stream.ts";
import { enableLineDiff } from "../src/ui/line-diff.ts";
import type { Msg, ResolvedProvider } from "../src/core/types.ts";

const workspace = path.resolve(process.cwd());
let temporaryDirectory = "";
let originalLookup = dns.lookup;

beforeEach(() => {
  temporaryDirectory = fs.mkdtempSync(path.join(workspace, ".nebulacodex-smoke-"));
  originalLookup = dns.lookup;
  // Las pruebas descargan URLs ficticias con fetch simulado; resolvemos el host a una IP pública.
  (dns as any).lookup = async () => [{ address: "93.184.216.34", family: 4 }];
});

afterEach(() => {
  (dns as any).lookup = originalLookup;
  const target = path.resolve(temporaryDirectory);
  assert.ok(target.startsWith(workspace + path.sep), "cleanup must stay inside the project workspace");
  fs.rmSync(target, { recursive: true, force: true });
});

test("file tools write, read, search, find, edit, and list text files", async () => {
  const nested = path.join(temporaryDirectory, "nested");
  const file = path.join(nested, "notes.txt");

  assert.match(await runTool("write_file", { path: file, content: "Nebula alpha\nsecond line\n" }), /^Archivo escrito:/);
  assert.equal(await runTool("read_file", { path: file }), "Nebula alpha\nsecond line\n");
  assert.match(await runTool("search_text", { path: nested, query: "alpha" }), /notes\.txt:1: Nebula alpha/);
  assert.match(await runTool("find_files", { path: temporaryDirectory, query: "notes" }), /notes\.txt/);
  assert.match(await runTool("list_dir", { path: nested }), /notes\.txt/);
  assert.equal(await runTool("edit_file", { path: file, old: "alpha", new: "beta" }), `Editado: ${file}`);
  assert.equal(await runTool("read_file", { path: file }), "Nebula beta\nsecond line\n");
});

test("read_file pages through long files with offset and flags invalid tool calls", async () => {
  const file = path.join(temporaryDirectory, "long.txt");
  fs.writeFileSync(file, "a".repeat(12_000) + "b".repeat(500));
  assert.match(await runTool("read_file", { path: file }), /siguen 500 caracteres; usá offset=12000/);
  assert.equal(await runTool("read_file", { path: file, offset: 12_000 }), "b".repeat(500));
  assert.match(await runTool("read_file", { path: file, offset: 99_999 }), /supera el largo/);
  assert.match(await runTool("read_file", { path: file, offset: -1 }), /entero/);
  assert.match(await runTool("__invalid_tool_call__", {}), /JSON válido/);
});

test("file tools reject invalid edits, binary reads, and pre-cancelled commands", async () => {
  const file = path.join(temporaryDirectory, "duplicate.txt");
  fs.writeFileSync(file, "same same");
  assert.match(await runTool("edit_file", { path: file, old: "same", new: "changed" }), /aparece 2 veces/);
  assert.match(await runTool("search_text", { path: temporaryDirectory }), /query.*obligatorio/);

  const binary = path.join(temporaryDirectory, "binary.dat");
  fs.writeFileSync(binary, Buffer.from([0, 1, 2, 3]));
  assert.match(await runTool("read_file", { path: binary }), /parece binario/);

  const controller = new AbortController();
  controller.abort();
  assert.match(await runTool("run_command", { command: "this must not run" }, controller.signal), /cancelada/);
});

test("search_text supports regular expressions and rejects invalid ones", async () => {
  const file = path.join(temporaryDirectory, "code.ts");
  fs.writeFileSync(file, "const alpha = 1;\nconst beta2 = 22;\n");
  assert.match(await runTool("search_text", { path: temporaryDirectory, query: "beta\\d+", regex: true }), /code\.ts:2:/);
  assert.equal(await runTool("search_text", { path: temporaryDirectory, query: "beta\\d+" }), "Sin coincidencias.");
  assert.match(await runTool("search_text", { path: temporaryDirectory, query: "(", regex: true }), /expresión regular inválida/);
  assert.match(await runTool("search_text", { path: temporaryDirectory, query: "x", regex: "si" }), /'regex' debe ser booleano/);
});

test("edit_file replace_all changes every occurrence", async () => {
  const file = path.join(temporaryDirectory, "repeat.txt");
  fs.writeFileSync(file, "x x x");
  assert.equal(await runTool("edit_file", { path: file, old: "x", new: "y", replace_all: true }), `Editado: ${file} (3 reemplazos)`);
  assert.equal(fs.readFileSync(file, "utf8"), "y y y");
  assert.match(await runTool("edit_file", { path: file, old: "y", new: "z", replace_all: "si" }), /replace_all/);
});

test("move_file and delete_file work and /undo reverts them in reverse order", async () => {
  const file = path.join(temporaryDirectory, "undo.txt");
  const moved = path.join(temporaryDirectory, "moved", "undo.txt");
  await runTool("write_file", { path: file, content: "one" });
  await runTool("write_file", { path: file, content: "two" });
  assert.match(await runTool("move_file", { from: file, to: moved }), /^Movido:/);
  assert.match(await runTool("delete_file", { path: moved }), /^Eliminado:/);
  assert.equal(fs.existsSync(moved), false);

  assert.match(undoLastChange(), /restaurado/);
  assert.equal(fs.readFileSync(moved, "utf8"), "two");
  assert.match(undoLastChange(), /Movimiento deshecho/);
  assert.equal(fs.readFileSync(file, "utf8"), "two");
  assert.match(undoLastChange(), /restaurado/);
  assert.equal(fs.readFileSync(file, "utf8"), "one");
  assert.match(undoLastChange(), /creado eliminado/);
  assert.equal(fs.existsSync(file), false);
});

test("move_file and delete_file refuse unsafe targets", async () => {
  const a = path.join(temporaryDirectory, "a.txt");
  const b = path.join(temporaryDirectory, "b.txt");
  fs.writeFileSync(a, "a");
  fs.writeFileSync(b, "b");
  assert.match(await runTool("move_file", { from: a, to: b }), /ya existe/);
  assert.equal(fs.readFileSync(b, "utf8"), "b");
  assert.match(await runTool("delete_file", { path: temporaryDirectory }), /archivos regulares/);
  assert.match(await runTool("move_file", { from: a }), /obligatorios/);
});

test("fetch_url converts HTML to text and rejects non-http URLs", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    "<html><head><style>p{}</style></head><body><h1>Hola</h1><script>x()</script><p>Mundo &amp; más</p></body></html>",
    { headers: { "content-type": "text/html" } },
  );
  try {
    const result = await runTool("fetch_url", { url: "https://example.invalid/page" });
    assert.match(result, /Hola/);
    assert.match(result, /Mundo & más/);
    assert.doesNotMatch(result, /x\(\)|<h1>/);
    assert.match(await runTool("fetch_url", { url: "file:///etc/passwd" }), /solo se permiten/);
    assert.match(await runTool("fetch_url", { url: "no es una url" }), /no es válida/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("chat export renders Markdown with safe code fences and unique file names", () => {
  const messages: Msg[] = [
    { role: "user", content: "hola" },
    { role: "assistant", content: "ok", toolCalls: [{ id: "1", name: "read_file", args: { path: "a.txt" } }] },
    { role: "tool", content: "contenido con ``` dentro", toolCallId: "1", toolName: "read_file" },
  ];
  const markdown = chatToMarkdown("Mi chat", messages, new Date("2026-10-16T00:00:00Z"));
  assert.match(markdown, /^# Mi chat/);
  assert.match(markdown, /## Usuario\n\nhola/);
  assert.match(markdown, /````\ncontenido con ``` dentro\n````/);

  const first = exportChat("Mi chat", messages, temporaryDirectory);
  const second = exportChat("Mi chat", messages, temporaryDirectory);
  assert.equal(path.basename(first), "nebulacodex-mi-chat.md");
  assert.equal(path.basename(second), "nebulacodex-mi-chat-2.md");
  assert.throws(() => exportChat("x", messages, temporaryDirectory, "../escape"), /carpetas/);
  assert.throws(() => exportChat("x", [], temporaryDirectory), /No hay mensajes/);
});

test("runCommand reports exit codes and stops commands that exceed the time limit", async () => {
  assert.match(await runCommand("exit 3"), /terminó con código 3/);
  const sleepCommand = process.platform === "win32" ? "Start-Sleep -Seconds 30" : "sleep 30";
  const started = Date.now();
  assert.match(await runCommand(sleepCommand, undefined, 400), /superó el límite/);
  assert.ok(Date.now() - started < 5000, "el comando debió cortarse por tiempo");
});

test("runCommand can be cancelled while running", async () => {
  const sleepCommand = process.platform === "win32" ? "Start-Sleep -Seconds 30" : "sleep 30";
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 300);
  const started = Date.now();
  assert.match(await runCommand(sleepCommand, controller.signal), /fue cancelado/);
  assert.ok(Date.now() - started < 5000, "la cancelación debió ser inmediata");
});

test("runCommand does not wait for background processes that outlive the shell", {
  skip: process.platform === "win32",
}, async () => {
  const started = Date.now();
  const result = await runCommand("echo listo; sleep 30 &");
  assert.match(result, /listo/);
  assert.ok(Date.now() - started < 5000, "no debía esperar al proceso en segundo plano");
  // Se limpia el proceso que dejó el comando (el patrón con corchetes evita que coincida consigo mismo).
  await runCommand("pkill -f '[s]leep 30' || true");
});

test("runCommand strips ANSI colours from command output", {
  skip: process.platform === "win32",
}, async () => {
  assert.equal(await runCommand("printf '\\033[31mrojo\\033[0m\\n'"), "rojo\n");
});

test("loadConfig keeps valid providers, repairs bad fields and backs up unreadable files", () => {
  const file = path.join(temporaryDirectory, "config.json");
  assert.deepEqual(loadConfig(file), { active: "", providers: {} });

  fs.writeFileSync(file, JSON.stringify({
    active: "groq",
    effort: "turbo",
    providers: { groq: { apiKey: "k", model: 5 }, roto: "x" },
  }));
  assert.deepEqual(loadConfig(file), { active: "groq", providers: { groq: { apiKey: "k" } } });

  // Una config sin `active` (editada a mano o de una versión anterior) conserva sus proveedores.
  fs.writeFileSync(file, JSON.stringify({ providers: { groq: { apiKey: "sin-active" } } }));
  assert.deepEqual(loadConfig(file), { active: "", providers: { groq: { apiKey: "sin-active" } } });

  fs.writeFileSync(file, "{ esto no es json");
  assert.deepEqual(loadConfig(file), { active: "", providers: {} });
  assert.equal(fs.readFileSync(`${file}.invalid`, "utf8"), "{ esto no es json");

  saveConfig({ active: "groq", providers: { groq: { apiKey: "k2" } }, effort: "high" }, file);
  assert.deepEqual(loadConfig(file), { active: "groq", providers: { groq: { apiKey: "k2" } }, effort: "high" });
});

test("directory listing stops at its documented limit", async () => {
  const directory = path.join(temporaryDirectory, "many-files");
  fs.mkdirSync(directory);
  for (let index = 0; index < 501; index++) {
    fs.writeFileSync(path.join(directory, `file-${String(index).padStart(3, "0")}.txt`), "");
  }
  const listing = await runTool("list_dir", { path: directory });
  assert.match(listing, /se muestran los primeros 500 elementos/);
  assert.equal(listing.split("\n").length, 501);
});

test("history trimming removes complete old turns and drops a lone oversized turn", () => {
  const oldTurn: Msg[] = [
    { role: "user", content: "old request" },
    { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "read_file", args: { path: "old.txt" } }] },
    { role: "tool", content: "old result", toolCallId: "call-1", toolName: "read_file" },
  ];
  const recentTurn: Msg[] = [
    { role: "user", content: "recent request" },
    ...Array.from({ length: 78 }, (_, index): Msg => ({ role: "assistant", content: `reply ${index}` })),
  ];
  const trimmed = trimHistory([...oldTurn, ...recentTurn]);
  assert.equal(trimmed.length, 79);
  assert.equal(trimmed[0].content, "recent request");
  assert.ok(trimmed.every((message) => message.role !== "tool"));

  assert.deepEqual(trimHistory([{ role: "user", content: "x".repeat(100_000) }]), []);
});

test("Windows command tool executes PowerShell and reports failures", async (context) => {
  if (process.platform !== "win32") return context.skip("PowerShell launcher is Windows-specific");
  assert.match(await runTool("run_command", { command: "Write-Output 'Nebula smoke check'" }), /Nebula smoke check/);
  assert.match(await runTool("run_command", { command: "Write-Error 'expected smoke failure'" }), /^Error:/);
});

const provider: ResolvedProvider = {
  id: "custom",
  label: "Proveedor de prueba",
  kind: "openai",
  baseUrl: "https://example.invalid/v1",
  model: "test-model",
  needsKey: false,
  apiKey: "",
  hint: "test",
};

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { headers: { "content-type": "text/event-stream" } });
}

test("OpenAI-compatible stream parses fragmented multiline SSE and completion", async () => {
  const originalFetch = globalThis.fetch;
  const payload = [
    'data: {"choices":[{"delta":{"content":"Hola"},',
    'data: "finish_reason":"stop"}]}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  globalThis.fetch = async () => sseResponse([payload.slice(0, 19), payload.slice(19, 53), payload.slice(53)]);

  try {
    const events = [];
    for await (const event of streamChat(provider, "system", [], [], new AbortController().signal)) {
      events.push(event);
    }
    assert.deepEqual(events, [
      { type: "text", text: "Hola" },
      { type: "done", toolCalls: [] },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAI-compatible stream rejects a response that ends before completion", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => sseResponse(['data: {"choices":[{"delta":{"content":"parcial"}}]}\n\n']);

  try {
    await assert.rejects(async () => {
      for await (const _event of streamChat(provider, "system", [], [], new AbortController().signal)) {
        // Consume the partial output and assert that the stream still fails closed.
      }
    }, /cerró el flujo antes de completar/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("terminal renderer repaints after minimize and restore resize events", () => {
  class FakeTerminal extends EventEmitter {
    rows = 24;
    columns = 80;
    writes: string[] = [];
    write(chunk: unknown) {
      this.writes.push(String(chunk));
      return true;
    }
  }

  const terminal = new FakeTerminal();
  enableLineDiff(terminal as unknown as WriteStream);
  terminal.write("\u001B[2J\u001B[3J\u001B[Halpha\nbeta\n");
  terminal.write("\u001B[2K\u001B[1A\u001B[2K\u001B[Galpha\nbeta updated\n");
  assert.match(terminal.writes.at(-1) ?? "", /beta updated/);
  assert.doesNotMatch(terminal.writes.at(-1) ?? "", /\u001B\[2J/);

  terminal.rows = 1;
  terminal.columns = 1;
  terminal.emit("resize");
  terminal.write("\u001B[2K\u001B[1A\u001B[2K\u001B[Galpha\nlatest minimized frame\n");

  terminal.rows = 30;
  terminal.columns = 120;
  terminal.emit("resize");
  assert.match(terminal.writes.at(-1) ?? "", /latest minimized frame/);
  assert.match(terminal.writes.at(-1) ?? "", /\u001B\[2J/);

  terminal.write("\u001B[2K\u001B[1A\u001B[2K\u001B[Galpha\nrestored frame\n");
  assert.match(terminal.writes.at(-1) ?? "", /restored frame/);
  assert.match(terminal.writes.at(-1) ?? "", /\u001B\[2J/);
});
