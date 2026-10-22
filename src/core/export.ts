import fs from "node:fs";
import path from "node:path";
import type { Msg } from "./types.js";

const MAX_TOOL_OUTPUT = 4000;

/** Cerco de backticks más largo que cualquier secuencia dentro del texto, para no romper el bloque. */
function codeBlock(text: string): string {
  let longest = 0;
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}\n${text}\n${fence}`;
}

export function chatToMarkdown(title: string, messages: Msg[], now: Date = new Date()): string {
  const heading = title.replace(/\s+/g, " ").trim() || "Chat";
  const out = [`# ${heading}`, "", `_Exportado el ${now.toISOString()}_`, ""];
  for (const message of messages) {
    if (message.role === "user") {
      out.push("## Usuario", "", message.content, "");
    } else if (message.role === "assistant") {
      if (message.content.trim()) out.push("## NebulaCodex", "", message.content, "");
      for (const call of message.toolCalls ?? []) {
        out.push(`### Herramienta: ${call.name}`, "", codeBlock(JSON.stringify(call.args, null, 2)), "");
      }
    } else {
      const output = message.content.length > MAX_TOOL_OUTPUT
        ? `${message.content.slice(0, MAX_TOOL_OUTPUT)}\n… (recortado)`
        : message.content;
      out.push(`### Resultado: ${message.toolName ?? "herramienta"}`, "", codeBlock(output), "");
    }
  }
  return out.join("\n");
}

function slug(value: string): string {
  const base = value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || "chat";
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

/** Nombres válidos en Windows, macOS y Linux a la vez. */
function safeStem(value: string): string {
  const cleaned = value
    .replace(/[<>:"|?*\u0000-\u001f]/g, "-")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 120);
  if (!cleaned) return "chat";
  return WINDOWS_RESERVED.test(cleaned) ? `_${cleaned}` : cleaned;
}

/**
 * Guarda la conversación como Markdown en `directory` y devuelve la ruta creada.
 * Nunca pisa un archivo existente: agrega -2, -3… al nombre si hace falta.
 */
export function exportChat(title: string, messages: Msg[], directory: string, requestedName = ""): string {
  if (!messages.length) throw new Error("No hay mensajes para exportar.");
  const requested = requestedName.trim();
  if (/[\\/]/.test(requested)) {
    throw new Error("El nombre no puede incluir carpetas; el archivo se guarda en la carpeta activa.");
  }
  const baseName = requested || `nebulacodex-${slug(title)}`;
  const stem = safeStem(baseName.replace(/\.md$/i, ""));
  const markdown = chatToMarkdown(title, messages);
  for (let attempt = 1; attempt <= 10_000; attempt++) {
    const target = path.join(directory, attempt === 1 ? `${stem}.md` : `${stem}-${attempt}.md`);
    try {
      // "wx" crea el archivo de forma exclusiva: evita pisar uno existente y cierra la carrera TOCTOU
      // que dejaba la comprobación existsSync + writeFileSync.
      fs.writeFileSync(target, markdown, { flag: "wx" });
      return target;
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  throw new Error("No pude encontrar un nombre libre para exportar el chat.");
}
