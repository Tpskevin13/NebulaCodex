import type { Msg } from "./types.js";

export const MAX_HISTORY_MESSAGES = 80;
export const MAX_HISTORY_CHARS = 96_000;

function messageSize(message: Msg): number {
  return message.content.length + (message.toolCalls ? JSON.stringify(message.toolCalls).length : 0) + 64;
}

/**
 * Drop complete old user turns so tool-call/result pairs remain valid and context stays bounded.
 * Se calculan los totales una sola vez y se descuentan las conversaciones que salen: antes se
 * recorría todo el historial después de cada `shift`, que es O(n²) en un chat largo.
 */
export function trimHistory(
  messages: readonly Msg[],
  maxMessages: number = MAX_HISTORY_MESSAGES,
  maxChars: number = MAX_HISTORY_CHARS,
): Msg[] {
  const turns: Msg[][] = [];
  for (const message of messages) {
    if (message.role === "user" || turns.length === 0) turns.push([]);
    turns[turns.length - 1].push(message);
  }

  let count = 0;
  let chars = 0;
  for (const turn of turns) {
    count += turn.length;
    for (const message of turn) chars += messageSize(message);
  }

  let first = 0;
  while (first < turns.length && (count > maxMessages || chars > maxChars)) {
    count -= turns[first].length;
    for (const message of turns[first]) chars -= messageSize(message);
    first++;
  }
  return turns.slice(first).flat();
}
