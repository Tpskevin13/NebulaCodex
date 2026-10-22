import fs from "node:fs";
import path from "node:path";
import dns from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cleanOutput } from "./text.js";
import { readTextLimited } from "./providers/http.js";
import type { ToolDef } from "./types.js";

export const TOOLS: ToolDef[] = [
  {
    name: "list_dir",
    description: "Lista archivos y carpetas de un directorio.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Ruta, por defecto '.'" } },
    },
  },
  {
    name: "read_file",
    description:
      "Lee un archivo de texto. Devuelve hasta 12000 caracteres por llamada; si el archivo es más largo, usa 'offset' para seguir leyendo.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "integer", description: "Posición de carácter desde la que leer (por defecto 0)" },
      },
      required: ["path"],
    },
  },
  {
    name: "search_text",
    description: "Busca texto (literal o expresión regular) en archivos de una carpeta y sus subcarpetas.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Carpeta o archivo de inicio; por defecto '.'" },
        query: { type: "string", description: "Texto literal que se busca" },
        case_sensitive: { type: "boolean", description: "Distinguir mayúsculas y minúsculas" },
        regex: { type: "boolean", description: "Interpretar 'query' como expresión regular de JavaScript" },
        max_results: { type: "integer", description: "Máximo de coincidencias (1–200)" },
      },
      required: ["query"],
    },
  },
  {
    name: "find_files",
    description: "Busca archivos y carpetas por un fragmento literal del nombre.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Carpeta de inicio; por defecto '.'" },
        query: { type: "string", description: "Fragmento del nombre que se busca" },
        max_results: { type: "integer", description: "Máximo de coincidencias (1–200)" },
      },
      required: ["query"],
    },
  },
  {
    name: "write_file",
    description: "Crea o sobrescribe un archivo con el contenido completo.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description:
      "Reemplaza un texto exacto (old) por otro (new) en un archivo. 'old' debe aparecer una sola vez, salvo que uses replace_all.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        old: { type: "string" },
        new: { type: "string" },
        replace_all: { type: "boolean", description: "Reemplazar todas las apariciones de 'old'" },
      },
      required: ["path", "old", "new"],
    },
  },
  {
    name: "run_command",
    description:
      process.platform === "win32"
        ? "Ejecuta un comando de PowerShell en el directorio actual y devuelve la salida."
        : "Ejecuta un comando de shell en el directorio actual y devuelve la salida.",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
  {
    name: "delete_file",
    description: "Elimina un archivo (no carpetas). El usuario puede deshacerlo con /undo.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "move_file",
    description: "Mueve o renombra un archivo. Falla si el destino ya existe.",
    parameters: {
      type: "object",
      properties: { from: { type: "string" }, to: { type: "string" } },
      required: ["from", "to"],
    },
  },
  {
    name: "fetch_url",
    description: "Descarga una URL http(s) con GET y devuelve su texto (el HTML se convierte a texto plano).",
    parameters: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    },
  },
];

/** Herramientas que modifican cosas y piden permiso antes de correr. */
export const NEEDS_APPROVAL = new Set(["write_file", "edit_file", "delete_file", "move_file", "fetch_url", "run_command"]);

export function describeCall(name: string, args: Record<string, any>): string {
  const preview = (value: unknown, limit = 240) =>
    typeof value === "string"
      ? value.replace(/\r?\n/g, " ↵ ").slice(0, limit) + (value.length > limit ? "…" : "")
      : "";
  switch (name) {
    case "list_dir":
      return args.path || ".";
    case "search_text":
    case "find_files":
      return `${args.query ?? ""} · ${args.path || "."}`;
    case "read_file":
    case "delete_file":
      return String(args.path ?? "");
    case "move_file":
      return `${String(args.from ?? "")} → ${String(args.to ?? "")}`;
    case "fetch_url":
      return preview(args.url, 300);
    case "write_file":
      return `${String(args.path ?? "")} · ${preview(args.content)}`;
    case "edit_file":
      return `${String(args.path ?? "")} · reemplazar “${preview(args.old, 100)}” por “${preview(args.new, 100)}”`;
    case "run_command":
      return preview(args.command, 500);
    default:
      return JSON.stringify(args);
  }
}

