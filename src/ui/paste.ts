import { cleanText } from "../core/text.js";

/**
 * Manejo del pegado en el campo de texto del chat.
 * - Un pegado de varias líneas (o muy largo) se reemplaza por un marcador corto y se expande al enviar.
 * - Si la terminal manda cada Enter del pegado como una tecla aparte, se toma como salto de línea, no como envío.
 */
export const NEWLINE_MARK = "⏎";
/** Un Enter que llega tan pegado al texto anterior no lo pulsó una persona. */
export const PASTE_BURST_MS = 25;
const LONG_PASTE_CHARS = 80;
const PLACEHOLDER = /\[pegado #(\d+) · [^\]]*\]/g;

export interface PasteStore {
  next: number;
  texts: Map<number, string>;
}

export function createPasteStore(): PasteStore {
  return { next: 0, texts: new Map() };
}

/** Zona que cambió entre dos valores (prefijo y sufijo comunes). */
function changedRange(previous: string, next: string) {
  const limit = Math.min(previous.length, next.length);
  let start = 0;
  while (start < limit && previous[start] === next[start]) start++;
  let previousEnd = previous.length;
  let nextEnd = next.length;
  while (previousEnd > start && nextEnd > start && previous[previousEnd - 1] === next[nextEnd - 1]) {
    previousEnd--;
    nextEnd--;
  }
  return { start, previousEnd, nextEnd };
}

/** Recibe el valor anterior y el nuevo del campo, y devuelve el valor limpio con los pegados compactados. */
export function normalizeInput(previous: string, next: string, store: PasteStore): string {
  if (previous === next) return next;
  const { start, previousEnd, nextEnd } = changedRange(previous, next);
  const inserted = next.slice(start, nextEnd);

  if (!inserted) {
    // Borrado: si toca un marcador de pegado, se quita completo en vez de dejarlo a medias.
    for (const match of previous.matchAll(PLACEHOLDER)) {
      const from = match.index ?? 0;
      const to = from + match[0].length;
      if (start < to && previousEnd > from) {
        store.texts.delete(Number(match[1]));
        return previous.slice(0, from) + previous.slice(to);
      }
    }
    return next;
  }

  const cleaned = cleanText(inserted);
  const head = next.slice(0, start);
  const tail = next.slice(nextEnd);
  const trimmed = cleaned.replace(/^\n+|\n+$/g, "");
  const isPaste = cleaned.includes("\n") || cleaned.length > LONG_PASTE_CHARS;
  if (!isPaste) return head + cleaned + tail;
  // Una línea corta pegada con su salto de línea final sigue siendo texto normal.
  if (!trimmed.includes("\n") && trimmed.length <= LONG_PASTE_CHARS) return head + trimmed + tail;

  const id = ++store.next;
  store.texts.set(id, trimmed);
  const lines = trimmed.split("\n").length;
  const label = lines > 1 ? `${lines} líneas` : `${trimmed.length} caracteres`;
  return `${head}[pegado #${id} · ${label}]${tail}`;
}

/** Devuelve el texto real: marcadores de pegado y marcas de salto de línea vuelven a ser el contenido original. */
export function expandInput(value: string, store: PasteStore): string {
  return value
    .replace(PLACEHOLDER, (whole, id: string) => store.texts.get(Number(id)) ?? whole)
    .split(NEWLINE_MARK)
    .join("\n");
}
