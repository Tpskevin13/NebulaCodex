/**
 * Verificación en vivo del camino real de NebulaCodex (`streamChat`): texto y tool calling.
 * Uso: npm run check:live -- [proveedor/modelo ...]
 */
import { isConfigured, loadConfig, resolveProvider } from "../src/core/providers/config.ts";
import { streamChat } from "../src/core/providers/stream.ts";
import type { ResolvedProvider, ToolDef } from "../src/core/types.ts";

const targets = process.argv.slice(2).filter((value) => value.includes("/"));
const defaults = [
  "groq/openai/gpt-oss-120b",
  "nvidia/nvidia/nemotron-3-ultra-550b-a55b",
];
const selected = targets.length ? targets : defaults;

const readFile: ToolDef = {
  name: "read_file",
  description: "Lee un archivo de texto.",
  parameters: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
};

async function collect(provider: ResolvedProvider, prompt: string, tools: ToolDef[] = [], maxTokens?: number) {
  let text = "";
  let toolCalls = [];
  for await (const event of streamChat(
    provider,
    "Sos un asistente técnico. Seguí las instrucciones al pie de la letra.",
    [{ role: "user", content: prompt }],
    tools,
    AbortSignal.timeout(120_000),
    "medium",
    maxTokens,
  )) {
    if (event.type === "text") text += event.text;
    else toolCalls = event.toolCalls;
  }
  return { text, toolCalls };
}

const cfg = loadConfig();
for (const target of selected) {
  const slash = target.indexOf("/");
  const providerId = target.slice(0, slash);
  const model = target.slice(slash + 1);
  const base = resolveProvider(cfg, providerId);
  if (!base) {
    console.log(`FAIL ${target}: proveedor desconocido`);
    continue;
  }
  const provider = { ...base, model };
  if (!isConfigured(provider)) {
    console.log(`FAIL ${target}: proveedor sin key/modelo válido`);
    continue;
  }
  const started = Date.now();
  try {
    const text = await collect(provider, "Respondé únicamente con la palabra OK.", [], cfg.maxOutputTokens);
    console.log(`TEXT ${target} [${Date.now() - started} ms] :: ${text.text.trim().slice(0, 80)}`);
  } catch (error: any) {
    console.log(`FAIL text ${target} :: ${error?.message ?? error}`);
  }
  const toolStarted = Date.now();
  try {
    const result = await collect(
      provider,
      "Leé el archivo src/core/routing.ts usando la herramienta read_file. No inventes el contenido.",
      [readFile],
      cfg.maxOutputTokens,
    );
    const call = result.toolCalls[0];
    console.log(
      `TOOL ${target} [${Date.now() - toolStarted} ms] :: ${call ? `${call.name}(${JSON.stringify(call.args)})` : "sin tool call"} :: texto=${result.text.trim().slice(0, 60)}`,
    );
  } catch (error: any) {
    console.log(`FAIL tool ${target} :: ${error?.message ?? error}`);
  }
}