const MAX_OUT = 12000;
const clip = (s: string) =>
  s.length > MAX_OUT ? s.slice(0, MAX_OUT) + `\n… (recortado, ${s.length} caracteres)` : s;
const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".venv",
  "vendor",
]);
const MAX_SCANNED_ENTRIES = 50_000;
const MAX_MATCHES = 200;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_READ_BYTES = 4 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 500;

function positiveLimit(value: unknown): number {
  if (value === undefined) return MAX_MATCHES;
  if (!Number.isInteger(value) || (value as number) < 1) return 0;
  return Math.min(value as number, MAX_MATCHES);
}

function walkFiles(start: string, visit: (file: string, isDirectory: boolean) => boolean): boolean {
  let scannedEntries = 0;
  const root = fs.statSync(start);
  if (root.isFile()) {
    visit(start, false);
    return false;
  }
  if (!root.isDirectory()) return false;

  // Use an explicit stack so a deeply nested tree cannot overflow the JS call stack.
  const pending = [start];
  while (pending.length) {
    const dir = pending.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      scannedEntries++;
      if (scannedEntries > MAX_SCANNED_ENTRIES) return true;
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        if (visit(fullPath, true)) return false;
        pending.push(fullPath);
      } else if (entry.isFile()) {
        if (visit(fullPath, false)) return false;
      }
    }
  }
  return false;
}

function searchText(args: Record<string, any>): string {
  if (typeof args.query !== "string" || !args.query.trim()) {
    return "Error: 'query' es obligatorio y debe ser texto no vacío.";
  }
  if (args.path !== undefined && typeof args.path !== "string") {
    return "Error: 'path' debe ser texto.";
  }
  if (args.case_sensitive !== undefined && typeof args.case_sensitive !== "boolean") {
    return "Error: 'case_sensitive' debe ser booleano.";
  }
  if (args.regex !== undefined && typeof args.regex !== "boolean") {
    return "Error: 'regex' debe ser booleano.";
  }
  const limit = positiveLimit(args.max_results);
  if (!limit) return "Error: 'max_results' debe ser un entero entre 1 y 200.";

  const start = path.resolve(args.path || ".");
  const caseSensitive = args.case_sensitive === true;
  if (args.query.length > 500) return "Error: 'query' supera los 500 caracteres.";
  let pattern: RegExp | null = null;
  if (args.regex === true) {
    try {
      pattern = new RegExp(args.query, caseSensitive ? "" : "i");
    } catch (e: any) {
      return `Error: expresión regular inválida: ${e.message}`;
    }
  }
  const needle: string = caseSensitive ? args.query : args.query.toLocaleLowerCase();
  const matches: string[] = [];
  let skippedLarge = 0;
  let skippedBinary = 0;
  let totalBytes = 0;
  let byteLimitReached = false;
  const scanLimitReached = walkFiles(start, (file, isDirectory) => {
    if (isDirectory) return false;
    try {
      const stat = fs.statSync(file);
      if (stat.size > MAX_FILE_BYTES) {
        skippedLarge++;
        return false;
      }
      if (totalBytes + stat.size > MAX_TOTAL_BYTES) {
        byteLimitReached = true;
        return true;
      }
      totalBytes += stat.size;
      const bytes = fs.readFileSync(file);
      if (bytes.includes(0)) {
        skippedBinary++;
        return false;
      }
      const contents = bytes.toString("utf8");
      const lines = contents.split(/\r?\n/);
      // Para búsquedas literales se pasa a minúsculas una vez por archivo, no una vez por línea.
      const comparable = !caseSensitive && !pattern ? contents.toLocaleLowerCase().split(/\r?\n/) : lines;
      for (let i = 0; i < lines.length; i++) {
        const matched = pattern
          // Se acota el largo de línea para limitar el costo de expresiones con retroceso excesivo.
          ? pattern.test(lines[i].slice(0, 2000))
          : comparable[i].includes(needle);
        if (!matched) continue;
        const preview = lines[i].trim().slice(0, 500);
        matches.push(`${path.relative(start, file) || path.basename(file)}:${i + 1}: ${preview}`);
        if (matches.length >= limit) return true;
      }
    } catch {
      // Ignore unreadable files and continue searching the rest of the tree.
    }
    return false;
  });

  let result = matches.length ? matches.join("\n") : "Sin coincidencias.";
  if (matches.length >= limit) result += `\n… límite de ${limit} coincidencias alcanzado.`;
  if (skippedLarge) result += `\nSe omitieron ${skippedLarge} archivos de más de 2 MiB.`;
  if (skippedBinary) result += `\nSe omitieron ${skippedBinary} archivos binarios.`;
  if (byteLimitReached) result += "\nBúsqueda detenida al alcanzar 128 MiB de archivos revisados.";
  if (scanLimitReached) result += `\nBúsqueda limitada a ${MAX_SCANNED_ENTRIES.toLocaleString()} elementos.`;
  return clip(result);
}

