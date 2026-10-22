/**
 * Convierte el historial en filas de texto ya ajustadas al ancho de la terminal.
 * Así el historial se puede recorrer línea por línea y ningún mensaje queda recortado.
 * Es un módulo puro (sin Ink ni React) para poder probarlo aparte.
 */
import stringWidth from "string-width";
import { cleanText } from "../core/text.js";
import { parseMarkdown, type MarkdownSpan } from "./markdown.js";

export interface RowColors {
  text: string;
  dim: string;
  user: string;
  assistant: string;
  tool: string;
  ok: string;
  error: string;
  /** Color opcional para código inline y bloques. */
  code?: string;
  /** Color opcional para enlaces. */
  link?: string;
}

export type RowItem =
  | { kind: "user" | "assistant" | "info" | "error"; text: string }
  | { kind: "tool"; name: string; desc: string; result: string; ok: boolean };

export interface RowSpan {
  text: string;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  dimColor?: boolean;
}

export interface Row {
  prefix: string;
  prefixColor: string;
  /** Texto visible sin marcadores de Markdown. */
  text: string;
  color: string;
  bold: boolean;
  /** Fragmentos con estilo; `text` es la concatenación de todos ellos. */
  spans: RowSpan[];
}

/** Los resultados de herramientas pueden ser enormes: se muestran las primeras filas. */
const MAX_TOOL_RESULT_ROWS = 6;
const SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

type Style = Omit<MarkdownSpan, "text">;

/** Atajo para ASCII imprimible: string-width es correcto pero mucho más caro en cada carácter. */
function visualWidth(text: string): number {
  if (text.length === 1) {
    const code = text.charCodeAt(0);
    if (code >= 32 && code < 127) return 1;
  }
  return stringWidth(text);
}

function sameStyle(a: Style, b: Style): boolean {
  return (
    Boolean(a.bold) === Boolean(b.bold) &&
    Boolean(a.italic) === Boolean(b.italic) &&
    Boolean(a.code) === Boolean(b.code) &&
    Boolean(a.strikethrough) === Boolean(b.strikethrough) &&
    Boolean(a.underline) === Boolean(b.underline) &&
    Boolean(a.link) === Boolean(b.link) &&
    Boolean(a.dim) === Boolean(b.dim)
  );
}

function appendSpan(out: MarkdownSpan[], text: string, style: Style): void {
  if (!text) return;
  const last = out[out.length - 1];
  if (last && sameStyle(last, style)) {
    last.text += text;
    return;
  }
  out.push({ ...style, text });
}

/** Envuelve una línea de texto plano sin cortar grafemas ni desbordar el ancho visual. */
function wrapPlainLine(line: string, limit: number): string[] {
  const out: string[] = [];
  let current = line;
  while (visualWidth(current) > limit) {
    let used = 0;
    let end = 0;
    let lastSpace = -1;
    for (const part of SEGMENTER.segment(current)) {
      const partWidth = visualWidth(part.segment);
      if (used + partWidth > limit) break;
      used += partWidth;
      end = part.index + part.segment.length;
      if (part.segment === " ") lastSpace = part.index;
    }
    let cut = lastSpace > 0 ? lastSpace : end;
    if (cut <= 0) {
      // Un único grafema más ancho que el límite (por ejemplo, un emoji en una terminal mínima).
      const first = Array.from(SEGMENTER.segment(current))[0];
      cut = first ? first.segment.length : current.length;
    }
    out.push(current.slice(0, cut).trimEnd());
    current = current.slice(cut).trimStart();
  }
  out.push(current);
  return out;
}

export function wrapText(value: string, width: number): string[] {
  const limit = Math.max(1, width);
  const out: string[] = [];
  for (const source of cleanText(value).split("\n")) {
    out.push(...wrapPlainLine(source.trimEnd(), limit));
  }
  return out;
}

interface FlatGrapheme {
  text: string;
  style: Style;
}

function flattenSpans(spans: readonly MarkdownSpan[]): FlatGrapheme[] {
  const out: FlatGrapheme[] = [];
  for (const span of spans) {
    const { text, ...style } = span;
    for (const part of SEGMENTER.segment(text)) out.push({ text: part.segment, style });
  }
  return out;
}

function spansFromRange(
  flat: readonly FlatGrapheme[],
  start: number,
  end: number,
  preserveIndent: boolean,
): MarkdownSpan[] {
  let stop = end;
  if (!preserveIndent) {
    while (stop > start && flat[stop - 1].text === " ") stop--;
  }
  const out: MarkdownSpan[] = [];
  for (let index = start; index < stop; index++) {
    appendSpan(out, flat[index].text, flat[index].style);
  }
  return out;
}

/** Ajusta spans con estilo al ancho visual de la terminal, preservando el estilo al partir. */
export function wrapSpans(
  spans: readonly MarkdownSpan[],
  width: number,
  preserveIndent = false,
): MarkdownSpan[][] {
  const limit = Math.max(1, width);
  const flat = flattenSpans(spans);
  if (!flat.length) return [[]];

  const out: MarkdownSpan[][] = [];
  let start = 0;
  while (start < flat.length) {
    let used = 0;
    let end = start;
    let lastSpace = -1;
    while (end < flat.length) {
      const partWidth = visualWidth(flat[end].text);
      if (used + partWidth > limit) break;
      used += partWidth;
      if (flat[end].text === " ") lastSpace = end;
      end++;
    }

    if (end === flat.length) {
      out.push(spansFromRange(flat, start, end, preserveIndent));
      break;
    }

    let cut = lastSpace > start ? lastSpace : end > start ? end : start + 1;
    out.push(spansFromRange(flat, start, cut, preserveIndent));
    start = cut;
    if (!preserveIndent) {
      while (start < flat.length && flat[start].text === " ") start++;
    }
  }
  return out.length ? out : [[]];
}

