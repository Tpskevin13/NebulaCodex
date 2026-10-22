import { useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { C, aurora } from "./theme.js";
import { Spinner } from "./Spinner.js";
import { ModelPicker } from "./ModelPicker.js";
import { PRESETS, isConfigured, listModels, resolveProvider, saveConfig } from "../core/providers/index.js";
import type { Config } from "../core/types.js";
import { cleanToken } from "../core/text.js";

type Mode = "list" | "edit";

export function ProvidersScreen({
  cfg,
  onSave,
  onClose,
  canClose,
}: {
  cfg: Config;
  onSave: (c: Config) => void;
  onClose: () => void;
  canClose: boolean;
}) {
  const [mode, setMode] = useState<Mode>("list");
  const [sel, setSel] = useState(
    Math.max(
      0,
      PRESETS.findIndex((p) => p.id === cfg.active),
    ),
  );
  const [field, setField] = useState(0);
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [mstate, setMstate] = useState<"idle" | "loading" | "ok" | "error">("idle");
  const [merr, setMerr] = useState("");
  const [configError, setConfigError] = useState("");
  const modelRequest = useRef(0);

  const preset = PRESETS[sel];
  // Ollama usa su servicio local automáticamente; solo el proveedor personalizado pide URL.
  const showUrl = preset.id === "custom" || preset.customBaseUrl === true;
  const showApiKey = preset.needsKey || preset.id === "custom" || preset.id === "modal";
  const fields = [
    { label: "API key ", show: showApiKey },
    { label: "Base URL", show: showUrl },
    { label: "Modelo  ", show: true },
  ];

  // Trae los modelos reales del proveedor con la key y la URL actuales
  const fetchModels = (key: string, url: string) => {
    const request = ++modelRequest.current;
    setMstate("loading");
    setMerr("");
    listModels({ ...preset, apiKey: key, baseUrl: url })
      .then((list) => {
        if (request !== modelRequest.current) return;
        if (list.length) {
          setModels(list);
          setMstate("ok");
        } else {
          setModels([]);
          setMerr(preset.id === "ollama" ? "Ollama no devolvió modelos disponibles." : "el proveedor no devolvió modelos");
          setMstate("error");
        }
      })
      .catch((e: any) => {
        if (request !== modelRequest.current) return;
        setModels([]);
        setMerr(
          preset.id === "ollama"
            ? "Ollama no responde. Abrilo y volvé a intentar."
            : String(e?.message ?? e).slice(0, 160),
        );
        setMstate("error");
      });
  };

  const advance = (i: number, key: string, url: string) => {
    const next = fields.findIndex((f, j) => j > i && f.show);
    if (next === 2) fetchModels(key, url);
    setField(next);
  };

  useInput(
    (_i, key) => {
      if (key.upArrow) setSel((s) => (s + PRESETS.length - 1) % PRESETS.length);
      else if (key.downArrow) setSel((s) => (s + 1) % PRESETS.length);
      else if (key.escape && canClose) onClose();
      else if (key.return) {
        const r = resolveProvider(cfg, preset.id)!;
        setApiKey(r.apiKey);
        setModel(r.model);
        setBaseUrl(r.baseUrl);
        setModels([]);
        setMstate("idle");
        const first = showApiKey ? 0 : showUrl ? 1 : 2;
        setField(first);
        setMode("edit");
        if (first === 2) fetchModels(r.apiKey, r.baseUrl);
      }
    },
    { isActive: mode === "list" },
  );

  useInput(
    (_i, key) => {
      if (key.escape) {
        modelRequest.current++;
        setMode("list");
      }
    },
    { isActive: mode === "edit" },
  );

  const finish = (chosen?: string) => {
    const m = (chosen ?? model).trim();
    const enteredKey = apiKey.trim();
    const environmentKey = preset.envKey ? process.env[preset.envKey]?.trim() ?? "" : "";
    const storedKey = environmentKey && enteredKey === environmentKey
      ? (cfg.providers[preset.id]?.apiKey?.trim() === environmentKey ? environmentKey : "")
      : enteredKey;
    const candidate = {
      ...preset,
      apiKey: enteredKey || environmentKey,
      model: m,
      baseUrl: preset.id === "ollama" ? preset.baseUrl : baseUrl.trim(),
    };
    if (!isConfigured(candidate)) {
      setConfigError("La configuración está incompleta. Revisá la API key, la URL y el nombre del modelo.");
      return;
    }
    const next: Config = {
      ...cfg,
      active: preset.id,
      providers: {
        ...cfg.providers,
        [preset.id]: {
          // Keep environment-provided secrets in the environment instead of copying them to config.json.
          apiKey: storedKey,
          model: m,
          baseUrl: baseUrl.trim(),
        },
      },
    };
    try {
      saveConfig(next);
      setConfigError("");
      onSave(next);
    } catch (e: any) {
      setConfigError(`No pude guardar la configuración: ${e?.message ?? String(e)}`);
    }
  };

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text>{aurora("✦ Proveedores de IA")}</Text>
      <Text color={C.dim}>Elegí con ↑↓ · Enter para configurar{canClose ? " · Esc para volver" : ""}</Text>
      <Box flexDirection="column" marginTop={1}>
        {PRESETS.map((p, i) => {
          const r = resolveProvider(cfg, p.id)!;
          const ok = isConfigured(r);
          const active = cfg.active === p.id;
          const here = i === sel;
          return (
            <Box key={p.id}>
              <Text color={here ? C.magenta : C.dim}>{here ? "❯ " : "  "}</Text>
              <Text color={ok ? C.green : C.dim}>{ok ? "●" : "○"} </Text>
              <Text color={here ? C.text : C.dim} bold={here}>
                {p.label.padEnd(14)}
              </Text>
              <Text color={C.dim}>{p.hint}</Text>
              {active ? <Text color={C.cyan}> (en uso)</Text> : null}
            </Box>
          );
        })}
      </Box>

      {mode === "edit" && (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={C.border}
          paddingX={1}
          marginTop={1}
        >
          <Text color={C.violet} bold>
            Configurar {preset.label}
          </Text>
          {configError ? <Text color={C.red}>{configError}</Text> : null}

          {fields[0].show && (
            <Box>
              <Text color={field === 0 ? C.magenta : C.dim}>{fields[0].label} </Text>
              {field === 0 ? (
                <TextInput
                  value={apiKey}
                  onChange={(value) => {
                    setApiKey(cleanToken(value));
                    setConfigError("");
                  }}
                  mask="•"
                  placeholder="pegá tu API key"
                  onSubmit={(v) => advance(0, v.trim(), baseUrl.trim())}
                />
              ) : (
                <Text color={C.text}>
                  {apiKey ? "•".repeat(Math.min(apiKey.length, 24)) : "(vacío)"}
                </Text>
              )}
            </Box>
          )}

          {fields[1].show && (
            <Box>
              <Text color={field === 1 ? C.magenta : C.dim}>{fields[1].label} </Text>
              {field === 1 ? (
                <TextInput
                  value={baseUrl}
                  onChange={(value) => {
                    setBaseUrl(cleanToken(value));
                    setConfigError("");
                  }}
                  onSubmit={(v) => advance(1, apiKey.trim(), v.trim())}
                />
              ) : (
                <Text color={C.text}>{baseUrl}</Text>
              )}
            </Box>
          )}

          <Box flexDirection="column">
            <Box>
              <Text color={field === 2 ? C.magenta : C.dim}>{fields[2].label} </Text>
              {field !== 2 && <Text color={C.dim}>(se elige después de la key)</Text>}
              {field === 2 && mstate === "loading" && <Spinner label="buscando modelos…" />}
              {field === 2 && mstate === "ok" && (
                <Text color={C.green}>{models.length} modelos disponibles</Text>
              )}
            </Box>
            {field === 2 && mstate === "ok" && (
              <Box paddingLeft={2}>
                <ModelPicker models={models} current={model} onPick={(m) => finish(m)} />
              </Box>
            )}
            {field === 2 && mstate === "error" && (
              <Box flexDirection="column" paddingLeft={2}>
                <Text color={C.yellow}>No pude traer la lista: {merr}</Text>
                <Text color={C.dim}>
                  {preset.id === "ollama"
                    ? "Verificá el modelo con ollama list y volvé a intentar; los modelos cloud requieren sesión iniciada en Ollama."
                    : "Revisá la key / URL (Esc y volvés a intentar) o escribí el modelo a mano:"}
                </Text>
                <TextInput
                  value={model}
                  onChange={(value) => {
                    setModel(cleanToken(value));
                    setConfigError("");
                  }}
                  onSubmit={() => finish()}
                  placeholder="nombre del modelo"
                />
              </Box>
            )}
          </Box>

          <Text color={C.dim}>
            {field === 2 && mstate === "ok"
              ? "Escribí para buscar · ↑↓ elegir · Enter guarda y activa · Esc cancela"
              : "Enter avanza · Esc cancela"}
          </Text>
          {preset.envKey && (
            <Text color={C.dim}>También podés usar la variable {preset.envKey}</Text>
          )}
          {!preset.needsKey && showApiKey && (
            <Text color={C.dim}>La API key es opcional para este endpoint.</Text>
          )}
        </Box>
      )}
    </Box>
  );
}