function findFiles(args: Record<string, any>): string {
  if (typeof args.query !== "string" || !args.query.trim()) {
    return "Error: 'query' es obligatorio y debe ser texto no vacío.";
  }
  if (args.path !== undefined && typeof args.path !== "string") {
    return "Error: 'path' debe ser texto.";
  }
  const limit = positiveLimit(args.max_results);
  if (!limit) return "Error: 'max_results' debe ser un entero entre 1 y 200.";

  const start = path.resolve(args.path || ".");
  const query = args.query.toLocaleLowerCase();
  const matches: string[] = [];
  const scanLimitReached = walkFiles(start, (fullPath, isDirectory) => {
    if (!path.basename(fullPath).toLocaleLowerCase().includes(query)) return false;
    matches.push(`${path.relative(start, fullPath) || path.basename(fullPath)}${isDirectory ? "/" : ""}`);
    return matches.length >= limit;
  });
  let result = matches.length ? matches.join("\n") : "Sin coincidencias.";
  if (matches.length >= limit) result += `\n… límite de ${limit} resultados alcanzado.`;
  if (scanLimitReached) result += `\nBúsqueda limitada a ${MAX_SCANNED_ENTRIES.toLocaleString()} elementos.`;
  return clip(result);
}

const COMMAND_TIMEOUT_MS = 120_000;
const MAX_COMMAND_OUTPUT = 10 * 1024 * 1024;
// Tras terminar la shell se espera un instante a que se vacíen las tuberías; si un proceso en segundo plano
// las mantiene abiertas no se bloquea la herramienta esperándolo.
const COMMAND_DRAIN_GRACE_MS = 500;
const runningCommands = new Set<ChildProcess>();

/** Mata el proceso y todos sus descendientes: matar solo la shell dejaría hijos vivos (puertos y archivos ocupados). */
function killTree(child: ChildProcess, sync = false) {
  const pid = child.pid;
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      const args = ["/PID", String(pid), "/T", "/F"];
      if (sync) spawnSync("taskkill", args, { stdio: "ignore", windowsHide: true });
      else spawn("taskkill", args, { stdio: "ignore", windowsHide: true }).on("error", () => {});
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // el proceso ya había terminado
    }
  }
}

// Si NebulaCodex se cierra con un comando en marcha, no se dejan procesos huérfanos.
process.on("exit", () => {
  for (const child of runningCommands) killTree(child, true);
});

