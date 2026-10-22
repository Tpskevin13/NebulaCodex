import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyTask, parseModelRef, resolveModelRef, routeTask, TASK_LABEL } from "../src/core/routing.ts";
import { isConfigured, loadConfig, resolveProvider, saveConfig } from "../src/core/providers/config.ts";
import type { Config } from "../src/core/types.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    active: "groq",
    providers: {
      groq: { apiKey: "groq-key" },
      openrouter: { apiKey: "openrouter-key" },
      nvidia: { apiKey: "nvidia-key" },
    },
    ...overrides,
  };
}

test("classifyTask recognises the supported kinds in Spanish and English", () => {
  assert.equal(classifyTask("Haceme un modelo 3D low-poly con texturas para Three.js"), "three_d");
  assert.equal(classifyTask("Generá un logo y un sprite para la app"), "image");
  assert.equal(classifyTask("No funciona el login: tira una excepción"), "debug");
  assert.equal(classifyTask("Refactorizá esta clase y extraé funciones"), "refactor");
  assert.equal(classifyTask("Actualizá el README y los comentarios del módulo"), "docs");
  assert.equal(classifyTask("Implementá una función TypeScript para ordenar"), "code");
  assert.equal(classifyTask("Diseñá la arquitectura y compará los trade-offs"), "reasoning");
  // "render" no debe confundirse con una imagen: aquí es un motor de renderizado.
  assert.equal(classifyTask("Diseñá la arquitectura de un motor de render"), "reasoning");
  assert.equal(classifyTask("hola"), "fast");
  assert.equal(classifyTask("contame algo interesante sobre la historia"), "chat");
  assert.equal(classifyTask("   "), "fast");
  // Una tarea de 3D gana aunque mencione "imagen" para la textura.
  assert.equal(classifyTask("Creá la malla del personaje y su textura de imagen"), "three_d");
});

test("every task kind has a human label", () => {
  for (const kind of Object.keys(TASK_LABEL)) {
    assert.ok(TASK_LABEL[kind as keyof typeof TASK_LABEL].length > 0);
  }
});

test("parseModelRef splits provider from model, including nested model ids", () => {
  assert.deepEqual(parseModelRef(" openrouter/anthropic/claude-opus-5.5 "), {
    provider: "openrouter",
    model: "anthropic/claude-opus-5.5",
  });
  assert.deepEqual(parseModelRef("ollama/qwen3.5:4b"), { provider: "ollama", model: "qwen3.5:4b" });
  assert.equal(parseModelRef(""), null);
  assert.equal(parseModelRef("openrouter"), null);
  assert.equal(parseModelRef("/model"), null);
  assert.equal(parseModelRef("provider/"), null);
});

test("resolveModelRef preserves the preset URL and authentication while replacing the model", () => {
  const resolved = resolveModelRef(baseConfig(), { provider: "openrouter", model: "anthropic/claude-sonnet-5.5" });
  assert.ok(resolved);
  assert.equal(resolved.model, "anthropic/claude-sonnet-5.5");
  assert.equal(resolved.baseUrl, "https://openrouter.ai/api/v1");
  assert.equal(resolved.apiKey, "openrouter-key");
  assert.equal(resolved.kind, "openai");
  assert.equal(resolveModelRef(baseConfig(), { provider: "missing", model: "x" }), null);
});

test("routeTask uses the active provider when routing is disabled", () => {
  const decision = routeTask(baseConfig(), "implementá una función");
  assert.equal(decision.source, "active");
  assert.equal(decision.task, "code");
  assert.equal(decision.provider?.id, "groq");
  assert.equal(decision.ref?.provider, "groq");
  assert.match(decision.reason, /proveedor activo/);
});

