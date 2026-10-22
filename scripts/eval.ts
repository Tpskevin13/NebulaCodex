/**
 * Evaluación reproducible de modelos con llamadas reales.
 *
 * Uso:
 *   npm run eval -- --dry
 *   npm run eval -- --models=deepseek-v4.1-flash --tasks=chat
 *   npm run eval
 *
 * Guarda el detalle en docs/model-eval.json (sin claves) y muestra una tabla comparativa.
 * Las tareas de código se ejecutan en un contexto `vm` con timeout y sin acceso a red ni archivos.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { isDeepStrictEqual } from "node:util";
import { loadConfig, resolveProvider } from "../src/core/providers/config.ts";
import { fetchWithRetry, readTextLimited } from "../src/core/providers/http.ts";
import type { ResolvedProvider, ToolCall, ToolDef } from "../src/core/types.ts";

type Usage = { input?: number; output?: number };
interface ChatResult {
  text: string;
  toolCalls: ToolCall[];
  usage: Usage;
  finishReason?: string;
}
interface Score {
  value: number;
  detail: string;
}
interface EvalTask {
  id: string;
  title: string;
  maxTokens: number;
  /** Peso dentro del puntaje del orquestador principal. */
  principalWeight: number;
  prompt: string;
  tools?: ToolDef[];
  score: (result: ChatResult) => Score | Promise<Score>;
}
interface Candidate {
  id: string;
  label: string;
  providerId: string;
  model: string;
  price: { input: number; output: number };
  note: string;
  /** Los modelos caros o lentos solo se ejecutan si se piden explícitamente. */
  optional?: boolean;
  /** Límite de salida impuesto por el crédito disponible en el proveedor. */
  maxTokensCap?: number;
}
interface RunResult {
  model: string;
  label: string;
  task: string;
  ok: boolean;
  score: number;
  detail: string;
  latencyMs: number;
  usage: Usage;
  chars: number;
  output: string;
  error?: string;
}

const SYSTEM = "Sos un asistente técnico preciso. Seguí exactamente el formato pedido y respondé en español.";
const DELAY_BETWEEN_CALLS_MS = 350;

const candidates: Candidate[] = [
  {
    id: "claude-opus-5.5",
    label: "Claude Opus 5.5",
    providerId: "openrouter",
    model: "anthropic/claude-opus-5.5",
    price: { input: 4, output: 20 },
    note: "OpenRouter · razonamiento y código de máxima calidad",
    optional: true,
    maxTokensCap: 1200,
  },
  {
    id: "gpt-6-sol",
    label: "GPT-6 Sol",
    providerId: "openrouter",
    model: "openai/gpt-6-sol",
    price: { input: 2, output: 10 },
    note: "OpenRouter · modelo insignia de OpenAI",
    optional: true,
    maxTokensCap: 2200,
  },
  {
    id: "gemini-4-argon",
    label: "Gemini 4 Argon",
    providerId: "openrouter",
    model: "google/gemini-4-argon",
    price: { input: 2, output: 10 },
    note: "OpenRouter · contexto multimodal amplio",
    optional: true,
    maxTokensCap: 2200,
  },
  {
    id: "gemini-3.8-flash-direct",
    label: "Gemini 3.8 Flash (directo)",
    providerId: "gemini",
    model: "gemini-3.8-flash",
    price: { input: 0, output: 0 },
    note: "Google AI Studio · capa gratuita; precio según plan",
  },
  {
    id: "deepseek-v4.1-flash",
    label: "DeepSeek V4.1 Flash",
    providerId: "openrouter",
    model: "deepseek/deepseek-v4.1-flash",
    price: { input: 0.03, output: 0.12 },
    note: "OpenRouter · costo muy bajo y 1M de contexto",
  },
  {
    id: "glm-5.3",
    label: "GLM 5.3",
    providerId: "openrouter",
    model: "z-ai/glm-5.3",
    price: { input: 0.08, output: 1.4 },
    note: "OpenRouter · relación calidad/precio",
  },
  {
    id: "gpt-6-luna",
    label: "GPT-6 Luna",
    providerId: "openrouter",
    model: "openai/gpt-6-luna",
    price: { input: 0.1, output: 0.5 },
    note: "OpenRouter · variante económica y rápida",
  },
  {
    id: "gpt-oss-120b",
    label: "GPT-OSS 120B (Groq)",
    providerId: "groq",
    model: "openai/gpt-oss-120b",
    price: { input: 0, output: 0 },
    note: "Groq · inferencia rápida; precio según plan de Groq",
  },
  {
    id: "nemotron-ultra",
    label: "Nemotron 3 Ultra (NVIDIA)",
    providerId: "nvidia",
    model: "nvidia/nemotron-3-ultra-550b-a55b",
    price: { input: 0.6, output: 2.4 },
    note: "NVIDIA NIM · modelo abierto grande",
  },
  {
    id: "qwen3.5-4b",
    label: "Qwen3.5 4B (Ollama)",
    providerId: "ollama",
    model: "qwen3.5:4b",
    price: { input: 0, output: 0 },
    note: "Ollama local · referencia de privacidad y costo cero",
    optional: true,
    maxTokensCap: 800,
  },
];