function toRowSpan(span: MarkdownSpan, colors: RowColors): RowSpan {
  const color = span.code
    ? (colors.code ?? colors.dim)
    : span.link
      ? (colors.link ?? colors.assistant)
      : span.dim
        ? colors.dim
        : undefined;
  return {
    text: span.text,
    ...(color ? { color } : {}),
    ...(span.bold ? { bold: true } : {}),
    ...(span.italic ? { italic: true } : {}),
    ...(span.underline ? { underline: true } : {}),
    ...(span.strikethrough ? { strikethrough: true } : {}),
    ...(span.dim ? { dimColor: true } : {}),
  };
}

function truncateToWidth(value: string, width: number): string {
  if (visualWidth(value) <= width) return value;
  if (width <= 1) return "…";
  let out = "";
  let used = 0;
  for (const part of SEGMENTER.segment(value)) {
    const partWidth = visualWidth(part.segment);
    if (used + partWidth > width - 1) break;
    out += part.segment;
    used += partWidth;
  }
  return `${out}…`;
}

function plainRows(
  text: string,
  width: number,
  firstPrefix: string,
  prefixColor: string,
  color: string,
  bold: boolean,
): Row[] {
  const limit = Math.max(1, width - visualWidth(firstPrefix));
  return wrapText(text, limit).map((line, index) => {
    const visible = line || " ";
    return {
      prefix: index === 0 ? firstPrefix : " ".repeat(visualWidth(firstPrefix)),
      prefixColor,
      text: visible,
      color,
      bold,
      spans: [{ text: visible }],
    };
  });
}

function markdownRows(
  text: string,
  width: number,
  firstPrefix: string,
  prefixColor: string,
  color: string,
  colors: RowColors,
): Row[] {
  const limit = Math.max(1, width - visualWidth(firstPrefix));
  const rows: Row[] = [];
  for (const line of parseMarkdown(text)) {
    for (const styled of wrapSpans(line.spans, limit, line.preserveIndent)) {
      const spans = styled.map((span) => toRowSpan(span, colors));
      const visible = spans.map((span) => span.text).join("") || " ";
      rows.push({
        prefix: rows.length === 0 ? firstPrefix : " ".repeat(visualWidth(firstPrefix)),
        prefixColor,
        text: visible,
        color,
        bold: false,
        spans: spans.length ? spans : [{ text: " " }],
      });
    }
  }
  return rows.length
    ? rows
    : [
        {
          prefix: firstPrefix,
          prefixColor,
          text: " ",
          color,
          bold: false,
          spans: [{ text: " " }],
        },
      ];
}

export function buildRows(items: RowItem[], width: number, colors: RowColors): Row[] {
  const rows: Row[] = [];
  for (const item of items) {
    if (rows.length) {
      rows.push({
        prefix: "",
        prefixColor: colors.dim,
        text: " ",
        color: colors.dim,
        bold: false,
        spans: [{ text: " " }],
      });
    }
    switch (item.kind) {
      case "user":
        rows.push(...plainRows(item.text, width, "❯ ", colors.user, colors.text, true));
        break;
      case "assistant":
        rows.push(...markdownRows(item.text, width, "✦ ", colors.assistant, colors.text, colors));
        break;
      case "info":
        rows.push(...plainRows(item.text, width, "  ", colors.dim, colors.dim, false));
        break;
      case "error":
        rows.push(...plainRows(item.text, width, "✗ ", colors.error, colors.error, false));
        break;
      case "tool": {
        const header = truncateToWidth(
          cleanText(`${item.name}${item.desc ? ` ${item.desc}` : ""}`).replace(/\s+/g, " "),
          Math.max(1, width - 2),
        );
        const visible = header || " ";
        rows.push({
          prefix: item.ok ? "● " : "✗ ",
          prefixColor: item.ok ? colors.ok : colors.error,
          text: visible,
          color: colors.tool,
          bold: true,
          spans: [{ text: visible }],
        });
        if (item.result.trim()) {
          const lines = wrapText(item.result, width - 4);
          rows.push(
            ...lines.slice(0, MAX_TOOL_RESULT_ROWS).map((line): Row => {
              const text = line || " ";
              return {
                prefix: "  ",
                prefixColor: colors.dim,
                text,
                color: colors.dim,
                bold: false,
                spans: [{ text }],
              };
            }),
          );
          if (lines.length > MAX_TOOL_RESULT_ROWS) {
            const text = `… (${lines.length - MAX_TOOL_RESULT_ROWS} líneas más)`;
            rows.push({
              prefix: "  ",
              prefixColor: colors.dim,
              text,
              color: colors.dim,
              bold: false,
              spans: [{ text }],
            });
          }
        }
        break;
      }
    }
  }
  return rows;
}

/** Ventana de `height` filas; `scroll` cuenta filas hacia arriba desde el final y se ajusta al rango válido. */
export function sliceRows(rows: Row[], height: number, scroll: number) {
  const size = Math.max(1, height);
  const maxScroll = Math.max(0, rows.length - size);
  const clamped = Math.min(Math.max(0, scroll), maxScroll);
  const end = rows.length - clamped;
  return { visible: rows.slice(Math.max(0, end - size), end), scroll: clamped, maxScroll };
}