test("routeTask prefers the task model, then the principal, then the active provider", () => {
  const taskRouting = routeTask(
    baseConfig({
      routing: {
        enabled: true,
        principal: { provider: "nvidia", model: "nvidia/nemotron-3-ultra-550b-a55b" },
        tasks: { code: { provider: "openrouter", model: "deepseek/deepseek-v4.1-flash" } },
      },
    }),
    "refactorizá este módulo",
  );
  // No hay modelo de refactorización: cae al principal.
  assert.equal(taskRouting.task, "refactor");
  assert.equal(taskRouting.source, "principal");
  assert.equal(taskRouting.provider?.id, "nvidia");

  const codeRouting = routeTask(
    baseConfig({
      routing: {
        enabled: true,
        principal: { provider: "nvidia", model: "nvidia/nemotron-3-ultra-550b-a55b" },
        tasks: { code: { provider: "openrouter", model: "deepseek/deepseek-v4.1-flash" } },
      },
    }),
    "implementá una función",
  );
  assert.equal(codeRouting.source, "task");
  assert.equal(codeRouting.provider?.id, "openrouter");
  assert.equal(codeRouting.provider?.model, "deepseek/deepseek-v4.1-flash");

  const principalRouting = routeTask(
    baseConfig({
      routing: {
        enabled: true,
        principal: { provider: "nvidia", model: "nvidia/nemotron-3-ultra-550b-a55b" },
        tasks: { code: { provider: "openrouter", model: "deepseek/deepseek-v4.1-flash" } },
      },
    }),
    "contame algo",
  );
  assert.equal(principalRouting.source, "principal");
  assert.equal(principalRouting.provider?.id, "nvidia");

  const fallbackRouting = routeTask(
    baseConfig({
      routing: {
        enabled: true,
        principal: { provider: "missing", model: "x" },
        tasks: { code: { provider: "also-missing", model: "y" } },
      },
    }),
    "implementá una función",
  );
  assert.equal(fallbackRouting.source, "active");
  assert.equal(fallbackRouting.provider?.id, "groq");
});

test("routeTask reports when nothing is configured", () => {
  const decision = routeTask({ active: "", providers: {} }, "hola");
  assert.equal(decision.source, "none");
  assert.equal(decision.provider, null);
  assert.equal(decision.ref, null);
});

test("config keeps valid routing entries and lastDirectory while dropping malformed fields", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nebulacodex-routing-"));
  const file = path.join(directory, "config.json");
  try {
    fs.writeFileSync(file, JSON.stringify({
      active: "groq",
      lastDirectory: directory,
      maxOutputTokens: 4096,
      routing: {
        enabled: true,
        principal: { provider: "nvidia", model: "nvidia/nemotron-3-ultra-550b-a55b" },
        tasks: {
          code: { provider: "openrouter", model: "deepseek/deepseek-v4.1-flash" },
          docs: { provider: "", model: "x" },
          bogus: { provider: "groq", model: "x" },
        },
      },
      providers: { groq: { apiKey: "k" } },
    }));
    const config = loadConfig(file);
    assert.equal(config.lastDirectory, directory);
    assert.equal(config.maxOutputTokens, 4096);
    assert.equal(config.routing?.enabled, true);
    assert.deepEqual(config.routing?.tasks, {
      code: { provider: "openrouter", model: "deepseek/deepseek-v4.1-flash" },
    });

    fs.writeFileSync(file, JSON.stringify({ active: "", providers: {}, routing: { enabled: true } }));
    assert.deepEqual(loadConfig(file).routing, { enabled: true });
    fs.writeFileSync(file, JSON.stringify({ active: "", providers: {}, routing: { enabled: false } }));
    assert.equal(loadConfig(file).routing, undefined);
    fs.writeFileSync(file, JSON.stringify({ active: "", providers: {}, routing: "on" }));
    assert.equal(loadConfig(file).routing, undefined);
    fs.writeFileSync(file, JSON.stringify({ active: "", providers: {}, maxOutputTokens: 10 }));
    assert.equal(loadConfig(file).maxOutputTokens, undefined);

    saveConfig({ active: "", providers: {}, routing: { enabled: true }, lastDirectory: directory, maxOutputTokens: 8192 }, file);
    assert.deepEqual(loadConfig(file), {
      active: "",
      providers: {},
      routing: { enabled: true },
      lastDirectory: directory,
      maxOutputTokens: 8192,
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("isConfigured rejects placeholders, whitespace, and unusable URLs", () => {
  const placeholder = resolveProvider({ active: "custom", providers: {} }, "custom");
  assert.ok(placeholder);
  assert.equal(isConfigured(placeholder), false, "mi-modelo is a placeholder");

  const azure = resolveProvider({ active: "azure-openai", providers: {} }, "azure-openai");
  assert.ok(azure);
  assert.equal(isConfigured(azure), false, "TU-RECURSO and TU-NOMBRE are placeholders");

  const valid = resolveProvider(
    { active: "custom", providers: { custom: { model: "real-model", baseUrl: "https://example.com/v1" } } },
    "custom",
  );
  assert.ok(valid);
  assert.equal(isConfigured(valid), true);

  const spaced = resolveProvider(
    { active: "custom", providers: { custom: { model: "two words", baseUrl: "https://example.com/v1" } } },
    "custom",
  );
  assert.ok(spaced);
  assert.equal(isConfigured(spaced), false);

  const badUrl = resolveProvider(
    { active: "custom", providers: { custom: { model: "real-model", baseUrl: "ftp://example.com" } } },
    "custom",
  );
  assert.ok(badUrl);
  assert.equal(isConfigured(badUrl), false);
});