function extractCode(text: string): string {
  const match = text.match(/```(?:js|javascript|typescript|ts)?\s*\n([\s\S]*?)```/i);
  return (match?.[1] ?? text).trim();
}

function prepareCode(text: string, functionName: string): string {
  let code = extractCode(text);
  code = code.replace(/^\s*export\s+default\s+/gm, "").replace(/^\s*export\s+/gm, "");
  if (!/module\.exports|exports\./.test(code) && new RegExp(`(?:function|const|let|var)\\s+${functionName}\\b`).test(code)) {
    code += `\nmodule.exports = ${functionName};`;
  }
  return code;
}

interface Sandbox {
  context: vm.Context;
  fn: Function;
}

function loadFunction(code: string, functionName: string): Sandbox {
  const sandbox: any = {
    module: { exports: {} },
    exports: {},
    console: { log() {}, error() {}, warn() {} },
    setTimeout,
    clearTimeout,
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { timeout: 1500, filename: "model-output.js" });
  let exported = sandbox.module.exports;
  if (exported && typeof exported === "object" && exported.__esModule) exported = exported.default;
  const fn = typeof exported === "function" ? exported : exported?.[functionName] ?? sandbox[functionName];
  if (typeof fn !== "function") throw new Error(`no se encontró la función ${functionName}`);
  return { context: sandbox, fn };
}

function callSync(sandbox: Sandbox, ...input: unknown[]): unknown {
  const context: any = sandbox.context;
  context.__fn = sandbox.fn;
  context.__input = input;
  context.__output = undefined;
  context.__threw = false;
  context.__error = undefined;
  vm.runInContext("try { __output = __fn(...__input); } catch (error) { __threw = true; __error = error; }", context, {
    timeout: 1500,
  });
  if (context.__threw) throw context.__error;
  return context.__output;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("la función superó el tiempo de prueba")), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function extractJson(text: string): any {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no hay un objeto JSON");
  return JSON.parse(candidate.slice(start, end + 1));
}

