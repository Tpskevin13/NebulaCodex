/**
 * Convierte Markdown (GFM) en líneas de spans con estilos que Ink puede dibujar.
 *
 * El historial guarda el Markdown original; este módulo es solo para la vista de terminal.
 * No se interpreta HTML ni se ejecuta nada: los marcadores se convierten en atributos de estilo
 * (negrita, cursiva, código, etc.) y el texto visible queda limpio.
 */
import { marked, type Token, type Tokens } from "marked";
import stringWidth from "string-width";
import { cleanText } from "../core/text.js";

export interface MarkdownSpan {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  strikethrough?: boolean;
  underline?: boolean;
  link?: boolean;
  dim?: boolean;
}

export interface MarkdownLine {
  spans: MarkdownSpan[];
  /** Las líneas de bloques de código conservan su indentación al envolverlas. */
  preserveIndent?: boolean;
}

type Style = Omit<MarkdownSpan, "text">;

const STYLE_KEYS = ["bold", "italic", "code", "strikethrough", "underline", "link", "dim"] as const;

function sameStyle(a: Style, b: Style): boolean {
  return STYLE_KEYS.every((key) => Boolean(a[key]) === Boolean(b[key]));
}

/** Agrega texto y fusiona spans consecutivos con el mismo estilo. */
function appendSpan(out: MarkdownSpan[], text: string, style: Style): void {
  if (!text) return;
  const last = out[out.length - 1];
  if (last && sameStyle(last, style)) {
    last.text += text;
    return;
  }
  out.push({ ...style, text });
}

function appendSpans(out: MarkdownSpan[], spans: readonly MarkdownSpan[]): void {
  for (const span of spans) appendSpan(out, span.text, span);
}

function inlineSpans(tokens: readonly Token[], base: Style = {}): MarkdownSpan[] {
  const out: MarkdownSpan[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case "strong":
        appendSpans(out, inlineSpans(token.tokens ?? [], { ...base, bold: true }));
        break;
      case "em":
        appendSpans(out, inlineSpans(token.tokens ?? [], { ...base, italic: true }));
        break;
      case "del":
        appendSpans(out, inlineSpans(token.tokens ?? [], { ...base, strikethrough: true }));
        break;
      case "codespan":
        appendSpan(out, token.text, { ...base, code: true });
        break;
      case "text":
        if (token.tokens?.length) appendSpans(out, inlineSpans(token.tokens, base));
        else appendSpan(out, token.text, base);
        break;
      case "escape":
        appendSpan(out, token.text, base);
        break;
      case "link":
        appendSpans(out, inlineSpans(token.tokens ?? [], { ...base, underline: true, link: true }));
        break;
      case "image": {
        const label = token.text?.trim() || token.href;
        appendSpan(out, label, { ...base, underline: true });
        break;
      }
      case "br":
        appendSpan(out, "\n", base);
        break;
      case "html":
        // El HTML se muestra como texto, nunca se interpreta. Un <br> sí representa un salto.
        if (/^<br\s*\/?>$/i.test(token.text.trim())) appendSpan(out, "\n", base);
        break;
      case "checkbox": {
        const checked = (token as Tokens.Generic).checked === true;
        appendSpan(out, checked ? "☑ " : "☐ ", { ...base, dim: true });
        break;
      }
      default: {
        const generic = token as Tokens.Generic;
        if (Array.isArray(generic.tokens) && generic.tokens.length) {
          appendSpans(out, inlineSpans(generic.tokens, base));
        } else if (typeof generic.text === "string") {
          appendSpan(out, generic.text, base);
        } else if (typeof token.raw === "string") {
          appendSpan(out, token.raw, base);
        }
      }
    }
  }
  return out;
}

/** Divide los spans en líneas lógicas, conservando el estilo de cada fragmento. */
function splitLines(spans: readonly MarkdownSpan[]): MarkdownLine[] {
  const lines: MarkdownSpan[][] = [[]];
  for (const span of spans) {
    const parts = span.text.split("\n");
    parts.forEach((part, index) => {
      if (part) appendSpan(lines[lines.length - 1], part, span);
      if (index < parts.length - 1) lines.push([]);
    });
  }
  return lines.map((line) => ({ spans: line }));
}

function inlineLines(tokens: readonly Token[], base: Style = {}): MarkdownLine[] {
  return splitLines(inlineSpans(tokens, base));
}

function plainLines(text: string): MarkdownLine[] {
  return text.split("\n").map((line) => ({ spans: line ? [{ text: line }] : [] }));
}