export function runCommand(
  command: string,
  signal?: AbortSignal,
  timeoutMs: number = COMMAND_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve) => {
    const isWindows = process.platform === "win32";
    let file = "/bin/sh";
    let args = ["-c", command];
    if (isWindows) {
      // -EncodedCommand avoids passing the model's command through cmd.exe or
      // through PowerShell's argument parser before PowerShell receives it.
      const script = [
        "$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new();",
        "$ErrorActionPreference = 'Stop';",
        "try {",
        command,
        "if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
        "} catch { [Console]::Error.WriteLine($_.ToString()); exit 1 }",
      ].join("\n");
      file = "powershell.exe";
      args = [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ];
    }

    let stdout = "";
    let stderr = "";
    let received = 0;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let graceTimer: NodeJS.Timeout | undefined;

    const child = spawn(file, args, {
      cwd: process.cwd(),
      windowsHide: true,
      // En POSIX el comando lidera su propio grupo de procesos para poder matar todo el árbol.
      detached: !isWindows,
      // Sin entrada estándar: un comando que espera datos termina en vez de quedarse colgado.
      stdio: ["ignore", "pipe", "pipe"],
    });
    runningCommands.add(child);

    const settle = (message: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      signal?.removeEventListener("abort", onAbort);
      runningCommands.delete(child);
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(clip(message));
    };
    // Salida limpia: sin colores ANSI ni barras de progreso que ensucien la pantalla y el contexto del modelo.
    const collected = () => cleanOutput([stdout, stderr].filter(Boolean).join("\n"));
    const fail = (detail: string) => {
      const out = collected();
      settle(`Error: el comando ${detail}.${out ? `\n${out}` : ""}`);
    };
    const stop = (detail: string) => {
      killTree(child);
      fail(detail);
    };
    const onAbort = () => stop("fue cancelado");
    const finish = (code: number | null, killSignal: NodeJS.Signals | null) => {
      if (code === 0) settle(collected() || "(sin salida)");
      else if (typeof code === "number") fail(`terminó con código ${code}`);
      else fail(`terminó por la señal ${killSignal ?? "desconocida"}`);
    };
    const collect = (isError: boolean) => (chunk: string) => {
      if (settled) return;
      received += Buffer.byteLength(chunk);
      if (received > MAX_COMMAND_OUTPUT) {
        stop("generó más de 10 MiB de salida y se detuvo");
        return;
      }
      if (isError) stderr += chunk;
      else stdout += chunk;
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", collect(false));
    child.stderr?.on("data", collect(true));
    child.on("error", (err) => fail(`no se pudo ejecutar (${err.message})`));
    child.on("close", finish);
    child.on("exit", (code, killSignal) => {
      graceTimer = setTimeout(() => finish(code, killSignal), COMMAND_DRAIN_GRACE_MS);
    });

    timer = setTimeout(() => stop(`superó el límite de ${Math.round(timeoutMs / 1000)} segundos`), timeoutMs);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const MAX_UNDO_ENTRIES = 20;
const MAX_UNDO_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FETCH_BYTES = 5 * 1024 * 1024;

type UndoEntry =
  | { kind: "file"; file: string; previous: Buffer | null }
  | { kind: "move"; from: string; to: string };
const undoStack: UndoEntry[] = [];

function pushUndo(entry: UndoEntry | null) {
  if (!entry) return;
  undoStack.push(entry);
  if (undoStack.length > MAX_UNDO_ENTRIES) undoStack.shift();
}

/** Guarda el contenido actual de un archivo (null si todavía no existe) para poder deshacer. */
function snapshotFile(file: string): UndoEntry | null {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_UNDO_FILE_BYTES) return null;
    return { kind: "file", file, previous: fs.readFileSync(file) };
  } catch (e: any) {
    return e?.code === "ENOENT" ? { kind: "file", file, previous: null } : null;
  }
}

/** Detecta cualquier entrada, incluso un symlink roto, sin seguir el enlace. */
function pathEntryExists(target: string): boolean {
  try {
    fs.lstatSync(target);
    return true;
  } catch (error: any) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function moveFile(from: string, to: string) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch (e: any) {
    if (e?.code !== "EXDEV") throw e;
    // Entre unidades distintas no se puede renombrar: copiar y borrar el original.
    fs.copyFileSync(from, to);
    fs.unlinkSync(from);
  }
}

