import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRows, sliceRows, wrapText, type RowColors, type RowItem } from "../src/ui/rows.ts";

const colors: RowColors = { text: "t", dim: "d", user: "u", assistant: "a", tool: "o", ok: "k", error: "e" };

test("wrapText keeps every character, wraps on spaces and splits long words", () => {
  const long = "palabra ".repeat(30).trim();
  const lines = wrapText(long, 20);
  assert.ok(lines.every((line) => line.length <= 20));
  assert.equal(lines.join(" "), long);
  assert.deepEqual(wrapText("a".repeat(25), 10), ["a".repeat(10), "a".repeat(10), "a".repeat(5)]);
  assert.deepEqual(wrapText("uno\n\ndos", 20), ["uno", "", "dos"]);
});

test("buildRows no longer truncates long assistant messages and separates items", () => {
  const text = Array.from({ length: 40 }, (_, i) => `linea ${i}`).join("\n");
  const items: RowItem[] = [
    { kind: "user", text: "hola" },
    { kind: "assistant", text },
    { kind: "error", text: "algo falló" },
  ];
  const rows = buildRows(items, 60, colors);
  assert.equal(rows.filter((row) => row.text.startsWith("linea ")).length, 40);
  assert.equal(rows[0].prefix, "❯ ");
  assert.equal(rows[1].text, " ");
  assert.ok(rows.every((row) => row.text.length > 0));
  assert.equal(rows.at(-1)?.prefix, "✗ ");
});

test("buildRows summarises long tool results", () => {
  const result = Array.from({ length: 20 }, (_, i) => `salida ${i}`).join("\n");
  const rows = buildRows([{ kind: "tool", name: "read_file", desc: "a.txt", result, ok: true }], 60, colors);
  assert.equal(rows[0].text, "read_file a.txt");
  assert.equal(rows[0].prefix, "● ");
  assert.equal(rows.length, 1 + 6 + 1);
  assert.match(rows.at(-1)!.text, /14 líneas más/);
});

test("rows never carry terminal control sequences", () => {
  const rows = buildRows(
    [
      { kind: "assistant", text: "\u001b[31mrojo\u001b[0m\r\nsegunda\u0007" },
      { kind: "tool", name: "run_command", desc: "npm\ti", result: "\u001b[32mok\u001b[0m\n", ok: true },
    ],
    60,
    colors,
  );
  const all = rows.map((row) => row.prefix + row.text).join("\n");
  assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f]/.test(all), "no debe haber caracteres de control");
  assert.ok(all.includes("rojo") && all.includes("segunda") && all.includes("ok"));
});

test("sliceRows clamps scrolling to the valid range", () => {
  const rows = buildRows(Array.from({ length: 10 }, (_, i): RowItem => ({ kind: "info", text: `m${i}` })), 40, colors);
  assert.equal(rows.length, 19);
  const bottom = sliceRows(rows, 5, 0);
  assert.equal(bottom.visible.length, 5);
  assert.equal(bottom.visible.at(-1)?.text, "m9");
  const top = sliceRows(rows, 5, 9999);
  assert.equal(top.scroll, top.maxScroll);
  assert.equal(top.visible[0].text, "m0");
  assert.equal(sliceRows(rows, 100, 5).maxScroll, 0);
  assert.equal(sliceRows([], 5, 3).visible.length, 0);
});
