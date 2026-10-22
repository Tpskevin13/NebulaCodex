import assert from "node:assert/strict";
import { test } from "node:test";
import stringWidth from "string-width";
import { parseMarkdown, type MarkdownSpan } from "../src/ui/markdown.ts";
import { buildRows, wrapSpans, type RowColors } from "../src/ui/rows.ts";

const colors: RowColors = {
  text: "t",
  dim: "d",
  user: "u",
  assistant: "a",
  tool: "o",
  ok: "k",
  error: "e",
  code: "c",
  link: "l",
};

function plain(spans: readonly MarkdownSpan[]): string {
  return spans.map((span) => span.text).join("");
}

function allSpans(text: string): MarkdownSpan[] {
  return parseMarkdown(text).flatMap((line) => line.spans);
}

function find(spans: readonly MarkdownSpan[], text: string): MarkdownSpan {
  const span = spans.find((candidate) => candidate.text === text);
  assert.ok(span, `falta el span ${JSON.stringify(text)} en ${JSON.stringify(spans)}`);
  return span;
}

test("inline Markdown becomes styled spans without visible markers", () => {
  const spans = allSpans("**negrita** y *cursiva* y ***ambas*** y `code *x*` y ~~tachado~~");
  assert.equal(plain(spans), "negrita y cursiva y ambas y code *x* y tachado");
  assert.equal(find(spans, "negrita").bold, true);
  assert.equal(find(spans, "cursiva").italic, true);
  assert.equal(find(spans, "ambas").bold, true);
  assert.equal(find(spans, "ambas").italic, true);
  assert.equal(find(spans, "code *x*").code, true);
  assert.equal(find(spans, "code *x*").italic, undefined);
  assert.equal(find(spans, "tachado").strikethrough, true);
});

test("literal asterisks and underscores are not turned into emphasis", () => {
  const spans = allSpans("\\*literal\\* y 2 * 3 * 4 y snake_case_name");
  assert.equal(plain(spans), "*literal* y 2 * 3 * 4 y snake_case_name");
  assert.ok(spans.every((span) => !span.bold && !span.italic));
});

test("block Markdown renders headings, lists, fences, quotes and links", () => {
  const markdown = [
    "# Título",
    "",
    "- uno **dos**",
    "- tres",
    "",
    "```js",
    "const x = 1 * 2;",
    "  if (x) {",
    "    return x;",
    "  }",
    "```",
    "",
    "> cita",
    "",
    "[enlace](https://example.test)",
  ].join("\n");
  const lines = parseMarkdown(markdown);
  const text = lines.map((line) => plain(line.spans)).join("\n");
  assert.ok(text.includes("Título"));
  assert.ok(text.includes("• uno dos"));
  assert.ok(text.includes("• tres"));
  assert.ok(text.includes("const x = 1 * 2;"));
  assert.ok(text.includes("  if (x) {"));
  assert.ok(text.includes("    return x;"));
  assert.ok(text.includes("│ cita"));
  assert.ok(text.includes("enlace"));
  assert.ok(!text.includes("**"));
  assert.ok(!text.includes("```"));
  assert.ok(!text.includes("# Título"));

  const heading = lines.find((line) => plain(line.spans) === "Título")!;
  assert.equal(heading.spans[0].bold, true);
  const bullet = lines.find((line) => plain(line.spans) === "• uno dos")!;
  assert.equal(bullet.spans[0].dim, true);
  assert.equal(find(bullet.spans, "dos").bold, true);
  const code = lines.find((line) => plain(line.spans) === "const x = 1 * 2;")!;
  assert.equal(code.spans[0].code, true);
  assert.equal(code.preserveIndent, true);
  const quote = lines.find((line) => plain(line.spans) === "│ cita")!;
  assert.equal(quote.spans[1].dim, true);
  assert.equal(quote.spans[1].italic, true);
  const link = lines.find((line) => plain(line.spans) === "enlace")!;
  assert.equal(link.spans[0].underline, true);
  assert.equal(link.spans[0].link, true);
});

test("fenced code keeps Markdown markers literal", () => {
  const lines = parseMarkdown("```\n**no es negrita**\n```");
  assert.equal(plain(lines[0].spans), "**no es negrita**");
  assert.equal(lines[0].spans[0].code, true);
  assert.equal(lines[0].spans[0].bold, undefined);
});

test("assistant rows carry bold styling and wrap without breaking the emphasis", () => {
  const rows = buildRows([{ kind: "assistant", text: "**una frase bastante larga** y *cursiva*" }], 16, colors);
  assert.ok(rows.length > 1);
  assert.ok(rows.every((row) => !row.text.includes("*")));
  assert.ok(rows.every((row) => stringWidth(row.text) <= 14));
  assert.ok(rows.flatMap((row) => row.spans).some((span) => span.bold));
  assert.ok(rows.flatMap((row) => row.spans).some((span) => span.italic));
});

test("wrapSpans preserves styles and does not split grapheme clusters", () => {
  const spans = [{ text: "**", bold: true }, { text: "abcdefghij", bold: true }, { text: "**", bold: true }];
  const wrapped = wrapSpans(spans, 4);
  assert.equal(wrapped.flat().map((span) => span.text).join(""), "**abcdefghij**");
  assert.ok(wrapped.flat().every((span) => span.bold));

  const emoji = buildRows([{ kind: "assistant", text: "😀".repeat(20) }], 10, colors);
  assert.ok(emoji.every((row) => stringWidth(row.text) <= 8));
  assert.equal(emoji.map((row) => row.text).join(""), "😀".repeat(20));
});

test("malformed Markdown degrades to visible text instead of throwing", () => {
  const lines = parseMarkdown("**sin cerrar y [enlace incompleto");
  assert.equal(plain(lines[0].spans), "**sin cerrar y [enlace incompleto");
});
