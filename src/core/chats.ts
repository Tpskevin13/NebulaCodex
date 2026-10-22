import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { renameWithRetry } from "./fsutil.js";
import { normalizeConversation } from "./agent.js";
import type { Msg } from "./types.js";

export interface StoredChat {
  id: string;
  title: string;
  messages: Msg[];
  createdAt: string;
  updatedAt: string;
}

const CHAT_DIR = path.join(os.homedir(), ".nebulacodex", "chats");

interface CachedChat {
  mtimeMs: number;
  size: number;
  chat: StoredChat;
}

/**
 * listChats() se llama al abrir el buscador y al arrancar. Sin caché, cada llamada parsea todos los
 * chats completos. Se invalida por mtime/tamaño y al guardar.
 */
const chatCache = new Map<string, CachedChat>();

export function newChatId(): string {
  return randomUUID();
}

function chatFile(id: string): string {
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error("ID de chat inválido.");
  return path.join(CHAT_DIR, `${id}.json`);
}

function parseChat(value: unknown): StoredChat | null {
  if (!value || typeof value !== "object") return null;
  const chat = value as Partial<StoredChat>;
  if (
    typeof chat.id !== "string" ||
    !/^[a-f0-9-]{36}$/i.test(chat.id) ||
    typeof chat.title !== "string" ||
    !Array.isArray(chat.messages) ||
    typeof chat.createdAt !== "string" ||
    typeof chat.updatedAt !== "string"
  ) return null;
  const messages = chat.messages.filter((message): message is Msg => {
    if (!message || typeof message !== "object") return false;
    const item = message as Partial<Msg>;
    if (!["user", "assistant", "tool"].includes(item.role ?? "") || typeof item.content !== "string") return false;
    if (item.role === "tool" && (typeof item.toolCallId !== "string" || !item.toolCallId.trim())) return false;
    if (item.toolCalls !== undefined && (!Array.isArray(item.toolCalls) || item.toolCalls.some((call) =>
      !call || typeof call.id !== "string" || !call.id.trim() || typeof call.name !== "string" || !call.name.trim() ||
      !call.args || typeof call.args !== "object" || Array.isArray(call.args)))) return false;
    return item.toolCallId === undefined || typeof item.toolCallId === "string";
  });
  return {
    id: chat.id,
    title: chat.title,
    messages: normalizeConversation(messages),
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
  };
}

function readCached(file: string): StoredChat | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    chatCache.delete(file);
    return null;
  }
  const cached = chatCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.chat;
  try {
    const chat = parseChat(JSON.parse(fs.readFileSync(file, "utf8")));
    if (!chat) {
      chatCache.delete(file);
      return null;
    }
    chatCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, chat });
    return chat;
  } catch {
    chatCache.delete(file);
    return null;
  }
}

export function listChats(): StoredChat[] {
  try {
    return fs.readdirSync(CHAT_DIR)
      .filter((file) => /^[a-f0-9-]{36}\.json$/i.test(file))
      .map((file) => readCached(path.join(CHAT_DIR, file)))
      .filter((chat): chat is StoredChat => chat !== null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  } catch {
    return [];
  }
}

/** Siempre devuelve una copia nueva: el chat abierto se modifica en memoria y no debe contaminar la caché. */
export function loadChat(id: string): StoredChat | null {
  try {
    const parsed = parseChat(JSON.parse(fs.readFileSync(chatFile(id), "utf8")));
    return parsed?.id === id ? parsed : null;
  } catch {
    return null;
  }
}

export function loadLatestChat(): StoredChat | null {
  const latest = listChats()[0];
  return latest ? loadChat(latest.id) : null;
}

export function saveChat(chat: StoredChat): void {
  fs.mkdirSync(CHAT_DIR, { recursive: true, mode: 0o700 });
  const destination = chatFile(chat.id);
  const temporary = path.join(CHAT_DIR, `.${chat.id}-${process.pid}-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(chat, null, 2), { encoding: "utf8", flag: "wx", mode: 0o600 });
    if (process.platform !== "win32") fs.chmodSync(temporary, 0o600);
    renameWithRetry(temporary, destination);
    chatCache.delete(destination);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
