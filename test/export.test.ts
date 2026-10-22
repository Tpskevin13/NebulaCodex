import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { chatToMarkdown, exportChat } from "../src/core/export.ts";
import type { Msg } from "../src/core/types.ts";

const messages: Msg[] = [{ role: "user", content: "hola" }];

test("chat headings stay on one line and code fences outgrow their content", () => {
  const markdown = chatToMarkdown("  Título\ncon   espacios  ", messages, new Date("2026-10-20T00:00:00Z"));
  assert.match(markdown, /^# Título con espacios/);
  assert.match(markdown, /_Exportado el 2026-10-20T00:00:00.000Z_/);
  assert.match(chatToMarkdown("", messages), /^# Chat/);

  const fenced = chatToMarkdown("x", [
    { role: "tool", content: "```\n````", toolCallId: "1", toolName: "read_file" },
  ]);
  assert.match(fenced, /`````\n```\n````\n`````/);
});

test("exportChat creates portable, unique and non-traversing file names", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nebulacodex-export-"));
  try {
    assert.equal(path.basename(exportChat("Añadir código", messages, directory)), "nebulacodex-anadir-codigo.md");
    assert.equal(path.basename(exportChat("Añadir código", messages, directory)), "nebulacodex-anadir-codigo-2.md");
    assert.equal(path.basename(exportChat("x", messages, directory, "report.md")), "report.md");
    assert.equal(path.basename(exportChat("x", messages, directory, "report.md")), "report-2.md");
    assert.equal(path.basename(exportChat("x", messages, directory, "CON")), "_CON.md");
    assert.equal(path.basename(exportChat("x", messages, directory, "bad:name?.md")), "bad-name-.md");
    assert.equal(path.basename(exportChat("x", messages, directory, "..")), "chat.md");
    assert.throws(() => exportChat("x", messages, directory, "sub/report"), /carpetas/);
    assert.throws(() => exportChat("x", [], directory), /No hay mensajes/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
