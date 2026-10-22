import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  Config,
  ModelRef,
  ProviderSettings,
  ResolvedProvider,
  RoutingConfig,
  TaskKind,
} from "../types.js";
import { renameWithRetry } from "../fsutil.js";
import { PRESETS } from "./presets.js";

const CONFIG_DIR = path.join(os.homedir(), ".nebulacodex");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const TASK_KINDS: TaskKind[] = [
  "principal",
  "code",
  "refactor",
  "debug",
  "docs",
  "chat",
  "reasoning",
  "vision",
  "three_d",
  "image",
  "fast",
];
const PLACEHOLDER_MODELS = new Set(["mi-modelo", "tu-modelo", "tu-modelo-de-deployment"]);

function emptyConfig(): Config {
  return { active: "", providers: {} };
}

function sanitizeModelRef(value: unknown): ModelRef | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const ref = value as Partial<ModelRef>;
  if (typeof ref.provider !== "string" || !ref.provider.trim()) return null;
  if (typeof ref.model !== "string" || !ref.model.trim()) return null;
  return { provider: ref.provider.trim(), model: ref.model.trim() };
}

function sanitizeRouting(value: unknown): RoutingConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Partial<RoutingConfig>;
  const principal = sanitizeModelRef(raw.principal);
  const tasks: RoutingConfig["tasks"] = {};
  if (raw.tasks && typeof raw.tasks === "object" && !Array.isArray(raw.tasks)) {
    for (const task of TASK_KINDS) {
      const ref = sanitizeModelRef((raw.tasks as Record<string, unknown>)[task]);
      if (ref) tasks[task] = ref;
    }
  }
  const hasTasks = Object.keys(tasks).length > 0;
  if (!principal && !hasTasks && raw.enabled !== true) return undefined;
  return {
    enabled: raw.enabled === true,
    ...(principal ? { principal } : {}),
    ...(hasTasks ? { tasks } : {}),
  };
}

/** Descarta lo inválido pero conserva el resto: un campo mal escrito no debe borrar todas las claves. */
function sanitizeConfig(value: unknown): Config | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const parsed = value as Partial<Config>;
  if (!parsed.providers || typeof parsed.providers !== "object" || Array.isArray(parsed.providers)) {
    return null;
  }
  // `active` puede faltar en configs antiguas o editadas a mano; no hay que borrar las claves por eso.
  const active = typeof parsed.active === "string" ? parsed.active : "";
  const providers: Config["providers"] = {};
  for (const [id, settings] of Object.entries(parsed.providers)) {
    if (id === "__proto__" || id === "constructor" || id === "prototype") continue;
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) continue;
    const clean: ProviderSettings = {};
    for (const key of ["apiKey", "model", "baseUrl"] as const) {
      const field = (settings as ProviderSettings)[key];
      if (typeof field === "string") clean[key] = field;
    }
    providers[id] = clean;
  }
  const effort = ["low", "medium", "high", "max"].includes(parsed.effort as string) ? parsed.effort : undefined;
  const maxOutputTokens =
    Number.isInteger(parsed.maxOutputTokens) && (parsed.maxOutputTokens as number) >= 256 &&
    (parsed.maxOutputTokens as number) <= 65_536
      ? parsed.maxOutputTokens
      : undefined;
  const routing = sanitizeRouting(parsed.routing);
  const lastDirectory =
    typeof parsed.lastDirectory === "string" && parsed.lastDirectory.trim()
      ? parsed.lastDirectory
      : undefined;
  return {
    active,
    providers,
    ...(effort ? { effort } : {}),
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
    ...(routing ? { routing } : {}),
    ...(lastDirectory ? { lastDirectory } : {}),
  };
}

export function loadConfig(file: string = CONFIG_FILE): Config {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return emptyConfig(); // todavía no existe (primer uso)
  }
  let config: Config | null = null;
  try {
    config = sanitizeConfig(JSON.parse(raw));
  } catch {
    config = null;
  }
  if (config) return config;
  // El archivo existe pero no se puede interpretar. Antes de que un guardado posterior lo pise se deja una
  // copia, para no perder las claves de API que tuviera. Si ya hay una copia distinta, se conserva también.
  try {
    let backup = `${file}.invalid`;
    if (fs.existsSync(backup)) {
      let previous = "";
      try {
        previous = fs.readFileSync(backup, "utf8");
      } catch {
        previous = "";
      }
      if (previous !== raw) {
        backup = `${file}.invalid-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      }
    }
    if (!fs.existsSync(backup)) {
      fs.writeFileSync(backup, raw, { encoding: "utf8", mode: 0o600 });
    }
  } catch {
    // sin copia de respaldo; se continúa igualmente con una configuración vacía
  }
  return emptyConfig();
}

export function saveConfig(cfg: Config, file: string = CONFIG_FILE) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true });
  const tempFile = path.join(directory, `.config-${process.pid}-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tempFile, JSON.stringify(cfg, null, 2), { encoding: "utf8", flag: "wx", mode: 0o600 });
    if (process.platform !== "win32") fs.chmodSync(tempFile, 0o600);
    renameWithRetry(tempFile, file);
  } finally {
    if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
  }
}

export function resolveProvider(cfg: Config, id: string): ResolvedProvider | null {
  const preset = PRESETS.find((p) => p.id === id);
  if (!preset) return null;
  const s = cfg.providers[id] ?? {};
  return {
    ...preset,
    // Ollama's local service uses its standard endpoint automatically; users only choose a model.
    baseUrl: id === "ollama" ? preset.baseUrl : s.baseUrl || preset.baseUrl,
    model: s.model || preset.model,
    apiKey: (s.apiKey?.trim() || (preset.envKey ? process.env[preset.envKey] ?? "" : "")).trim(),
  };
}

export function isConfigured(p: ResolvedProvider): boolean {
  if (p.needsKey && !p.apiKey.trim()) return false;
  const model = p.model.trim();
  if (!model || /^TU[-_]/i.test(model) || PLACEHOLDER_MODELS.has(model.toLowerCase()) || /\s/.test(model)) return false;
  // Placeholders are uppercase (TU-RECURSO...); a case-insensitive match flagged real hosts like "stu-api".
  if (/\bTU[-_][A-Z]|<[^>]+>/.test(p.baseUrl)) return false;
  try {
    const url = new URL(p.baseUrl);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}