/** Deshace el último cambio de archivos hecho por el agente (write, edit, delete o move). */
export function undoLastChange(): string {
  const entry = undoStack.pop();
  if (!entry) return "No hay cambios para deshacer.";
  try {
    if (entry.kind === "move") {
      if (pathEntryExists(entry.from)) {
        undoStack.push(entry);
        return `Error: no puedo deshacer el movimiento: ya existe ${entry.from}.`;
      }
      moveFile(entry.to, entry.from);
      return `Movimiento deshecho: ${entry.to} → ${entry.from}`;
    }
    if (entry.previous === null) {
      fs.rmSync(entry.file, { force: true });
      return `Archivo creado eliminado: ${entry.file}`;
    }
    fs.mkdirSync(path.dirname(entry.file), { recursive: true });
    fs.writeFileSync(entry.file, entry.previous);
    return `Archivo restaurado: ${entry.file}`;
  } catch (e: any) {
    undoStack.push(entry);
    return `Error: no pude deshacer el cambio: ${e.message}`;
  }
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6])\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    })
    .replace(/&#(\d+);/g, (_, decimal: string) => {
      const code = Number.parseInt(decimal, 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    })
    .replace(/&amp;/g, "&")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const BLOCKED_FETCH_HOSTS = new Set([
  "169.254.169.254", // metadatos de AWS/GCP/Azure
  "metadata.google.internal",
  "metadata",
  "instance-data",
  "localhost",
  "localhost.localdomain",
]);

const SSRF_ERROR =
  "Error: por seguridad no se pueden descargar endpoints de metadatos internos ni direcciones de red privada o local.";

/** Redes que nunca deben ser accesibles mediante fetch_url (loopback, LAN, metadatos, multicast…). */
const BLOCKED_NETWORKS = new BlockList();
const BLOCKED_SUBNETS: Array<[string, number, "ipv4" | "ipv6"]> = [
  ["0.0.0.0", 8, "ipv4"],
  ["10.0.0.0", 8, "ipv4"],
  ["100.64.0.0", 10, "ipv4"],
  ["127.0.0.0", 8, "ipv4"],
  ["169.254.0.0", 16, "ipv4"],
  ["172.16.0.0", 12, "ipv4"],
  ["192.0.0.0", 24, "ipv4"],
  ["192.0.2.0", 24, "ipv4"],
  ["192.88.99.0", 24, "ipv4"],
  ["192.168.0.0", 16, "ipv4"],
  ["198.18.0.0", 15, "ipv4"],
  ["198.51.100.0", 24, "ipv4"],
  ["203.0.113.0", 24, "ipv4"],
  ["224.0.0.0", 4, "ipv4"],
  ["240.0.0.0", 4, "ipv4"],
  ["::", 96, "ipv6"],
  ["64:ff9b::", 96, "ipv6"],
  ["100::", 64, "ipv6"],
  ["2001::", 32, "ipv6"],
  ["2001:10::", 28, "ipv6"],
  ["2001:db8::", 32, "ipv6"],
  ["2002::", 16, "ipv6"],
  ["fc00::", 7, "ipv6"],
  ["fe80::", 10, "ipv6"],
  ["ff00::", 8, "ipv6"],
];
for (const [network, prefix, family] of BLOCKED_SUBNETS) BLOCKED_NETWORKS.addSubnet(network, prefix, family);

function cleanHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
}

function isBlockedHostname(hostname: string): boolean {
  const host = cleanHostname(hostname);
  return (
    BLOCKED_FETCH_HOSTS.has(host) ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".home.arpa")
  );
}