function appendBlank(out: MarkdownLine[]): void {
  if (!out.length) return;
  const last = out[out.length - 1];
  if (last.spans.some((span) => span.text.trim() !== "")) out.push({ spans: [] });
}

function listLines(list: Tokens.List, base: Style): MarkdownLine[] {
  const out: MarkdownLine[] = [];
  let number = typeof list.start === "number" ? list.start : 1;
  for (const item of list.items) {
    // En las listas de tareas el checkbox reemplaza a la viñeta; no hace falta mostrar ambos.
    const bullet = list.ordered ? `${number++}. ` : item.task ? "" : "• ";
    const marker = `${bullet}${item.task ? (item.checked ? "☑ " : "☐ ") : ""}`;
    const content = blockLines(item.tokens, base);
    if (!content.length) content.push({ spans: [] });
    const markerWidth = stringWidth(marker);
    content.forEach((line, index) => {
      line.spans.unshift({
        text: index === 0 ? marker : " ".repeat(markerWidth),
        dim: true,
      });
    });
    out.push(...content);
    if (list.loose && item !== list.items[list.items.length - 1]) out.push({ spans: [] });
  }
  return out;
}

function tableLines(table: Tokens.Table): MarkdownLine[] {
  const out: MarkdownLine[] = [];
  const row = (cells: Tokens.TableCell[], header: boolean): void => {
    const spans: MarkdownSpan[] = [];
    cells.forEach((cell, index) => {
      if (index > 0) appendSpan(spans, " │ ", { dim: true });
      appendSpans(spans, inlineSpans(cell.tokens, header ? { bold: true } : {}));
    });
    out.push({ spans });
  };
  if (table.header.length) row(table.header, true);
  for (const cells of table.rows) row(cells, false);
  return out;
}

function blockLines(tokens: readonly Token[], base: Style = {}): MarkdownLine[] {
  const out: MarkdownLine[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case "space":
        appendBlank(out);
        break;
      case "paragraph":
        out.push(...inlineLines(token.tokens ?? [], base));
        break;
      case "heading":
        out.push(
          ...inlineLines(token.tokens ?? [], {
            ...base,
            bold: true,
            ...(token.depth === 1 ? { underline: true } : {}),
          }),
        );
        break;
      case "code": {
        const code = token.text.replace(/\n$/, "");
        const lines = code.split("\n");
        for (const line of lines) {
          out.push({
            spans: line ? [{ text: line, code: true }] : [],
            preserveIndent: true,
          });
        }
        break;
      }
      case "blockquote": {
        const inner = blockLines(token.tokens ?? [], { ...base, dim: true, italic: true });
        for (const line of inner) {
          line.spans = [
            { text: "│ ", dim: true },
            ...line.spans.map((span) => ({ ...span, dim: true, italic: span.italic ?? true })),
          ];
        }
        out.push(...inner);
        break;
      }
      case "list":
        out.push(...listLines(token as Tokens.List, base));
        break;
      case "table":
        out.push(...tableLines(token as Tokens.Table));
        break;
      case "hr":
        out.push({ spans: [{ text: "─".repeat(32), dim: true }] });
        break;
      case "html": {
        const html = token.text.replace(/\n$/, "");
        for (const line of html.split("\n")) out.push({ spans: line ? [{ text: line }] : [] });
        break;
      }
      case "text":
        if (token.tokens?.length) out.push(...inlineLines(token.tokens, base));
        else out.push(...plainLines(token.text));
        break;
      case "def":
        break;
      default: {
        const generic = token as Tokens.Generic;
        if (Array.isArray(generic.tokens) && generic.tokens.length) {
          out.push(...inlineLines(generic.tokens, base));
        } else if (typeof generic.text === "string") {
          out.push(...plainLines(generic.text));
        } else if (typeof token.raw === "string") {
          out.push(...plainLines(token.raw));
        }
      }
    }
  }
  return out;
}

/**
 * Convierte el Markdown de un mensaje en líneas de spans.
 * Ante cualquier fallo del parser se degrada a texto plano, sin romper el render.
 */
export function parseMarkdown(text: string): MarkdownLine[] {
  const source = cleanText(text);
  if (!source.trim()) return [{ spans: [] }];
  try {
    const tokens = marked.lexer(source, { gfm: true, breaks: false, async: false });
    const lines = blockLines(tokens);
    while (lines.length > 1 && lines[lines.length - 1].spans.length === 0) lines.pop();
    return lines.length ? lines : [{ spans: [] }];
  } catch {
    return plainLines(source);
  }
}
