import type { Config, ModelRef, ResolvedProvider, TaskKind } from "./types.js";
import { isConfigured, resolveProvider } from "./providers/config.js";

export interface RouteDecision {
  task: TaskKind;
  provider: ResolvedProvider | null;
  ref: ModelRef | null;
  source: "task" | "principal" | "active" | "none";
  reason: string;
}

export const TASK_LABEL: Record<TaskKind, string> = {
  principal: "orquestador",
  code: "código",
  refactor: "refactorización",
  debug: "depuración",
  docs: "documentación",
  chat: "conversación",
  reasoning: "razonamiento",
  vision: "visión",
  three_d: "3D",
  image: "imagen",
  fast: "respuesta rápida",
};

const RULES: Array<{ task: TaskKind; pattern: RegExp }> = [
  {
    task: "three_d",
    pattern:
      /\b(3d|malla|mallas|mesh|meshes|blender|gltf|glb|fbx|obj|stl|usdz|textur[ai]|texture|uv|low[- ]?poly|voxel|three\.?js|babylon\.?js|rigging|animaci[oó]n 3d)\b/i,
  },
  {
    task: "image",
    pattern:
      /\b(imagen|im[aá]genes|image|sprite|sprites|logo|icono|icon|foto|ilustraci[oó]n|textura de imagen|fondo de pantalla)\b/i,
  },
  {
    task: "debug",
    pattern:
      /\b(error|errores|bug|bugs|falla|fallo|excepci[oó]n|exception|stack ?trace|traceback|no funciona|roto|rota|broken|debug|depurar|diagn[oó]stic)\b/i,
  },
  {
    task: "refactor",
    pattern:
      /\b(refactor|refactoriz|renombr|extrae|extraer|divid|simplific|clean ?up|reorganiz|mueve|mover|patr[oó]n|acoplamiento|deuda t[eé]cnica)\b/i,
  },
  {
    task: "docs",
    pattern:
      /\b(document|documentaci[oó]n|docs|readme|jsdoc|docstring|comentario|comentarios|manual de uso|gu[ií]a de uso)\b/i,
  },
  {
    task: "code",
    pattern:
      /\b(code|c[oó]digo|funci[oó]n|funci[oó]n|clase|implement|implementá|escrib|escribí|crea|crear|genera|generar|test|tests|prueba|pruebas|typescript|javascript|python|react|api|endpoint|sql|script)\b/i,
  },
  {
    task: "reasoning",
    pattern:
      /\b(analiz|analizá|diseñ|diseñá|arquitectura|plan|planific|estrategia|por qu[eé]|why|trade-?off|compara|comparar|eval[uú]a|decid)\b/i,
  },
];

/** Clasificador determinista: no gasta una llamada extra al modelo para decidir el enrutamiento. */
export function classifyTask(prompt: string): TaskKind {
  const text = prompt.toLocaleLowerCase();
  for (const rule of RULES) {
    if (rule.pattern.test(text)) return rule.task;
  }
  return text.trim().length <= 20 ? "fast" : "chat";
}

export function parseModelRef(value: string): ModelRef | null {
  const trimmed = value.trim();
  const slash = trimmed.indexOf("/");
  if (slash < 1 || slash === trimmed.length - 1) return null;
  return { provider: trimmed.slice(0, slash), model: trimmed.slice(slash + 1) };
}

/** Construye un proveedor resuelto a partir de la referencia, conservando key/URL/autenticación del preset. */
export function resolveModelRef(cfg: Config, ref: ModelRef): ResolvedProvider | null {
  const base = resolveProvider(cfg, ref.provider);
  if (!base) return null;
  return { ...base, model: ref.model };
}

function usable(ref: ModelRef, cfg: Config): { provider: ResolvedProvider | null; ref: ModelRef | null } {
  const provider = resolveModelRef(cfg, ref);
  return provider && isConfigured(provider) ? { provider, ref } : { provider: null, ref: null };
}

/**
 * Elige el modelo para un mensaje.
 *
 * Con el enrutamiento apagado se usa el proveedor activo (comportamiento histórico). Con el
 * enrutamiento prendido se prueba, en orden: modelo específico de la tarea, modelo principal y,
 * como último recurso, el proveedor activo.
 */
export function routeTask(cfg: Config, prompt: string): RouteDecision {
  const task = classifyTask(prompt);
  const routing = cfg.routing;

  if (routing?.enabled) {
    const taskRef = routing.tasks?.[task];
    if (taskRef) {
      const chosen = usable(taskRef, cfg);
      if (chosen.provider && chosen.ref) {
        return {
          task,
          provider: chosen.provider,
          ref: chosen.ref,
          source: "task",
          reason: `${TASK_LABEL[task]}: ${chosen.ref.provider}/${chosen.ref.model}`,
        };
      }
    }
    if (routing.principal) {
      const chosen = usable(routing.principal, cfg);
      if (chosen.provider && chosen.ref) {
        return {
          task,
          provider: chosen.provider,
          ref: chosen.ref,
          source: "principal",
          reason: `principal: ${chosen.ref.provider}/${chosen.ref.model}`,
        };
      }
    }
  }

  if (cfg.active) {
    const active = resolveProvider(cfg, cfg.active);
    if (active && isConfigured(active)) {
      return {
        task,
        provider: active,
        ref: { provider: active.id, model: active.model },
        source: "active",
        reason: `proveedor activo: ${active.label} · ${active.model}`,
      };
    }
  }

  return { task, provider: null, ref: null, source: "none", reason: "no hay un proveedor configurado" };
}
