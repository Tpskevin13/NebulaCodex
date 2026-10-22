import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanLine, cleanOutput, cleanText, cleanToken } from "../src/core/text.ts";
import { createPasteStore, expandInput, normalizeInput, NEWLINE_MARK } from "../src/ui/paste.ts";

test("cleanText strips terminal escapes and normalises line breaks", () => {
  assert.equal(cleanText("\u001b[31mrojo\u001b[0m"), "rojo");
  assert.equal(cleanText("\u001b[38:2::255:0:0mrojo\u001b[0m"), "rojo");
  assert.equal(cleanText("[200~hola[201~"), "hola");
  assert.equal(cleanText("\u001b[200~hola\u001b[201~"), "hola");
  assert.equal(cleanText("a\r\nb\rc\nd"), "a\nb\nc\nd");
  assert.equal(cleanText("a\u0007b\u0000c"), "abc");
  assert.equal(cleanText("\tx"), "  x");
  assert.equal(cleanText("acentos: ñ á ü ✦"), "acentos: ñ á ü ✦");
});

test("cleanOutput keeps the last state of progress lines and strips colours", () => {
  assert.equal(cleanOutput("10%\r50%\r100%\nlisto\n"), "100%\nlisto\n");
  assert.equal(cleanOutput("a\r\nb\r\n"), "a\nb\n");
  assert.equal(cleanOutput("texto\r"), "texto");
  assert.equal(cleanOutput("\u001b[32mok\u001b[0m\n"), "ok\n");
});

test("cleanLine and cleanToken give single-line values", () => {
  assert.equal(cleanLine("C:\\mi carpeta\r\n"), "C:\\mi carpeta ");
  assert.equal(cleanToken("[200~sk-abc\r\n123 [201~\n"), "sk-abc123");
});

test("typing is left untouched, character by character", () => {
  const store = createPasteStore();
  let value = "";
  for (const ch of "hola mundo, ¿qué tal?") value = normalizeInput(value, value + ch, store);
  assert.equal(value, "hola mundo, ¿qué tal?");
  assert.equal(store.texts.size, 0);
});

test("a multi-line paste becomes a short marker and expands on submit", () => {
  const store = createPasteStore();
  const pasted = "PS C:\\> npm run build\r\nerror TS2304: algo\r\n  at linea 3\r\n";
  const value = normalizeInput("revisa esto: ", `revisa esto: ${pasted}`, store);
  assert.equal(value, "revisa esto: [pegado #1 · 3 líneas]");
  assert.equal(expandInput(value, store), "revisa esto: PS C:\\> npm run build\nerror TS2304: algo\n  at linea 3");
});

test("long single-line pastes are compacted but short ones stay inline", () => {
  const store = createPasteStore();
  const long = "x".repeat(300);
  assert.equal(normalizeInput("", long, store), "[pegado #1 · 300 caracteres]");
  assert.equal(expandInput("[pegado #1 · 300 caracteres]", store), long);
  const store2 = createPasteStore();
  assert.equal(normalizeInput("ver ", "ver C:\\Users\\usuario\\Project\r\n", store2), "ver C:\\Users\\usuario\\Project");
  assert.equal(store2.texts.size, 0);
});

test("bracketed-paste markers never reach the text", () => {
  const store = createPasteStore();
  assert.equal(normalizeInput("a", "a[200~hola[201~", store), "ahola");
});

test("pasting in the middle keeps the surrounding text", () => {
  const store = createPasteStore();
  const value = normalizeInput("ab cd", "ab1\n2\n3 cd", store);
  assert.match(value, /^ab\[pegado #1 · 3 líneas\] cd$/);
  assert.equal(expandInput(value, store), "ab1\n2\n3 cd");
});

test("backspace on a paste marker removes the whole marker", () => {
  const store = createPasteStore();
  const value = normalizeInput("hola ", "hola a\nb", store);
  assert.equal(value, "hola [pegado #1 · 2 líneas]");
  const afterBackspace = normalizeInput(value, value.slice(0, -1), store);
  assert.equal(afterBackspace, "hola ");
  assert.equal(store.texts.size, 0);
  assert.equal(normalizeInput("abc", "ab", store), "ab");
});

test("expandInput turns newline marks into real line breaks and ignores unknown markers", () => {
  const store = createPasteStore();
  assert.equal(expandInput(`uno${NEWLINE_MARK}dos${NEWLINE_MARK}tres`, store), "uno\ndos\ntres");
  assert.equal(expandInput("[pegado #9 · 2 líneas]", store), "[pegado #9 · 2 líneas]");
});