function words(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** Los valores creados dentro de `vm` pertenecen a otro realm: se normalizan antes de comparar. */
function toPlain(value: unknown): unknown {
  if (value === undefined) return undefined;
  const json = JSON.stringify(value);
  return json === undefined ? undefined : JSON.parse(json);
}

// ---------------------------------------------------------------------------
// Tareas
// ---------------------------------------------------------------------------

const mergePrompt = `Implementá en JavaScript una función \`mergeIntervals(intervals)\` que reciba un array de pares [inicio, fin] y devuelva los intervalos solapados o contiguos fusionados, ordenados por inicio, sin mutar la entrada. Cada intervalo debe ser un par de números finitos con inicio <= fin; si no, lanzá TypeError.
Requisitos: no modificar el array original, no usar librerías.
Devolvé SOLO un bloque \`\`\`js con la función y \`module.exports = mergeIntervals;\`. Sin explicaciones.`;

const debugPrompt = `Este código debe cargar todos los ids y devolver los resultados en el mismo orden:
\`\`\`js
async function loadAll(ids, fetchOne) {
  const results = [];
  ids.forEach(async (id) => {
    results.push(await fetchOne(id));
  });
  return results;
}
\`\`\`
Explicá el bug y devolvé una versión corregida que preserve el orden y propague errores. Formato exacto: un bloque \`\`\`json con {"bug":"...","fixed":"..."} y nada más. \`fixed\` debe ser el código completo de la función.`;

const refactorPrompt = `Refactorizá esta función a JavaScript moderno, preservando exactamente su comportamiento (incluido que solo acepta \`active === true\`), sin mutar la entrada:
\`\`\`js
function activeUsers(users) {
  const out = [];
  for (let i = 0; i < users.length; i++) {
    const u = users[i];
    if (u && u.active === true) {
      if (u.email && u.email.indexOf("@") > 0) {
        out.push({ id: u.id, email: u.email.trim().toLowerCase() });
      }
    }
  }
  return out;
}
\`\`\`
Devolvé SOLO un bloque \`\`\`js con la función y \`module.exports = activeUsers;\`. Sin explicaciones.`;

const docsPrompt = `Agregá JSDoc completo a esta función y escribí una sección breve de README en español con propósito, parámetros, valor de retorno y un ejemplo de uso. Devolvé Markdown, sin explicar tu proceso.
\`\`\`js
export function retryDelay(attempt, baseMs = 200, maxMs = 5000) {
  const exponential = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.round(exponential * (0.8 + Math.random() * 0.4));
}
\`\`\`
Mencioná el jitter y el límite máximo.`;

const structuredPrompt = `Actuá como director técnico de arte 3D. Para un juego móvil, diseñá un "cristal flotante" low-poly. Devolvé SOLO JSON válido (sin markdown) con este esquema:
{"name":string,"style":string,"polyBudget":number,"dimensions":{"width":number,"height":number,"depth":number},"materials":[{"name":string,"colorHex":"#RRGGBB","metalness":number,"roughness":number,"emissive":boolean}],"animations":[{"name":string,"durationSeconds":number,"loop":boolean}],"textureStrategy":string,"optimizationNotes":[string]}
Requisitos: polyBudget entre 300 y 5000, al menos 3 materiales con colorHex válido, al menos 1 animación de rotación o flotación, textureStrategy debe mencionar atlas o procedural, y optimizationNotes con al menos 2 elementos.`;

const threePrompt = `Escribí un módulo JavaScript autocontenido para Three.js (imports ESM) que muestre un cristal low-poly flotante con iluminación, niebla, rotación animada, responsive resize y limpieza de recursos cuando se llama a dispose(). Sin HTML.
Devolvé SOLO un bloque \`\`\`js.`;

const chatPrompt = `En español rioplatense y en 120 palabras o menos, explicá la diferencia entre useMemo y useCallback en React, y cuándo conviene cada uno. No des código extenso.`;

const toolPrompt = `Leé el archivo src/core/routing.ts y decime cuántas líneas tiene. Usá la herramienta read_file; no inventes el resultado.`;
const readFileTool: ToolDef = {
  name: "read_file",
  description: "Lee un archivo de texto y devuelve su contenido.",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "Ruta del archivo" } },
    required: ["path"],
  },
};

function scoreCode(result: ChatResult): Score {
  let sandbox: Sandbox;
  try {
    sandbox = loadFunction(prepareCode(result.text, "mergeIntervals"), "mergeIntervals");
  } catch (error: any) {
    return { value: 0, detail: `código inválido: ${error?.message ?? error}` };
  }
  const cases: Array<{ input: any; expected: any }> = [
    { input: [], expected: [] },
    { input: [[1, 3], [2, 6], [8, 10], [15, 18]], expected: [[1, 6], [8, 10], [15, 18]] },
    { input: [[1, 4], [4, 5]], expected: [[1, 5]] },
    { input: [[5, 6], [1, 2], [2, 3]], expected: [[1, 3], [5, 6]] },
    { input: [[1, 10], [2, 3]], expected: [[1, 10]] },
    { input: [[-5, -1], [-2, 2]], expected: [[-5, 2]] },
  ];
  let passed = 0;
  const failures: string[] = [];
  for (const [index, test] of cases.entries()) {
    const input = structuredClone(test.input);
    try {
      const output = toPlain(callSync(sandbox, input));
      if (isDeepStrictEqual(output, test.expected) && isDeepStrictEqual(input, test.input)) passed++;
      else failures.push(`caso ${index + 1}`);
    } catch {
      failures.push(`caso ${index + 1}`);
    }
  }
  for (const input of [[[2, 1]], [[1, 2], [3]], [[1, Number.NaN]]]) {
    try {
      callSync(sandbox, input);
      failures.push("validación");
    } catch {
      passed++;
    }
  }
  return {
    value: passed / (cases.length + 3),
    detail: failures.length ? `fallan: ${[...new Set(failures)].join(", ")}` : "todos los casos y validaciones",
  };
}

