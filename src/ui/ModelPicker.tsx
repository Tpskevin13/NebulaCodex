import { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { C } from "./theme.js";

/** Lista de modelos con buscador: escribís para filtrar, ↑↓ para elegir, Enter para confirmar. */
export function ModelPicker({
  models,
  current,
  onPick,
}: {
  models: string[];
  current: string;
  onPick: (m: string) => void;
}) {
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(() => Math.max(0, models.indexOf(current)));
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? models.filter((m) => m.toLowerCase().includes(s)) : models;
  }, [q, models]);

  useInput((_i, key) => {
    if (!filtered.length) return;
    if (key.upArrow) setIdx((i) => (i + filtered.length - 1) % filtered.length);
    else if (key.downArrow) setIdx((i) => (i + 1) % filtered.length);
  });

  const WIN = 8;
  const safe = Math.min(idx, Math.max(0, filtered.length - 1));
  const start = Math.min(Math.max(0, safe - 3), Math.max(0, filtered.length - WIN));
  const shown = filtered.slice(start, start + WIN);

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={C.cyan}>⌕ </Text>
        <TextInput
          value={q}
          onChange={(v) => {
            setQ(v);
            setIdx(0);
          }}
          onSubmit={() => onPick(filtered[safe] ?? q.trim())}
          placeholder="escribí para buscar un modelo…"
        />
        <Text color={C.dim}>
          {"  "}
          {filtered.length}/{models.length}
        </Text>
      </Box>
      {start > 0 && <Text color={C.dim}>  ↑ más</Text>}
      {shown.map((m) => {
        const here = m === filtered[safe];
        return (
          <Text key={m} color={here ? C.magenta : C.dim}>
            {here ? "❯ " : "  "}
            {m === current ? "● " : "  "}
            {m}
          </Text>
        );
      })}
      {start + WIN < filtered.length && <Text color={C.dim}>  ↓ más</Text>}
      {filtered.length === 0 && (
        <Text color={C.yellow}>Sin coincidencias · Enter usa "{q.trim()}" tal cual</Text>
      )}
    </Box>
  );
}
