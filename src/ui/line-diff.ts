import type { WriteStream } from "node:tty";

const CLEAR_TERMINAL = "\u001B[2J\u001B[3J\u001B[H";
const CLEAR_VIEW = "\u001B[2J\u001B[H";
const ERASE_MARKER = "\u001B[G";
const ERASE_PREFIX = /^(?:\u001B\[2K\u001B\[1A)*(?:\u001B\[2K)?$/;

/** Paint only changed rows from Ink's full-frame updates to prevent visible flashing. */
export function enableLineDiff(stream: WriteStream) {
  const writeOriginal = stream.write.bind(stream) as (...args: any[]) => boolean;
  let lastFrame: string[] | null = null;
  let needsFullPaint = false;

  const paintFullFrame = (rows: string[], ...args: any[]) => {
    const terminalRows = Number.isFinite(stream.rows) ? stream.rows : 0;
    const terminalColumns = Number.isFinite(stream.columns) ? stream.columns : 0;
    if (terminalRows <= 1 || terminalColumns <= 1) return writeOriginal("", ...args);

    const visibleRows = Math.min(rows.length, terminalRows - 1);
    let repaint = `${CLEAR_VIEW}\u001B[?7l`;
    for (let row = 0; row < visibleRows; row++) {
      repaint += `\u001B[${row + 1};1H${rows[row]}\u001B[0m\u001B[K`;
    }
    repaint += "\u001B[?7h";
    return writeOriginal(repaint, ...args);
  };

  stream.on("resize", () => {
    // Restore the last known screen immediately, then force the next Ink frame
    // to replace it using the new layout. Ignore transient minimized dimensions.
    needsFullPaint = true;
    if (lastFrame) paintFullFrame(lastFrame);
  });

  const patchedWrite = ((chunk: any, ...args: any[]) => {
    if (typeof chunk !== "string") return writeOriginal(chunk, ...args);

    let frame: string | null = null;
    let clearsTerminal = false;
    if (chunk.startsWith(CLEAR_TERMINAL)) {
      clearsTerminal = true;
      frame = chunk.slice(CLEAR_TERMINAL.length);
    } else {
      const markerAt = chunk.indexOf(ERASE_MARKER);
      if (markerAt >= 0 && ERASE_PREFIX.test(chunk.slice(0, markerAt))) {
        frame = chunk.slice(markerAt + ERASE_MARKER.length);
      }
    }

    if (frame === null) return writeOriginal(chunk, ...args);

    const rows = frame.split("\n");
    if (rows.at(-1) === "") rows.pop();

    if (
      !Number.isFinite(stream.rows) ||
      !Number.isFinite(stream.columns) ||
      stream.rows <= 1 ||
      stream.columns <= 1
    ) {
      lastFrame = rows;
      needsFullPaint = true;
      return writeOriginal("", ...args);
    }

    if (lastFrame === null || needsFullPaint || clearsTerminal) {
      lastFrame = rows;
      needsFullPaint = false;
      return paintFullFrame(rows, ...args);
    }

    let paint = "\u001B[?7l";
    const rowCount = Math.min(Math.max(lastFrame.length, rows.length), stream.rows - 1);
    for (let row = 0; row < rowCount; row++) {
      const next = rows[row] ?? "";
      if (next === lastFrame[row]) continue;
      paint += `\u001B[${row + 1};1H${next}\u001B[0m\u001B[K`;
    }

    lastFrame = rows;
    if (paint === "\u001B[?7l") return writeOriginal("", ...args);
    paint += "\u001B[?7h";
    return writeOriginal(paint, ...args);
  }) as typeof stream.write;

  stream.write = patchedWrite;
}