async function scoreDebug(result: ChatResult): Promise<Score> {
  let parsed: any;
  try {
    parsed = extractJson(result.text);
  } catch (error: any) {
    return { value: 0, detail: `JSON inválido: ${error?.message ?? error}` };
  }
  let value = 0.15;
  const detail: string[] = ["JSON"];
  if (typeof parsed.bug === "string" && /forEach|promesa|async|as[ií]ncron|vac[ií]o|no espera|no aguarda/i.test(parsed.bug)) {
    value += 0.15;
    detail.push("explica el bug");
  }
  const fixed = typeof parsed.fixed === "string" ? prepareCode(parsed.fixed, "loadAll") : "";
  let sandbox: Sandbox | null = null;
  try {
    sandbox = loadFunction(fixed, "loadAll");
  } catch {
    return { value, detail: [...detail, "código corregido inválido"].join(" · ") };
  }
  if (!/forEach/.test(fixed)) {
    value += 0.15;
    detail.push("sin forEach async");
  }
  const delays: Record<string, number> = { a: 30, b: 5, c: 15 };
  const seen: string[] = [];
  const fetchOne = async (id: string) => {
    seen.push(id);
    await new Promise((resolve) => setTimeout(resolve, delays[id] ?? 0));
    return id.toUpperCase();
  };
  try {
    const output = toPlain(await withTimeout(
      Promise.resolve(callSync(sandbox, ["a", "b", "c"], fetchOne) as any),
      3000,
    ));
    if (isDeepStrictEqual(output, ["A", "B", "C"]) && isDeepStrictEqual(seen, ["a", "b", "c"])) {
      value += 0.35;
      detail.push("orden correcto");
    }
  } catch {
    detail.push("no devuelve el orden");
  }
  try {
    await withTimeout(
      Promise.resolve(callSync(sandbox, ["a", "bad"], async (id: string) => {
        if (id === "bad") throw new Error("boom");
        return id;
      }) as any),
      3000,
    );
    detail.push("no propaga errores");
  } catch {
    value += 0.2;
    detail.push("propaga errores");
  }
  return { value, detail: detail.join(" · ") };
}

function scoreRefactor(result: ChatResult): Score {
  let sandbox: Sandbox;
  try {
    sandbox = loadFunction(prepareCode(result.text, "activeUsers"), "activeUsers");
  } catch (error: any) {
    return { value: 0, detail: `código inválido: ${error?.message ?? error}` };
  }
  const cases: Array<{ input: any; expected: any }> = [
    {
      input: [{ id: 1, email: " A@B.com ", active: true }, { id: 2, email: "x@y.com", active: false }],
      expected: [{ id: 1, email: "a@b.com" }],
    },
    {
      input: [null, { id: 3, email: "sin-arroba", active: true }, { id: 4, active: true }],
      expected: [],
    },
    {
      input: [{ id: 5, email: "z@z.com", active: 1 }, { id: 6, email: "b@b.com", active: true }],
      expected: [{ id: 6, email: "b@b.com" }],
    },
    { input: [], expected: [] },
    {
      input: [{ id: 7, email: "b@b.com", active: true }, { id: 8, email: "a@a.com", active: true }],
      expected: [{ id: 7, email: "b@b.com" }, { id: 8, email: "a@a.com" }],
    },
  ];
  let passed = 0;
  for (const test of cases) {
    const input = structuredClone(test.input);
    try {
      if (isDeepStrictEqual(toPlain(callSync(sandbox, input)), test.expected) && isDeepStrictEqual(input, test.input)) passed++;
    } catch {
      // El caso falla, pero el resto se sigue evaluando.
    }
  }
  return { value: passed / cases.length, detail: `${passed}/${cases.length} casos` };
}

