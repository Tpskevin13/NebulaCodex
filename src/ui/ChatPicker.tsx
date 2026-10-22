import { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { C } from "./theme.js";
import { cleanLine } from "../core/text.js";
import type { StoredChat } from "../core/chats.js";

export function ChatPicker({
  chats,
  initialQuery = "",
  onPick,
  onClose,
}: {
  chats: StoredChat[];
  initialQuery?: string;
  onPick: (chat: StoredChat) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [selected, setSelected] = useState(0);
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return chats;
    return chats.filter((chat) =>
      chat.title.toLocaleLowerCase().includes(needle) ||
      chat.id.toLocaleLowerCase().includes(needle) ||
      chat.messages.some((message) => message.content.toLocaleLowerCase().includes(needle)),
    );
  }, [chats, query]);
  const safeIndex = Math.min(selected, Math.max(0, filtered.length - 1));
  const windowSize = 3;
  // Keep the selected row inside the 3-row window (the old `safeIndex - 3` offset could hide it).
  const start = Math.min(Math.max(0, safeIndex - 1), Math.max(0, filtered.length - windowSize));
  const visible = filtered.slice(start, start + windowSize);

  useInput((_input, key) => {
    if (key.escape) onClose();
    else if (key.upArrow && filtered.length) setSelected((index) => (index + filtered.length - 1) % filtered.length);
    else if (key.downArrow && filtered.length) setSelected((index) => (index + 1) % filtered.length);
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={C.border} paddingX={1} marginTop={1}>
      <Text color={C.violet} bold>BUSCAR CHAT GUARDADO</Text>
      <Box>
        <Text color={C.cyan}>⌕ </Text>
        <TextInput
          value={query}
          onChange={(value) => {
            setQuery(cleanLine(value));
            setSelected(0);
          }}
          onSubmit={() => {
            const chat = filtered[safeIndex];
            if (chat) onPick(chat);
          }}
          placeholder="título, texto o ID…"
        />
        <Text color={C.dim}>  {filtered.length}/{chats.length}</Text>
      </Box>
      {visible.map((chat, offset) => {
        const index = start + offset;
        const date = new Date(chat.updatedAt);
        const updated = Number.isNaN(date.getTime()) ? "fecha desconocida" : date.toLocaleString("es-AR");
        const lastUserMessage = [...chat.messages].reverse().find((message) => message.role === "user")?.content ?? "Sin mensajes";
        const excerpt = lastUserMessage.replace(/\s+/g, " ").trim();
        return (
          <Box key={chat.id} flexDirection="column" marginTop={1}>
            <Text color={index === safeIndex ? C.magenta : C.text} bold={index === safeIndex}>
              {index === safeIndex ? "❯ " : "  "}{chat.title}
            </Text>
            <Text color={C.dim}>    {updated} · {chat.id.slice(0, 8)}</Text>
            <Text color={C.dim}>    {excerpt.slice(0, 72)}{excerpt.length > 72 ? "…" : ""}</Text>
          </Box>
        );
      })}
      {filtered.length === 0 && <Text color={C.yellow}>No hay chats que coincidan con la búsqueda.</Text>}
      <Text color={C.dim}>↑↓ elegir · Enter abrir · Esc cerrar</Text>
    </Box>
  );
}