function isPrivateAddress(address: string): boolean {
  const value = address.split("%")[0];
  const family = isIP(value);
  if (family === 4) return BLOCKED_NETWORKS.check(value, "ipv4");
  if (family === 6) {
    // Las IPv4 incrustadas en IPv6 también pueden alcanzar la red local.
    const dotted = /^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value);
    if (dotted && isIP(dotted[1]) === 4) return BLOCKED_NETWORKS.check(dotted[1], "ipv4");
    const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(value);
    if (hexMapped) {
      const high = Number.parseInt(hexMapped[1], 16);
      const low = Number.parseInt(hexMapped[2], 16);
      return BLOCKED_NETWORKS.check(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`, "ipv4");
    }
    return BLOCKED_NETWORKS.check(value, "ipv6");
  }
  return false;
}

function lookupWithTimeout(hostname: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), 5_000);
  });
  const lookup = dns.lookup(hostname, { all: true, verbatim: true });
  return Promise.race([lookup, timeout]).finally(() => clearTimeout(timer));
}

/** Devuelve un error si la URL apunta a la red local/metadatos; null si es pública. */
async function urlSafetyError(url: URL): Promise<string | null> {
  const host = cleanHostname(url.hostname);
  if (isBlockedHostname(host)) return SSRF_ERROR;
  if (isIP(host)) return isPrivateAddress(host) ? SSRF_ERROR : null;
  try {
    const addresses = await lookupWithTimeout(host);
    if (!addresses.length) return "Error: la URL no resuelve a ninguna dirección.";
    if (addresses.some((entry) => isPrivateAddress(entry.address))) return SSRF_ERROR;
    return null;
  } catch {
    return "Error: no se pudo resolver el host de la URL.";
  }
}

async function discardBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // El cuerpo de una redirección no importa; si ya se cerró, no hay nada que hacer.
  }
}

async function fetchUrl(rawUrl: unknown, signal?: AbortSignal): Promise<string> {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) {
    return "Error: 'url' es obligatorio y debe ser texto.";
  }
  let initialUrl: URL;
  try {
    initialUrl = new URL(rawUrl.trim());
  } catch {
    return "Error: la URL no es válida.";
  }
  if (initialUrl.protocol !== "http:" && initialUrl.protocol !== "https:") {
    return "Error: solo se permiten URLs http y https.";
  }

  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(cancel, 20_000);
  try {
    let url = initialUrl;
    for (let redirects = 0; ; redirects++) {
      // Se valida en cada salto: una URL pública podría redirigir a 127.0.0.1 o a metadatos.
      const unsafe = await urlSafetyError(url);
      if (unsafe) return unsafe;

      const res = await fetch(url, {
        signal: controller.signal,
        redirect: "manual",
        headers: { "user-agent": "NebulaCodex", accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5" },
      });

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        await discardBody(res);
        if (!location) return `Error: la solicitud devolvió HTTP ${res.status} sin Location.`;
        if (redirects >= 5) return "Error: la URL redirige demasiadas veces.";
        let next: URL;
        try {
          next = new URL(location, url);
        } catch {
          return "Error: la redirección tiene una URL inválida.";
        }
        if (next.protocol !== "http:" && next.protocol !== "https:") {
          return "Error: solo se permiten URLs http y https.";
        }
        url = next;
        continue;
      }

      if (!res.ok) return `Error: la solicitud devolvió HTTP ${res.status} ${res.statusText}`.trim();
      const type = res.headers.get("content-type") ?? "";
      if (/^(image|audio|video)\//i.test(type) || /application\/(zip|octet-stream|pdf|gzip)/i.test(type)) {
        return `Error: el contenido (${type}) no es texto.`;
      }
      if (Number(res.headers.get("content-length") ?? 0) > MAX_FETCH_BYTES) {
        return "Error: la respuesta pesa más de 5 MiB.";
      }
      const body = await readTextLimited(res, MAX_FETCH_BYTES);
      if (body.truncated) return "Error: la respuesta pesa más de 5 MiB.";
      const text = /html/i.test(type) ? htmlToText(body.text) : body.text;
      return clip(text || "(respuesta vacía)");
    }
  } catch (e: any) {
    if (signal?.aborted) return "Error: la descarga fue cancelada.";
    if (controller.signal.aborted) return "Error: la descarga superó el límite de 20 segundos.";
    return `Error: no se pudo descargar la URL (${e?.cause?.code ?? e?.message ?? "error de red"}).`;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}

export async function runTool(
  name: string,
  args: Record<string, any>,
  signal?: AbortSignal,
): Promise<string> {
  try {
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      return "Error: los argumentos de la herramienta deben ser un objeto.";
    }
    if (signal?.aborted) return "Error: acción cancelada antes de ejecutarse.";

    switch (name) {
      case "list_dir": {
        if (args.path !== undefined && typeof args.path !== "string") {
          return "Error: 'path' debe ser texto.";
        }
        const dir = path.resolve(args.path || ".");
        const handle = fs.opendirSync(dir);
        const entries: string[] = [];
        let truncated = false;
        try {
          while (entries.length <= MAX_DIRECTORY_ENTRIES) {
            const entry = handle.readSync();
            if (!entry) break;
            if (entries.length === MAX_DIRECTORY_ENTRIES) {
              truncated = true;
              break;
            }
            entries.push(entry.isDirectory() ? `${entry.name}/` : entry.name);
          }
        } finally {
          handle.closeSync();
        }
        entries.sort((a, b) => a.localeCompare(b));
        const preview = entries.join("\n") || "(carpeta vacía)";
        return clip(preview + (truncated ? `\n… se muestran los primeros ${MAX_DIRECTORY_ENTRIES} elementos.` : ""));
      }
      case "read_file": {
        if (typeof args.path !== "string" || !args.path.trim()) {
          return "Error: 'path' es obligatorio y debe ser texto.";
        }
        const file = path.resolve(args.path);
        const stat = fs.statSync(file);
        if (!stat.isFile()) return "Error: la ruta no apunta a un archivo regular.";
        if (stat.size > MAX_READ_BYTES) {
          return `Error: el archivo pesa ${(stat.size / (1024 * 1024)).toFixed(1)} MiB y supera el límite de lectura de 4 MiB.`;
        }
        const contents = fs.readFileSync(file);
        if (contents.includes(0)) return "Error: el archivo parece binario y no se puede leer como texto.";
        const text = contents.toString("utf8");
        const offset = args.offset ?? 0;
        if (!Number.isInteger(offset) || offset < 0) {
          return "Error: 'offset' debe ser un entero mayor o igual a 0.";
        }
        if (offset > 0 && offset >= text.length) {
          return `Error: 'offset' (${offset}) supera el largo del archivo (${text.length} caracteres).`;
        }
        const end = offset + MAX_OUT;
        return (
          text.slice(offset, end) +
          (end < text.length ? `\n… (siguen ${text.length - end} caracteres; usá offset=${end} para continuar)` : "")
        );
      }
      case "search_text":
        return searchText(args);
      case "find_files":
        return findFiles(args);
      case "write_file": {
        if (typeof args.path !== "string" || !args.path.trim()) {
          return "Error: 'path' es obligatorio y debe ser texto.";
        }
        if (typeof args.content !== "string") {
          return "Error: 'content' es obligatorio y debe ser texto; no se escribió el archivo.";
        }
        const f = path.resolve(args.path);
        const undo = snapshotFile(f);
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, args.content);
        pushUndo(undo);
        return `Archivo escrito: ${args.path} (${args.content.length} caracteres)${undo ? "" : " · sin deshacer: el archivo original supera 2 MiB"}`;
      }
      case "edit_file": {
        if (typeof args.path !== "string" || !args.path.trim()) {
          return "Error: 'path' es obligatorio y debe ser texto.";
        }
        if (typeof args.old !== "string" || !args.old.length) {
          return "Error: 'old' debe ser texto no vacío.";
        }
        if (typeof args.new !== "string") {
          return "Error: 'new' es obligatorio y debe ser texto.";
        }
        if (args.replace_all !== undefined && typeof args.replace_all !== "boolean") {
          return "Error: 'replace_all' debe ser booleano.";
        }
        const replaceAll = args.replace_all === true;
        const f = path.resolve(args.path);
        const stat = fs.statSync(f);
        if (!stat.isFile()) return "Error: la ruta no apunta a un archivo regular.";
        // Igual que read_file: no cargar archivos gigantes en memoria por una edición.
        if (stat.size > MAX_READ_BYTES) {
          return `Error: el archivo pesa ${(stat.size / (1024 * 1024)).toFixed(1)} MiB y supera el límite de edición de 4 MiB.`;
        }
        const contents = fs.readFileSync(f);
        if (contents.includes(0)) return "Error: el archivo parece binario y no se puede editar como texto.";
        const text = contents.toString("utf8");
        let oldText: string = args.old;
        let newText: string = args.new;
        // Contar con indexOf evita crear un array de millones de fragmentos cuando `old` es muy común.
        const countOccurrences = (haystack: string, needle: string): number => {
          let count = 0;
          let index = 0;
          while ((index = haystack.indexOf(needle, index)) !== -1) {
            count++;
            index += needle.length;
          }
          return count;
        };
        let count = countOccurrences(text, oldText);
        // Windows files often use CRLF while models send LF: retry with matching line endings.
        if (count === 0 && text.includes("\r\n") && /(^|[^\r])\n/.test(oldText)) {
          const crlfOld = oldText.replace(/\r?\n/g, "\r\n");
          const crlfCount = countOccurrences(text, crlfOld);
          if (crlfCount > 0) {
            oldText = crlfOld;
            newText = newText.replace(/\r?\n/g, "\r\n");
            count = crlfCount;
          }
        }
        if (count === 0) return "Error: el texto 'old' no se encontró.";
        if (count > 1 && !replaceAll) {
          return `Error: 'old' aparece ${count} veces, tiene que ser único (o usá replace_all).`;
        }
        const undo = snapshotFile(f);
        fs.writeFileSync(f, replaceAll ? text.replaceAll(oldText, () => newText) : text.replace(oldText, () => newText));
        pushUndo(undo);
        return replaceAll && count > 1 ? `Editado: ${args.path} (${count} reemplazos)` : `Editado: ${args.path}`;
      }
      case "delete_file": {
        if (typeof args.path !== "string" || !args.path.trim()) {
          return "Error: 'path' es obligatorio y debe ser texto.";
        }
        const f = path.resolve(args.path);
        if (!fs.lstatSync(f).isFile()) {
          return "Error: solo se pueden eliminar archivos regulares (no carpetas ni enlaces simbólicos).";
        }
        const undo = snapshotFile(f);
        fs.unlinkSync(f);
        pushUndo(undo);
        return undo
          ? `Eliminado: ${args.path}`
          : `Eliminado: ${args.path} (no se puede deshacer: el archivo supera 2 MiB)`;
      }
      case "move_file": {
        if (typeof args.from !== "string" || !args.from.trim() || typeof args.to !== "string" || !args.to.trim()) {
          return "Error: 'from' y 'to' son obligatorios y deben ser texto.";
        }
        const from = path.resolve(args.from);
        const to = path.resolve(args.to);
        if (!fs.lstatSync(from).isFile()) return "Error: solo se pueden mover archivos regulares.";
        if (from === to) return "Error: el origen y el destino son el mismo archivo.";
        const onlyCaseChange = process.platform === "win32" && from.toLowerCase() === to.toLowerCase();
        if (pathEntryExists(to) && !onlyCaseChange) return `Error: el destino ya existe: ${args.to}`;
        moveFile(from, to);
        pushUndo({ kind: "move", from, to });
        return `Movido: ${args.from} → ${args.to}`;
      }
      case "fetch_url":
        return await fetchUrl(args.url, signal);
      case "run_command":
        if (typeof args.command !== "string" || !args.command.trim()) {
          return "Error: 'command' es obligatorio y debe ser texto no vacío.";
        }
        return await runCommand(args.command, signal);
      default:
        if (name === "__invalid_tool_call__") {
          return "Error: los argumentos de la herramienta no llegaron como JSON válido (¿respuesta cortada?). Volvé a llamar a la herramienta con los argumentos completos.";
        }
        return `Error: herramienta desconocida: ${name}`;
    }
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}