function scoreDocs(result: ChatResult): Score {
  const param = (name: string) => new RegExp(`@param\\s+(?:\\{[^}\\n]*\\}\\s*)?\\[?${name}\\b`, "i");
  const checks: Array<[string, RegExp]> = [
    ["@param attempt", param("attempt")],
    ["@param baseMs", param("baseMs")],
    ["@param maxMs", param("maxMs")],
    ["@returns", /@returns?\b/i],
    ["ejemplo de uso", /retryDelay\s*\(/],
    ["jitter", /jitter|aleatori/i],
    ["límite máximo", /l[ií]mite|m[aá]ximo|tope/i],
  ];
  const passed = checks.filter(([, pattern]) => pattern.test(result.text)).length;
  return {
    value: passed / checks.length,
    detail: checks.filter(([, pattern]) => !pattern.test(result.text)).map(([name]) => `falta ${name}`).join(" · ") || "completo",
  };
}

function scoreStructured(result: ChatResult): Score {
  let spec: any;
  try {
    spec = extractJson(result.text);
  } catch (error: any) {
    return { value: 0, detail: `JSON inválido: ${error?.message ?? error}` };
  }
  const checks: Array<[string, boolean]> = [];
  const positive = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0;
  checks.push(["nombre", typeof spec.name === "string" && spec.name.trim().length > 0]);
  checks.push(["estilo", typeof spec.style === "string" && spec.style.trim().length > 0]);
  checks.push(["polyBudget", Number.isInteger(spec.polyBudget) && spec.polyBudget >= 300 && spec.polyBudget <= 5000]);
  const dimensions = spec.dimensions ?? {};
  checks.push(["dimensiones", positive(dimensions.width) && positive(dimensions.height) && positive(dimensions.depth)]);
  const materials = Array.isArray(spec.materials) ? spec.materials : [];
  const validMaterials = materials.filter((material: any) =>
    material && typeof material.name === "string" &&
    typeof material.colorHex === "string" && /^#[0-9a-f]{6}$/i.test(material.colorHex) &&
    typeof material.metalness === "number" && material.metalness >= 0 && material.metalness <= 1 &&
    typeof material.roughness === "number" && material.roughness >= 0 && material.roughness <= 1 &&
    typeof material.emissive === "boolean");
  checks.push(["3 materiales válidos", validMaterials.length >= 3]);
  checks.push(["material emisivo", validMaterials.some((material: any) => material.emissive === true)]);
  const animations = Array.isArray(spec.animations) ? spec.animations : [];
  checks.push(["animación", animations.some((animation: any) =>
    animation && typeof animation.name === "string" && positive(animation.durationSeconds) &&
    typeof animation.loop === "boolean")]);
  checks.push(["estrategia de textura", typeof spec.textureStrategy === "string" && /atlas|procedural/i.test(spec.textureStrategy)]);
  checks.push(["optimización", Array.isArray(spec.optimizationNotes) &&
    spec.optimizationNotes.filter((note: unknown) => typeof note === "string" && note.trim()).length >= 2]);
  const passed = checks.filter(([, ok]) => ok).length;
  return {
    value: passed / checks.length,
    detail: checks.filter(([, ok]) => !ok).map(([name]) => `falta ${name}`).join(" · ") || "esquema completo",
  };
}

function scoreThree(result: ChatResult): Score {
  const code = extractCode(result.text);
  const checks: Array<[string, RegExp]> = [
    // Acepta tanto el paquete "three" como un CDN que sirve three.module.js.
    ["import three", /from\s+["'](?:three|[^"']*\/three(?:\.module(?:\.min)?)?\.js)["']/i],
    ["scene", /\bnew\s+(?:THREE\.)?Scene\b/],
    ["camera", /PerspectiveCamera/],
    ["renderer", /WebGLRenderer/],
    // Un BufferGeometry construido a mano también es low-poly; no solo las primitivas.
    ["geometría low-poly", /IcosahedronGeometry|OctahedronGeometry|DodecahedronGeometry|ConeGeometry|SphereGeometry|BufferGeometry/],
    ["material PBR", /MeshStandardMaterial|MeshPhysicalMaterial/],
    ["luces", /DirectionalLight|AmbientLight|PointLight|HemisphereLight/],
    ["animación", /requestAnimationFrame|setAnimationLoop/],
    // ResizeObserver es una alternativa válida (y mejor) al evento resize.
    ["resize", /addEventListener\(\s*["']resize["']|ResizeObserver/],
    // Método de clase `dispose()`, función, constante o arrow function.
    ["dispose", /\bdispose\s*\([^)]*\)\s*\{|function\s+dispose|const\s+dispose|dispose\s*=\s*\(/],
    ["libera recursos", /\.dispose\s*\(/],
    ["niebla", /\bFog\b|FogExp2/],
  ];
  const passed = checks.filter(([, pattern]) => pattern.test(code)).length;
  return {
    value: passed / checks.length,
    detail: checks.filter(([, pattern]) => !pattern.test(code)).map(([name]) => `falta ${name}`).join(" · ") || "completo",
  };
}

function scoreChat(result: ChatResult): Score {
  const text = result.text;
  const checks: Array<[string, boolean]> = [
    ["useMemo valor", /useMemo/i.test(text) && /valor|resultado|c[aá]lculo/i.test(text)],
    ["useCallback referencia", /useCallback/i.test(text) && /funci[oó]n|referencia/i.test(text)],
    ["dependencias", /dependenc/i.test(text)],
    ["costo del cálculo", /costos|costoso|caro|pesado|rendimiento/i.test(text)],
    ["props/effects", /React\.memo|useEffect|props|hijo/i.test(text)],
    ["brevedad", words(text) <= 130],
  ];
  const passed = checks.filter(([, ok]) => ok).length;
  return {
    value: passed / checks.length,
    detail: checks.filter(([, ok]) => !ok).map(([name]) => `falta ${name}`).join(" · ") || `${words(text)} palabras`,
  };
}

function scoreTool(result: ChatResult): Score {
  const call = result.toolCalls[0];
  if (!call) return { value: 0, detail: "no llamó a la herramienta" };
  let value = 0.3;
  const detail: string[] = ["llamó herramienta"];
  if (call.name === "read_file") {
    value += 0.4;
    detail.push("nombre correcto");
  }
  const file = String(call.args?.path ?? call.args?.file_path ?? "");
  if (file.replace(/\\/g, "/").includes("src/core/routing.ts")) {
    value += 0.3;
    detail.push("ruta correcta");
  } else {
    detail.push(`ruta: ${file || "vacía"}`);
  }
  return { value, detail: detail.join(" · ") };
}

const tasks: EvalTask[] = [
  { id: "code", title: "Generación de código", maxTokens: 6000, principalWeight: 0.15, prompt: mergePrompt, score: scoreCode },
  { id: "debug", title: "Depuración async", maxTokens: 5000, principalWeight: 0.2, prompt: debugPrompt, score: scoreDebug },
  { id: "refactor", title: "Refactorización", maxTokens: 5000, principalWeight: 0.1, prompt: refactorPrompt, score: scoreRefactor },
  { id: "docs", title: "Documentación", maxTokens: 3000, principalWeight: 0.05, prompt: docsPrompt, score: scoreDocs },
  { id: "structured", title: "Especificación 3D", maxTokens: 3000, principalWeight: 0.1, prompt: structuredPrompt, score: scoreStructured },
  { id: "threejs", title: "Código Three.js", maxTokens: 6000, principalWeight: 0.1, prompt: threePrompt, score: scoreThree },
  { id: "chat", title: "Conversación técnica", maxTokens: 2500, principalWeight: 0.1, prompt: chatPrompt, score: scoreChat },
  { id: "tool", title: "Llamada a herramienta", maxTokens: 2000, principalWeight: 0.2, prompt: toolPrompt, tools: [readFileTool], score: scoreTool },
];

// ---------------------------------------------------------------------------
// Llamadas reales
// ---------------------------------------------------------------------------

function headersFor(provider: ResolvedProvider): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "application/json",
    ...(provider.apiKey
      ? provider.authHeader === "api-key"
        ? { "api-key": provider.apiKey }
        : { authorization: `Bearer ${provider.apiKey}` }
      : {}),
  };
}

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((part: any) => typeof part === "string" ? part : part?.text ?? "").join("");
  }
  return "";
}

async function callModel(provider: ResolvedProvider, task: EvalTask, signal: AbortSignal): Promise<ChatResult> {
  const base = provider.baseUrl.replace(/\/+$/, "");
  if (provider.kind === "anthropic") {
    const response = await fetchWithRetry(`${base}/v1/messages`, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "x-api-key": provider.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: provider.model,
        max_tokens: task.maxTokens,
        system: SYSTEM,
        messages: [{ role: "user", content: task.prompt }],
        ...(task.tools ? {
          tools: task.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.parameters,
          })),
        } : {}),
      }),
    }, { signal, headersTimeoutMs: 120_000, attempts: 3, baseDelayMs: 500 });
    const body = await readTextLimited(response, 8 * 1024 * 1024);
    const parsed = JSON.parse(body.text);
    const blocks = Array.isArray(parsed.content) ? parsed.content : [];
    return {
      text: blocks.filter((block: any) => block.type === "text").map((block: any) => block.text).join(""),
      toolCalls: blocks.filter((block: any) => block.type === "tool_use").map((block: any) => ({
        id: block.id,
        name: block.name,
        args: block.input ?? {},
      })),
      usage: { input: parsed.usage?.input_tokens, output: parsed.usage?.output_tokens },
      finishReason: parsed.stop_reason,
    };
  }

  const response = await fetchWithRetry(`${base}/chat/completions`, {
    method: "POST",
    signal,
    headers: headersFor(provider),
    body: JSON.stringify({
      model: provider.model,
      max_tokens: task.maxTokens,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: task.prompt },
      ],
      ...(task.tools ? {
        tools: task.tools.map((tool) => ({ type: "function", function: tool })),
        tool_choice: "auto",
      } : {}),
    }),
  }, { signal, headersTimeoutMs: 120_000, attempts: 3, baseDelayMs: 500 });
  const body = await readTextLimited(response, 8 * 1024 * 1024);
  const parsed = JSON.parse(body.text);
  const message = parsed.choices?.[0]?.message ?? {};
  const toolCalls: ToolCall[] = (message.tool_calls ?? []).map((call: any, index: number) => {
    let args: Record<string, any> = {};
    try {
      const value = JSON.parse(call.function?.arguments ?? "{}");
      if (value && typeof value === "object" && !Array.isArray(value)) args = value;
    } catch {
      // Los argumentos inválidos puntúan como llamada incompleta.
    }
    return { id: call.id ?? `call_${index}`, name: call.function?.name ?? "", args };
  });
  return {
    text: textContent(message.content),
    toolCalls,
    usage: { input: parsed.usage?.prompt_tokens, output: parsed.usage?.completion_tokens },
    finishReason: parsed.choices?.[0]?.finish_reason,
  };
}

// ---------------------------------------------------------------------------
// Ejecución
// ---------------------------------------------------------------------------

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

async function main() {
  const cfg = loadConfig();
  const modelFilter = arg("models")?.split(",").map((value) => value.trim()).filter(Boolean);
  const taskFilter = arg("tasks")?.split(",").map((value) => value.trim()).filter(Boolean);
  const dry = process.argv.includes("--dry");
  const smoke = process.argv.includes("--smoke");
  const selectedModels = candidates.filter((candidate) => {
    if (smoke) return candidate.id === "deepseek-v4.1-flash";
    if (modelFilter) return modelFilter.includes(candidate.id);
    return !candidate.optional;
  });
  const selectedTasks = tasks.filter((task) =>
    (!taskFilter || taskFilter.includes(task.id)) && (!smoke || task.id === "chat"));
  if (!selectedModels.length) throw new Error("No hay modelos seleccionados.");
  if (!selectedTasks.length) throw new Error("No hay tareas seleccionadas.");
  const callTimeoutMs = Math.max(10_000, Number(arg("timeout") ?? 180) * 1000);
  // Las capas gratuitas suelen limitar por minuto; --delay permite espaciar las llamadas.
  const callDelayMs = Math.max(0, Number(arg("delay") ?? DELAY_BETWEEN_CALLS_MS));
  const output = arg("out") ?? path.join("docs", "model-eval.json");
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const results: RunResult[] = [];
  const savePartial = () => {
    fs.writeFileSync(output, JSON.stringify({
      generatedAt: new Date().toISOString(),
      partial: true,
      tasks: selectedTasks.map(({ id, title, principalWeight }) => ({ id, title, principalWeight })),
      results,
    }, null, 2));
  };

  if (dry) {
    console.log("Modelos:");
    for (const candidate of selectedModels) console.log(`  ${candidate.id} → ${candidate.providerId}/${candidate.model}`);
    console.log("Tareas:");
    for (const task of selectedTasks) console.log(`  ${task.id} (peso ${task.principalWeight})`);
    return;
  }

  for (const candidate of selectedModels) {
    const base = resolveProvider(cfg, candidate.providerId);
    if (!base) {
      console.error(`❌ ${candidate.label}: proveedor ${candidate.providerId} no existe`);
      continue;
    }
    const provider = { ...base, model: candidate.model };
    if (!provider.apiKey && provider.needsKey) {
      console.error(`❌ ${candidate.label}: falta la API key de ${candidate.providerId}`);
      continue;
    }
    const cap = candidate.maxTokensCap ? ` · salida máx. ${candidate.maxTokensCap}` : "";
    console.log(`\n▶ ${candidate.label} (${candidate.providerId}/${candidate.model})${cap}`);
    for (const task of selectedTasks) {
      const effectiveTask = candidate.maxTokensCap
        ? { ...task, maxTokens: Math.min(task.maxTokens, candidate.maxTokensCap) }
        : task;
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(new Error(`la llamada superó ${Math.round(callTimeoutMs / 1000)} s`)),
        callTimeoutMs,
      );
      const started = Date.now();
      try {
        let result = await callModel(provider, effectiveTask, controller.signal);
        let usage = { ...result.usage };
        let retried = false;
        // Los modelos con razonamiento pueden gastar todo el presupuesto antes de responder.
        // 12k permite completar tareas de refactorización sin disparar el costo de los modelos premium,
        // que siguen limitados por su propio maxTokensCap.
        const retryLimit = Math.min(12_000, candidate.maxTokensCap ?? 12_000);
        if (
          !result.text.trim() && !result.toolCalls.length && result.finishReason === "length" &&
          effectiveTask.maxTokens < retryLimit
        ) {
          retried = true;
          result = await callModel(
            provider,
            { ...effectiveTask, maxTokens: Math.min(retryLimit, effectiveTask.maxTokens * 2) },
            controller.signal,
          );
          usage = {
            input: (usage.input ?? 0) + (result.usage.input ?? 0) || undefined,
            output: (usage.output ?? 0) + (result.usage.output ?? 0) || undefined,
          };
        }
        const latencyMs = Date.now() - started;
        const score = await effectiveTask.score(result);
        const record: RunResult = {
          model: candidate.id,
          label: candidate.label,
          task: task.id,
          ok: true,
          score: Math.round(score.value * 1000) / 1000,
          detail: `${score.detail}${retried ? " · reintento por longitud" : ""}`,
          latencyMs,
          usage,
          chars: result.text.length,
          output: result.text.slice(0, 12_000),
        };
        results.push(record);
        savePartial();
        console.log(`  ${task.id.padEnd(10)} ${(score.value * 100).toFixed(0).padStart(3)}%  ${String(latencyMs).padStart(6)} ms  ${record.detail}`);
      } catch (error: any) {
        const record: RunResult = {
          model: candidate.id,
          label: candidate.label,
          task: task.id,
          ok: false,
          score: 0,
          detail: `ERROR: ${error?.message ?? error}`,
          latencyMs: Date.now() - started,
          usage: {},
          chars: 0,
          output: "",
          error: String(error?.message ?? error),
        };
        results.push(record);
        savePartial();
        console.log(`  ${task.id.padEnd(10)}   0%  ${String(record.latencyMs).padStart(6)} ms  ERROR: ${record.error}`);
      } finally {
        clearTimeout(timer);
      }
      await new Promise((resolve) => setTimeout(resolve, callDelayMs));
    }
  }

  const summary = selectedModels.map((candidate) => {
    const own = results.filter((result) => result.model === candidate.id);
    const scored = own.filter((result) => result.ok);
    const scores: Record<string, number> = {};
    for (const task of selectedTasks) scores[task.id] = own.find((result) => result.task === task.id)?.score ?? 0;
    const totalWeight = selectedTasks.reduce((sum, task) => sum + task.principalWeight, 0);
    const principal = totalWeight
      ? selectedTasks.reduce((sum, task) => sum + scores[task.id] * task.principalWeight, 0) / totalWeight
      : 0;
    const mean = selectedTasks.length
      ? selectedTasks.reduce((sum, task) => sum + scores[task.id], 0) / selectedTasks.length
      : 0;
    const usage = scored.reduce((sum, result) => ({
      input: sum.input + (result.usage.input ?? 0),
      output: sum.output + (result.usage.output ?? 0),
    }), { input: 0, output: 0 });
    const cost = usage.input / 1_000_000 * candidate.price.input + usage.output / 1_000_000 * candidate.price.output;
    return {
      ...candidate,
      scores,
      principal,
      mean,
      medianLatency: median(scored.map((result) => result.latencyMs)),
      usage,
      estimatedCostUsd: cost,
    };
  });
  summary.sort((a, b) => b.principal - a.principal);

  console.log("\n## Resultados\n");
  const header = ["Modelo", ...selectedTasks.map((task) => task.id), "Media", "Principal", "ms", "USD"];
  console.log(`| ${header.join(" | ")} |`);
  console.log(`| ${header.map(() => "---").join(" | ")} |`);
  for (const row of summary) {
    const cells = [
      row.label,
      ...selectedTasks.map((task) => `${(row.scores[task.id] * 100).toFixed(0)}%`),
      `${(row.mean * 100).toFixed(1)}%`,
      `${(row.principal * 100).toFixed(1)}%`,
      String(row.medianLatency),
      `$${row.estimatedCostUsd.toFixed(4)}`,
    ];
    console.log(`| ${cells.join(" | ")} |`);
  }

  fs.writeFileSync(output, JSON.stringify({
    generatedAt: new Date().toISOString(),
    tasks: selectedTasks.map(({ id, title, principalWeight }) => ({ id, title, principalWeight })),
    models: summary,
    results,
  }, null, 2));
  console.log(`\nDetalle guardado en ${output}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
