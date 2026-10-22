import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import { C, SYSTEM_PROMPT, aurora, banner, compactBanner } from "../ui/theme.js";
import { Approval } from "../ui/Approval.js";
import { ModelPicker } from "../ui/ModelPicker.js";
import { ProvidersScreen } from "../ui/ProvidersScreen.js";
import { SettingsScreen } from "../ui/SettingsScreen.js";
import { Spinner } from "../ui/Spinner.js";
import { ChatPicker } from "../ui/ChatPicker.js";
import { trimHistory } from "../core/history.js";
import { createLoopGuard, recoverHistory, registerToolBatch } from "../core/agent.js";
import {
  isConfigured,
  listModels,
  loadConfig,
  resolveProvider,
  saveConfig,
  streamChat,
} from "../core/providers/index.js";
import { NEEDS_APPROVAL, TOOLS, describeCall, runTool, undoLastChange } from "../core/tools.js";
import { exportChat } from "../core/export.js";
import { listChats, loadChat, loadLatestChat, newChatId, saveChat, type StoredChat } from "../core/chats.js";
import type { Config, EffortLevel, Msg, RoutingConfig, TaskKind, ToolCall } from "../core/types.js";
import { TASK_LABEL, parseModelRef, resolveModelRef, routeTask } from "../core/routing.js";
import { buildRows, sliceRows, type RowColors } from "../ui/rows.js";
import { NEWLINE_MARK, PASTE_BURST_MS, createPasteStore, expandInput, normalizeInput } from "../ui/paste.js";

type ItemContent =
  | { kind: "user" | "assistant" | "info" | "error"; text: string }
  | { kind: "tool"; name: string; desc: string; result: string; ok: boolean };
type Item = ItemContent & { id: number };

type Pending = {
  name: string;
  desc: string;
  resolve: (v: "yes" | "always" | "no") => void;
};

const COMMANDS = [
  { name: "help", desc: "Ver todos los comandos" },
  { name: "settings", desc: "Abrir los ajustes de NebulaCodex" },
  { name: "providers", desc: "Cambiar proveedor, API key y modelo" },
  { name: "model", desc: "Elegir otro modelo de la lista del proveedor" },
  { name: "effort", desc: "Cambiar esfuerzo de razonamiento: /effort <bajo|medio|alto|maximo>" },
  { name: "status", desc: "Ver proveedor, modelo y carpeta activa" },
  { name: "pwd", desc: "Mostrar la carpeta de trabajo actual" },
  { name: "cd", desc: "Cambiar carpeta de trabajo: /cd <ruta>" },
  { name: "files", desc: "Listar archivos de la carpeta actual" },
  { name: "search", desc: "Buscar texto en archivos: /search <texto>" },
  { name: "find", desc: "Buscar archivos por nombre: /find <texto>" },
  { name: "chats", desc: "Listar conversaciones guardadas" },
  { name: "chat", desc: "Buscar y abrir conversaciones guardadas: /chat [búsqueda]" },
  { name: "clear", desc: "Reiniciar la conversación" },
  { name: "tools", desc: "Ver las herramientas del agente y sus permisos" },
  { name: "route", desc: "Ver o configurar el enrutamiento por tarea: /route [on|off|set|clear|principal]" },
  { name: "undo", desc: "Deshacer el último cambio de archivos del agente" },
  { name: "export", desc: "Guardar el chat como Markdown: /export [nombre]" },
  { name: "exit", desc: "Salir de NebulaCodex" },
];

function filterCommands(q: string) {
  const s = q.trim().toLowerCase();
  if (!s) return COMMANDS;
  const starts = COMMANDS.filter((c) => c.name.startsWith(s));
  const rest = COMMANDS.filter(
    (c) => !c.name.startsWith(s) && (c.name.includes(s) || c.desc.toLowerCase().includes(s)),
  );
  return [...starts, ...rest];
}

type ModelUI = null | { status: "loading" } | { status: "ready"; models: string[] };

const ROW_COLORS: RowColors = {
  text: C.text,
  dim: C.dim,
  user: C.cyan,
  assistant: C.magenta,
  tool: C.violet,
  ok: C.green,
  error: C.red,
  code: C.cyan,
  link: C.blue,
};

let nextId = 1;
const MAX_VISIBLE_ITEMS = 500;
const REFERENCE_CONTEXT_TOKENS = 128_000;
const EFFORT_PERCENT: Record<EffortLevel, number> = { low: 25, medium: 50, high: 75, max: 100 };
const EFFORT_LABEL: Record<EffortLevel, string> = { low: "Bajo", medium: "Medio", high: "Alto", max: "Máximo" };

function effortInstruction(effort: EffortLevel): string {
  const instructions: Record<EffortLevel, string> = {
    low: "Usá un esfuerzo de razonamiento bajo: priorizá velocidad y respuestas directas.",
    medium: "Usá un esfuerzo de razonamiento medio: equilibrá rapidez y análisis.",
    high: "Usá un esfuerzo de razonamiento alto: analizá cuidadosamente y verificá los pasos importantes.",
    max: "Usá el máximo esfuerzo de razonamiento disponible para resolver y revisar la tarea con cuidado.",
  };
  return instructions[effort];
}

function estimateTokens(value: string): number {
  // Character-based estimate; the exact tokenizer depends on the selected model.
  return Math.ceil(value.length / 4);
}

function chatTitle(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 30 ? `${normalized.slice(0, 27)}…` : normalized || "Nuevo chat";
}

function itemsFromMessages(messages: Msg[]): Item[] {
  return messages.flatMap<Item>((message) => {
    if (message.role === "user") return [{ id: nextId++, kind: "user" as const, text: message.content }];
    if (message.role === "assistant") return message.content
      ? [{ id: nextId++, kind: "assistant" as const, text: message.content }]
      : [];
    return [{
      id: nextId++,
      kind: "tool" as const,
      name: message.toolName ?? "herramienta",
      desc: "",
      result: message.content,
      ok: !message.content.startsWith("Error:"),
    }];
  });
}

async function generateChatTitle(
  provider: NonNullable<ReturnType<typeof resolveProvider>>,
  prompt: string,
  external?: AbortSignal,
  maxTokens = 512,
): Promise<string> {
  const titlePrompt = [
    "Generá un nombre breve para una conversación de un asistente de programación.",
    "Usá el idioma del mensaje del usuario, máximo 30 caracteres.",
    "Devolvé únicamente el nombre, sin comillas, prefijos ni explicación.",
  ].join(" ");
  let answer = "";
  const controller = new AbortController();
  const cancel = () => controller.abort();
  external?.addEventListener("abort", cancel, { once: true });
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    for await (const event of streamChat(
      provider,
      titlePrompt,
      [{ role: "user", content: prompt.slice(0, 2000) }],
      [],
      controller.signal,
      "low",
      Math.min(maxTokens, 512),
    )) {
      if (event.type === "text") answer += event.text;
    }
  } finally {
    clearTimeout(timeout);
    external?.removeEventListener("abort", cancel);
  }
  const title = answer.replace(/[\r\n"'`]/g, " ").replace(/\s+/g, " ").trim();
  return chatTitle(title || prompt);
}

export function App() {
  const { exit } = useApp();
  const [initialChat] = useState(() => loadLatestChat());
  const initialTitle = initialChat?.title === "Generando título…"
    ? chatTitle(initialChat.messages.find((message) => message.role === "user")?.content ?? "Nuevo chat")
    : initialChat?.title ?? "Nuevo chat";
  const [terminalSize, setTerminalSize] = useState(() => ({
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
  }));
  const [showStartupSplash, setShowStartupSplash] = useState(true);
  const [cfg, setCfg] = useState<Config>(() => {
    const loaded = loadConfig();
    if (loaded.lastDirectory) {
      try {
        process.chdir(loaded.lastDirectory);
      } catch {
        // La carpeta ya no existe: se arranca desde la carpeta actual.
      }
    }
    return loaded;
  });
  const [effort, setEffort] = useState<EffortLevel>(() => cfg.effort ?? "medium");
  const [screen, setScreen] = useState<"chat" | "providers" | "settings">(() => {
    const p = cfg.active ? resolveProvider(cfg, cfg.active) : null;
    return p && isConfigured(p) ? "chat" : "providers";
  });
  const [providersReturnScreen, setProvidersReturnScreen] = useState<"chat" | "settings">("chat");
  const [items, setItems] = useState<Item[]>(() => {
    const restored = itemsFromMessages(initialChat?.messages ?? []);
    if (initialChat) {
      restored.push({
        id: nextId++,
        kind: "info",
        text: `Chat reanudado: ${initialTitle} · ${initialChat.messages.length} mensajes. Usá /clear para empezar uno nuevo o /chats para ver los demás.`,
      });
    }
    return restored;
  });
  const [currentChatName, setCurrentChatName] = useState(initialTitle);
  const chatTitleRef = useRef(initialTitle);
  const [estimatedTokens, setEstimatedTokens] = useState(() => initialChat
    ? estimateTokens(`${SYSTEM_PROMPT(process.cwd())}\n${effortInstruction(effort)}${JSON.stringify(initialChat.messages)}`)
    : 0);
  const [historyScroll, setHistoryScroll] = useState(0);
  const [chatPicker, setChatPicker] = useState<{ chats: StoredChat[]; query: string } | null>(null);
  const [input, setInput] = useState("");
  // Pegado: el valor real del campo, el momento del último cambio y los textos pegados que el campo muestra compactados.
  const inputRef = useRef("");
  inputRef.current = input;
  const lastInputAt = useRef(0);
  const pasteStore = useRef(createPasteStore());
  const [busy, setBusy] = useState(false);
  const [streaming, setStreaming] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [palIdx, setPalIdx] = useState(0);
  const [modelUI, setModelUI] = useState<ModelUI>(null);
  const [allowedTools, setAllowedTools] = useState<string[]>([]);
  const modelReq = useRef(0);
  // Máximo desplazamiento del historial, calculado en el render; los atajos de teclado lo usan para no pasarse.
  const maxScrollRef = useRef(0);

  const history = useRef<Msg[]>(initialChat?.messages ?? []);
  const chatSession = useRef(0);
  const chatId = useRef<string | null>(initialChat?.id ?? null);
  const chatCreatedAt = useRef(initialChat?.createdAt ?? "");
  const titleStarted = useRef(!!initialChat && initialChat.title !== "Generando título…");
  const abortRef = useRef<AbortController | null>(null);
  const titleAbortRef = useRef<AbortController | null>(null);
  // "Allow always" applies only to the selected tool and this app session.
  const alwaysAllow = useRef(new Set<string>());

  const refreshTokenEstimate = (level: EffortLevel = effort) => {
    const system = `${SYSTEM_PROMPT(process.cwd())}\n${effortInstruction(level)}`;
    setEstimatedTokens(estimateTokens(system + JSON.stringify(history.current)));
  };

  useEffect(() => {
    const syncTerminalSize = () => {
      const cols = process.stdout.columns;
      const rows = process.stdout.rows;
      // Windows can briefly report 0×0 while a console window is minimized.
      // Keep the last usable layout until the restored dimensions are available.
      if (cols <= 1 || rows <= 1) return;
      setTerminalSize((current) =>
        current.cols === cols && current.rows === rows ? current : { cols, rows },
      );
    };

    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleTerminalSizeSync = () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(syncTerminalSize, 75);
    };

    process.stdout.on("resize", scheduleTerminalSizeSync);
    // PowerShell and the terminal host may finish sizing the new window just after Node starts.
    const settleTimers = [100, 350, 800].map((delay) => setTimeout(syncTerminalSize, delay));
    return () => {
      process.stdout.off("resize", scheduleTerminalSizeSync);
      if (resizeTimer) clearTimeout(resizeTimer);
      settleTimers.forEach(clearTimeout);
    };
  }, []);

  useEffect(() => {
    const splashTimer = setTimeout(() => setShowStartupSplash(false), 2200);
    return () => clearTimeout(splashTimer);
  }, []);

  useInput(() => setShowStartupSplash(false), { isActive: showStartupSplash });

  const add = useCallback((it: ItemContent) => {
    const item: Item = { ...it, id: nextId++ };
    setItems((prev) => [...prev, item].slice(-MAX_VISIBLE_ITEMS));
    setHistoryScroll(0);
    return item.id;
  }, []);

  const provider = cfg.active ? resolveProvider(cfg, cfg.active) : null;
  const changeEffort = (value: EffortLevel) => {
    const next = { ...cfg, effort: value };
    try {
      saveConfig(next);
      setCfg(next);
      setEffort(value);
      refreshTokenEstimate(value);
      add({ kind: "info", text: `Esfuerzo configurado: ${EFFORT_LABEL[value]} (${EFFORT_PERCENT[value]}%).` });
    } catch (error) {
      add({ kind: "error", text: `No pude guardar el esfuerzo: ${error instanceof Error ? error.message : String(error)}` });
    }
  };

  const changeWorkingDirectory = (directory: string): string | null => {
    if (!directory) return "Ingresá una ruta de carpeta.";
    try {
      process.chdir(directory);
      refreshTokenEstimate();
      const next = { ...cfg, lastDirectory: process.cwd() };
      try {
        saveConfig(next);
        setCfg(next);
      } catch {
        // La carpeta cambió aunque no se haya podido recordar para el próximo inicio.
      }
      return null;
    } catch (error) {
      return `No pude cambiar de carpeta: ${error instanceof Error ? error.message : String(error)}`;
    }
  };

  const updateChatTitle = useCallback((title: string) => {
    chatTitleRef.current = title;
    setCurrentChatName(title);
  }, []);

  const persistChat = (title: string) => {
    if (!chatId.current || !history.current.length) return;
    try {
      const now = new Date().toISOString();
      const storedTitle = title === "Generando título…"
        ? chatTitle(history.current.find((message) => message.role === "user")?.content ?? "Nuevo chat")
        : title;
      saveChat({
        id: chatId.current,
        title: storedTitle,
        messages: history.current,
        createdAt: chatCreatedAt.current || now,
        updatedAt: now,
      });
    } catch (error) {
      add({ kind: "error", text: `No pude guardar el chat: ${error instanceof Error ? error.message : String(error)}` });
    }
  };

  const openStoredChat = (saved: StoredChat) => {
    titleAbortRef.current?.abort();
    titleAbortRef.current = null;
    chatSession.current++;
    persistChat(chatTitleRef.current);
    // Se relee del disco para no compartir el arreglo de mensajes con la caché del buscador.
    const loaded = loadChat(saved.id) ?? saved;
    chatId.current = loaded.id;
    chatCreatedAt.current = loaded.createdAt;
    titleStarted.current = true;
    history.current = loaded.messages;
    updateChatTitle(loaded.title);
    setItems(itemsFromMessages(loaded.messages));
    refreshTokenEstimate();
    setHistoryScroll(0);
    setChatPicker(null);
    // Abrir un chat lo deja como el más reciente, para que se retome al volver a iniciar el programa.
    try {
      saveChat({ ...loaded, updatedAt: new Date().toISOString() });
    } catch {
      // si no se puede guardar, el chat se abre igual
    }
  };

  useInput(
    (_i, key) => {
      if (key.escape) {
        pending?.resolve("no");
        abortRef.current?.abort();
      }
    },
    { isActive: busy && screen === "chat" },
  );

  // Ctrl+C siempre sale (Ink lo maneja por defecto con exitOnCtrlC).

  const runAgent = useCallback(
    async (userText: string) => {
      const decision = routeTask(cfg, userText);
      const runProvider = decision.provider;
      if (!runProvider || !isConfigured(runProvider)) {
        setScreen("providers");
        return;
      }
      const ac = new AbortController();
      abortRef.current = ac;
      setBusy(true);
      const addRunItem = (item: ItemContent) => add(item);
      if (!chatId.current) {
        chatId.current = newChatId();
        chatCreatedAt.current = new Date().toISOString();
      }
      history.current = trimHistory(history.current);
      const historyStart = history.current.length;
      const sessionId = chatSession.current;
      const shouldGenerateTitle = !titleStarted.current;
      const titlePrompt = history.current.find((message) => message.role === "user")?.content ?? userText;
      // El enrutamiento puede mandar una tarea concreta a otro modelo; avisarlo sin ensuciar el historial.
      if (decision.source === "task" && decision.ref) {
        addRunItem({
          kind: "info",
          text: `Enrutado (${TASK_LABEL[decision.task]}): ${runProvider.label} · ${decision.ref.model}`,
        });
      }
      if (shouldGenerateTitle) {
        titleStarted.current = true;
        updateChatTitle("Generando título…");
      }
      let partialResponse = "";
      let committedText = "";
      let conversationCompleted = false;
      history.current.push({ role: "user", content: userText });
      const system = `${SYSTEM_PROMPT(process.cwd())}\n${effortInstruction(effort)}`;
      persistChat(shouldGenerateTitle ? chatTitle(titlePrompt) : chatTitleRef.current);

      try {
        let reachedTurnLimit = true;
        const guard = createLoopGuard();
        for (let turn = 0; turn < 30; turn++) {
          let text = "";
          let toolCalls: ToolCall[] = [];
          let lastStreamPaint = 0;
          partialResponse = "";
          committedText = "";
          setStreaming("");
          for await (const ev of streamChat(
            runProvider,
            system,
            history.current,
            TOOLS,
            ac.signal,
            effort,
            cfg.maxOutputTokens ?? (runProvider.kind === "anthropic" ? 8192 : 4096),
          )) {
            if (ev.type === "text") {
              text += ev.text;
              partialResponse = text;
              // Repintar como máximo cada 50 ms: parsear y envolver el Markdown completo en cada
              // delta de SSE saturaba la CPU en respuestas largas.
              const now = performance.now();
              if (now - lastStreamPaint >= 50) {
                lastStreamPaint = now;
                setStreaming(text);
              }
            } else {
              toolCalls = ev.toolCalls;
            }
          }
          setStreaming("");
          if (!text.trim() && !toolCalls.length) {
            throw new Error("El proveedor devolvió una respuesta vacía.");
          }
          if (text.trim()) {
            addRunItem({ kind: "assistant", text: text.trim() });
            committedText = text.trim();
          }

          const repeated = registerToolBatch(guard, toolCalls);
          if (repeated.repeated) {
            const notice = `Detuve el bucle: el modelo repitió ${repeated.repeats} veces la misma acción (${toolCalls
              .map((call) => call.name)
              .join(", ")}). Revisá el resultado antes de continuar.`;
            // No se ejecutan las herramientas repetidas; se cierra el turno con el aviso para no dejar
            // llamadas `tool_use` sin resultado en el historial.
            const content = [text.trim(), notice].filter(Boolean).join("\n\n");
            history.current.push({ role: "assistant", content });
            addRunItem({ kind: "info", text: notice });
            persistChat(chatTitleRef.current);
            reachedTurnLimit = false;
            conversationCompleted = true;
            break;
          }

          if (text.trim() || toolCalls.length) {
            history.current.push({ role: "assistant", content: text, toolCalls });
            persistChat(chatTitleRef.current);
          }
          if (!toolCalls.length) {
            reachedTurnLimit = false;
            break;
          }

          for (const tc of toolCalls) {
            const desc = describeCall(tc.name, tc.args);
            let allowed = true;
            if (NEEDS_APPROVAL.has(tc.name) && !alwaysAllow.current.has(tc.name)) {
              const answer = await new Promise<"yes" | "always" | "no">((resolve) =>
                setPending({ name: tc.name, desc, resolve }),
              );
              setPending(null);
              if (answer === "always") {
                alwaysAllow.current.add(tc.name);
                setAllowedTools([...alwaysAllow.current]);
              }
              allowed = answer !== "no";
            }
            const result = allowed
              ? await runTool(tc.name, tc.args, ac.signal)
              : "El usuario rechazó esta acción.";
            addRunItem({
              kind: "tool",
              name: tc.name,
              desc,
              result,
              ok: allowed && !result.startsWith("Error"),
            });
            history.current.push({
              role: "tool",
              content: result,
              toolCallId: tc.id,
              toolName: tc.name,
            });
            persistChat(chatTitleRef.current);
            if (ac.signal.aborted) {
              throw new DOMException("La operación fue detenida.", "AbortError");
            }
          }
        }
        if (reachedTurnLimit) {
          const notice = "Alcancé el límite de 30 pasos de herramientas. Podés pedirme que continúe.";
          addRunItem({ kind: "info", text: notice });
          history.current.push({ role: "assistant", content: notice });
        }
        conversationCompleted = true;
      } catch (e: any) {
        setStreaming("");
        const stopped = e?.name === "AbortError" || ac.signal.aborted;
        const partial = partialResponse.trim();
        const partialNotShown = stopped && partial.length > 0 && partial !== committedText;
        // Se conservan los turnos completos y se cierran las herramientas pendientes. Antes se borraba
        // todo el turno, así que el modelo podía repetir cambios que ya estaban aplicados en disco.
        const recoveryMessage = stopped
          ? `${partialNotShown ? `${partial}\n\n` : ""}[Respuesta detenida; pedime que continúe.]`
          : `[No se pudo completar esta solicitud: ${e?.message ?? String(e)}]`;
        history.current = recoverHistory(history.current, historyStart, recoveryMessage);
        if (partialNotShown) addRunItem({ kind: "assistant", text: partial });
        if (stopped) {
          addRunItem({
            kind: "info",
            text: "Detenido. Las acciones que ya terminaron pueden haber quedado aplicadas.",
          });
        } else {
          addRunItem({ kind: "error", text: e?.message ?? String(e) });
        }
      } finally {
        setEstimatedTokens(estimateTokens(system + JSON.stringify(history.current)));
        persistChat(shouldGenerateTitle ? chatTitle(titlePrompt) : chatTitleRef.current);
        if (shouldGenerateTitle) {
          const fallbackTitle = chatTitle(titlePrompt);
          if (conversationCompleted) {
            const titleController = new AbortController();
            titleAbortRef.current = titleController;
            void generateChatTitle(runProvider, titlePrompt.slice(0, 2000), titleController.signal)
              .then((title) => {
                if (chatSession.current === sessionId) {
                  updateChatTitle(title);
                  persistChat(title);
                }
              })
              .catch(() => {
                if (chatSession.current === sessionId && !titleController.signal.aborted) {
                  updateChatTitle(fallbackTitle);
                  persistChat(fallbackTitle);
                }
              })
              .finally(() => {
                if (titleAbortRef.current === titleController) titleAbortRef.current = null;
              });
          } else {
            updateChatTitle(fallbackTitle);
            persistChat(fallbackTitle);
          }
        }
        setBusy(false);
        setPending(null);
        if (abortRef.current === ac) abortRef.current = null;
      }
    },
    [provider, add, effort, updateChatTitle, cfg],
  );

  const saveModel = (name: string) => {
    if (!provider) return;
    const modelName = name.trim();
    if (!modelName) {
      add({ kind: "error", text: "El nombre del modelo no puede estar vacío." });
      return;
    }
    const next: Config = {
      ...cfg,
      providers: {
        ...cfg.providers,
        [provider.id]: { ...cfg.providers[provider.id], model: modelName },
      },
    };
    try {
      saveConfig(next);
      setCfg(next);
      add({ kind: "info", text: `Modelo cambiado a ${modelName}` });
    } catch (e: any) {
      add({ kind: "error", text: `No pude guardar el modelo: ${e?.message ?? String(e)}` });
    }
  };

  const saveRouting = (routing: RoutingConfig | undefined): string | null => {
    const next: Config = { ...cfg };
    if (routing) next.routing = routing;
    else delete next.routing;
    try {
      saveConfig(next);
      setCfg(next);
      return null;
    } catch (error) {
      return `No pude guardar el enrutamiento: ${error instanceof Error ? error.message : String(error)}`;
    }
  };

  const routingStatus = (routing: RoutingConfig | undefined = cfg.routing): string => {
    if (!routing) return "Enrutamiento desactivado (el proveedor activo atiende todo). Usá /route on para activarlo.";
    const lines = [`Enrutamiento ${routing.enabled ? "activado" : "desactivado"}.`];
    lines.push(
      routing.principal
        ? `Principal: ${routing.principal.provider}/${routing.principal.model}`
        : "Principal: (sin definir; se usa el proveedor activo como respaldo)",
    );
    const tasks = Object.entries(routing.tasks ?? {});
    if (tasks.length) {
      for (const [task, ref] of tasks) {
        lines.push(`${TASK_LABEL[task as TaskKind] ?? task}: ${ref.provider}/${ref.model}`);
      }
    } else {
      lines.push("Sin modelos específicos por tarea.");
    }
    return lines.join("\n");
  };

  const runCommand = (cmd: string, arg: string) => {
    switch (cmd) {
      case "exit":
        exit();
        return;
      case "providers":
        setProvidersReturnScreen("chat");
        setScreen("providers");
        return;
      case "settings":
        setScreen("settings");
        return;
      case "effort": {
        const value = arg.trim().toLocaleLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
        const choices: Record<string, EffortLevel> = {
          low: "low", bajo: "low",
          medium: "medium", medio: "medium",
          high: "high", alto: "high",
          max: "max", maximo: "max",
        };
        if (!value) {
          add({ kind: "info", text: `Esfuerzo actual: ${EFFORT_LABEL[effort]} (${EFFORT_PERCENT[effort]}%). Uso: /effort <bajo|medio|alto|maximo>` });
          return;
        }
        const selected = choices[value];
        if (!selected) {
          add({ kind: "error", text: "Nivel inválido. Elegí bajo, medio, alto o maximo con /effort <nivel>." });
          return;
        }
        changeEffort(selected);
        return;
      }
      case "pwd":
        add({ kind: "info", text: process.cwd() });
        return;
      case "status":
        add({
          kind: "info",
          text: `Proveedor: ${provider?.label ?? "sin configurar"} · Modelo: ${provider?.model ?? "—"}\nCarpeta activa: ${process.cwd()}`,
        });
        return;
      case "route": {
        const parts = arg.trim().split(/\s+/).filter(Boolean);
        const action = (parts.shift() ?? "status").toLocaleLowerCase();
        const current: RoutingConfig = cfg.routing ?? { enabled: false };
        if (action === "status") {
          add({ kind: "info", text: routingStatus() });
          return;
        }
        if (action === "on" || action === "off") {
          const next: RoutingConfig = { ...current, enabled: action === "on" };
          const error = saveRouting(next);
          add(error ? { kind: "error", text: error } : { kind: "info", text: routingStatus(next) });
          return;
        }
        if (action === "reset") {
          const error = saveRouting(undefined);
          add(error ? { kind: "error", text: error } : { kind: "info", text: routingStatus(undefined) });
          return;
        }
        if (action === "principal" || action === "set") {
          const task = action === "set" ? (parts.shift() ?? "") as TaskKind : "principal";
          const tasks = Object.keys(TASK_LABEL).filter((name) => name !== "principal");
          if (action === "set" && !tasks.includes(task)) {
            add({ kind: "error", text: `Tarea inválida. Opciones: ${tasks.join(", ")}.` });
            return;
          }
          const value = parts.join(" ");
          const ref = parseModelRef(value);
          if (!ref) {
            add({ kind: "error", text: "Uso: /route set <tarea> <proveedor/modelo> · /route principal <proveedor/modelo>" });
            return;
          }
          const resolved = resolveModelRef(cfg, ref);
          if (!resolved || !isConfigured(resolved)) {
            add({ kind: "error", text: `No puedo usar ${ref.provider}/${ref.model}: revisá el proveedor, la key y la URL.` });
            return;
          }
          const next: RoutingConfig = { ...current };
          if (action === "principal") next.principal = ref;
          else next.tasks = { ...(current.tasks ?? {}), [task]: ref };
          const error = saveRouting(next);
          add({
            kind: error ? "error" : "info",
            text: error ?? `${TASK_LABEL[task]} → ${ref.provider}/${ref.model}\n${routingStatus(next)}`,
          });
          return;
        }
        if (action === "clear") {
          const task = (parts.shift() ?? "") as TaskKind;
          if (!(task in TASK_LABEL) || task === "principal") {
            add({ kind: "error", text: "Uso: /route clear <tarea>" });
            return;
          }
          const tasks = { ...(current.tasks ?? {}) };
          delete tasks[task];
          const next: RoutingConfig = { ...current, tasks };
          const error = saveRouting(next);
          add(error ? { kind: "error", text: error } : { kind: "info", text: routingStatus(next) });
          return;
        }
        add({
          kind: "info",
          text: "Uso: /route [status|on|off|reset] · /route principal <proveedor/modelo> · /route set <tarea> <proveedor/modelo> · /route clear <tarea>",
        });
        return;
      }
      case "cd":
        if (!arg) {
          add({ kind: "error", text: "Uso: /cd <ruta>" });
          return;
        }
        {
          const error = changeWorkingDirectory(arg);
          add(error
            ? { kind: "error", text: error }
            : { kind: "info", text: `Carpeta de trabajo: ${process.cwd()}` });
        }
        return;
      case "files":
        void runTool("list_dir", { path: "." }).then((listing) => {
          if (listing.startsWith("Error:")) {
            add({ kind: "error", text: listing });
            return;
          }
          const allEntries = listing.split("\n").filter(Boolean);
          const truncated = allEntries.at(-1)?.startsWith("… se muestran los primeros ") ?? false;
          const entries = truncated ? allEntries.slice(0, -1) : allEntries;
          const preview = entries.slice(0, 40);
          const remaining = Math.max(0, entries.length - 40);
          if (!preview.length) add({ kind: "info", text: "(carpeta vacía)" });
          else for (const entry of preview) add({ kind: "info", text: entry });
          if (remaining) add({ kind: "info", text: `… y ${remaining} elementos listados más` });
          if (truncated) add({ kind: "info", text: "La carpeta contiene más elementos; se muestran hasta 500." });
        });
        return;
      case "search":
      case "find": {
        if (!arg.trim()) {
          add({ kind: "error", text: `Uso: /${cmd} <texto>` });
          return;
        }
        const tool = cmd === "search" ? "search_text" : "find_files";
        void runTool(tool, { path: ".", query: arg.trim() }).then((result) => {
          const kind = result.startsWith("Error:") ? "error" : "info";
          for (const line of result.split(/\r?\n/)) add({ kind, text: line });
        }).catch((error: unknown) => {
          add({ kind: "error", text: `Falló /${cmd}: ${error instanceof Error ? error.message : String(error)}` });
        });
        return;
      }
      case "chats": {
        const saved = listChats();
        if (!saved.length) {
          add({ kind: "info", text: "Todavía no hay chats guardados." });
          return;
        }
        for (const chat of saved.slice(0, 15)) {
          add({ kind: "info", text: `${chat.title} · ${chat.id}` });
        }
        if (saved.length > 15) add({ kind: "info", text: `… y ${saved.length - 15} chats más; usá /chat para buscar.` });
        add({ kind: "info", text: "Usá /chat <id> para abrir una conversación · ↑/↓ para recorrer la lista." });
        return;
      }
      case "chat": {
        const savedChats = listChats();
        if (!savedChats.length) {
          add({ kind: "info", text: "Todavía no hay chats guardados." });
          return;
        }
        const query = arg.trim();
        if (/^[a-f0-9-]{36}$/i.test(query)) {
          const saved = loadChat(query);
          if (saved) {
            openStoredChat(saved);
            return;
          }
        }
        setChatPicker({ chats: savedChats, query });
        return;
      }
      case "undo": {
        const result = undoLastChange();
        add({ kind: result.startsWith("Error:") ? "error" : "info", text: result });
        return;
      }
      case "tools":
        for (const tool of TOOLS) {
          const permission = !NEEDS_APPROVAL.has(tool.name)
            ? "libre"
            : alwaysAllow.current.has(tool.name)
              ? "permitida en esta sesión"
              : "pide permiso";
          add({ kind: "info", text: `${tool.name} — ${permission}` });
        }
        return;
      case "export": {
        try {
          const title = chatTitleRef.current === "Generando título…" ? "Chat" : chatTitleRef.current;
          const file = exportChat(title, history.current, process.cwd(), arg);
          add({ kind: "info", text: `Chat exportado: ${file}` });
        } catch (error) {
          add({ kind: "error", text: error instanceof Error ? error.message : String(error) });
        }
        return;
      }
      case "clear":
        // Reinicia la conversación y el historial visible.
        titleAbortRef.current?.abort();
        titleAbortRef.current = null;
        chatSession.current++;
        titleStarted.current = false;
        history.current = [];
        chatId.current = null;
        chatCreatedAt.current = "";
        updateChatTitle("Nuevo chat");
        setEstimatedTokens(0);
        alwaysAllow.current.clear();
        setAllowedTools([]);
        setItems([]);
        setHistoryScroll(0);
        return;
      case "model": {
        if (!provider) return;
        if (arg) {
          saveModel(arg);
          return;
        }
        const id = ++modelReq.current;
        setModelUI({ status: "loading" });
        listModels(provider)
          .then((list) => {
            if (modelReq.current !== id) return;
            if (!list.length) {
              setModelUI(null);
              add({ kind: "error", text: "El proveedor no devolvió modelos disponibles. Podés usar /model <nombre>." });
              return;
            }
            setModelUI({ status: "ready", models: list });
          })
          .catch((e: any) => {
            if (modelReq.current !== id) return;
            setModelUI(null);
            add({
              kind: "error",
              text: `No pude traer los modelos: ${e.message}. Podés usar /model <nombre>`,
            });
          });
        return;
      }
      case "help":
        for (const command of COMMANDS) {
          add({ kind: "info", text: `/${command.name} — ${command.desc}` });
        }
        add({ kind: "info", text: "Esc — Detener la respuesta · ↑/↓ para recorrer el historial" });
        return;
      default:
        add({ kind: "error", text: `Comando desconocido: /${cmd}. Escribí / para ver la lista` });
    }
  };

  // Paleta de comandos: aparece apenas escribís "/"
  const paletteOpen = !busy && !modelUI && !pending && !chatPicker && input.startsWith("/") && !input.includes(" ");
  const matches = paletteOpen ? filterCommands(input.slice(1)) : [];
  const palSafe = Math.min(palIdx, Math.max(0, matches.length - 1));
  const paletteStart = Math.min(Math.max(0, palSafe - 2), Math.max(0, matches.length - 5));
  const paletteMatches = matches.slice(paletteStart, paletteStart + 5);

  useInput(
    (_i, key) => {
      if (key.upArrow) setPalIdx((i) => (i + matches.length - 1) % matches.length);
      else if (key.downArrow) setPalIdx((i) => (i + 1) % matches.length);
      else if (key.tab) {
        const m = matches[palSafe];
        if (m) setInput("/" + m.name + " ");
      } else if (key.escape) setInput("");
    },
    { isActive: paletteOpen && matches.length > 0 && screen === "chat" },
  );

  useInput(
    (_input, key) => {
      const page = Math.max(3, Math.max(4, Math.max(1, terminalSize.rows - 2) - 11) - 1);
      if (key.upArrow) setHistoryScroll((offset) => Math.min(maxScrollRef.current, offset + 1));
      else if (key.downArrow) setHistoryScroll((offset) => Math.max(0, offset - 1));
      else if (key.pageUp) setHistoryScroll((offset) => Math.min(maxScrollRef.current, offset + page));
      else if (key.pageDown) setHistoryScroll((offset) => Math.max(0, offset - page));
    },
    { isActive: screen === "chat" && !paletteOpen && !modelUI && !pending && !chatPicker },
  );

  useInput(
    (_i, key) => {
      if (key.escape) {
        modelReq.current++;
        setModelUI(null);
      }
    },
    { isActive: !!modelUI && screen === "chat" },
  );

  const onSubmit = () => {
    if (busy) return;
    const value = inputRef.current;
    if (value && Date.now() - lastInputAt.current < PASTE_BURST_MS) {
      // Este Enter llegó pegado al texto (algunas terminales envían cada línea pegada como tecla aparte):
      // es un salto de línea del pegado, no un envío.
      const next = value + NEWLINE_MARK;
      inputRef.current = next;
      lastInputAt.current = Date.now();
      setInput(next);
      return;
    }
    if (paletteOpen && matches.length > 0) {
      setInput("");
      inputRef.current = "";
      runCommand(matches[palSafe].name, "");
      return;
    }
    const v = expandInput(value, pasteStore.current).trim();
    pasteStore.current = createPasteStore();
    setInput("");
    inputRef.current = "";
    if (!v) return;
    if (v.startsWith("/")) {
      const [cmd, ...rest] = v.slice(1).split(" ");
      runCommand(cmd, rest.join(" ").trim());
      return;
    }
    add({ kind: "user", text: v });
    void runAgent(v);
  };

  const { cols, rows } = terminalSize;
  // Keep a one-column and two-row margin so terminal autowrap cannot clip the panel's right border.
  const viewCols = Math.max(1, cols - 1);
  const viewRows = Math.max(1, rows - 2);
  const showSidebar = viewCols >= 104;
  const sidebarWidth = 32;
  const historyRows = Math.max(4, viewRows - 11);
  const overlayOpen = paletteOpen || !!modelUI || !!pending || !!chatPicker;
  const historyWidth = Math.max(8, (showSidebar ? viewCols - sidebarWidth : viewCols) - 4);
  // Se cachean las filas de los mensajes ya completados. Antes cada token del stream volvía a
  // envolver todo el historial, que se nota mucho en conversaciones largas.
  const itemRows = useMemo(
    () => (screen === "chat" ? buildRows(items, historyWidth, ROW_COLORS) : []),
    [items, historyWidth, screen],
  );
  const liveRows = useMemo(
    () => (streaming && screen === "chat"
      ? buildRows([{ kind: "assistant" as const, text: streaming }], historyWidth, ROW_COLORS)
      : []),
    [streaming, historyWidth, screen],
  );
  const allRows = useMemo(() => {
    if (!liveRows.length) return itemRows;
    const separator = itemRows.length
      ? [{ prefix: "", prefixColor: C.dim, text: " ", color: C.dim, bold: false, spans: [{ text: " " }] }]
      : [];
    return [...itemRows, ...separator, ...liveRows];
  }, [itemRows, liveRows]);

  if (showStartupSplash) {
    const splashCols = Math.max(1, terminalSize.cols - 1);
    const splashRows = Math.max(1, terminalSize.rows - 2);
    return (
      <Box
        flexDirection="column"
        alignItems="center"
        justifyContent="center"
        width={splashCols}
        height={splashRows}
      >
        <Text>{banner(splashCols)}</Text>
        <Box marginTop={1}>
          <Text>{aurora("✦ codex libre · cualquier modelo, cualquier proveedor ✦")}</Text>
        </Box>
        <Box marginTop={1}>
          <Text color={C.dim}>Iniciando NebulaCodex…</Text>
        </Box>
      </Box>
    );
  }

  if (screen === "providers") {
    return (
      <ProvidersScreen
        cfg={cfg}
        canClose={providersReturnScreen === "settings" || (!!provider && isConfigured(provider))}
        onClose={() => setScreen(providersReturnScreen)}
        onSave={(c) => {
          setCfg(c);
          setScreen(providersReturnScreen);
          const p = resolveProvider(c, c.active);
          if (p) add({ kind: "info", text: `Usando ${p.label} · ${p.model}` });
        }}
      />
    );
  }

  if (screen === "settings") {
    return (
      <SettingsScreen
        provider={provider?.label ?? "Sin proveedor"}
        model={provider?.model ?? "—"}
        effort={effort}
        workingDirectory={process.cwd()}
        allowedTools={allowedTools}
        onOpenProviders={() => {
          setProvidersReturnScreen("settings");
          setScreen("providers");
        }}
        onEffortChange={changeEffort}
        onDirectoryChange={changeWorkingDirectory}
        onResetPermissions={() => {
          alwaysAllow.current.clear();
          setAllowedTools([]);
        }}
        onClose={() => setScreen("chat")}
      />
    );
  }

  const view = sliceRows(allRows, historyRows, historyScroll);
  maxScrollRef.current = view.maxScroll;
  const visibleRows = overlayOpen ? [] : view.visible;
  const showHistoryScrollbar = viewRows > 6 && view.maxScroll > 0 && !overlayOpen;
  const scrollbarHeight = Math.max(1, viewRows - 4);
  const scrollbarThumbHeight = Math.min(
    scrollbarHeight,
    Math.max(1, Math.round((scrollbarHeight * historyRows) / Math.max(1, allRows.length))),
  );
  const scrollProgress = view.maxScroll > 0 ? view.scroll / view.maxScroll : 0;
  const scrollbarThumbTop = Math.round((scrollbarHeight - scrollbarThumbHeight) * (1 - scrollProgress));

  return (
    <Box flexDirection="row" width={viewCols} height={viewRows}>
      <Box
        flexDirection="column"
        width={showSidebar ? viewCols - sidebarWidth - 1 : viewCols}
        height={viewRows}
        flexShrink={0}
      >
        <Box flexDirection="column" flexGrow={1} paddingTop={1} position="relative">
          {!overlayOpen && view.scroll < view.maxScroll && (
            <Text color={C.dim}>↑ / RePág · mensajes anteriores</Text>
          )}
          <Box flexDirection="column" paddingX={1}>
            {visibleRows.map((row, index) => (
              <Text key={index}>
                <Text color={row.prefixColor}>{row.prefix}</Text>
                {row.spans.map((span, spanIndex) => (
                  <Text
                    key={spanIndex}
                    color={span.color ?? row.color}
                    bold={span.bold ?? row.bold}
                    italic={span.italic}
                    underline={span.underline}
                    strikethrough={span.strikethrough}
                    dimColor={span.dimColor}
                  >
                    {span.text}
                  </Text>
                ))}
              </Text>
            ))}
          </Box>
          {!overlayOpen && view.scroll > 0 && <Text color={C.dim}>↓ / AvPág · mensajes recientes</Text>}
          {busy && !pending && !streaming ? (
            <Box paddingX={1} marginTop={1}>
              <Spinner label="pensando… (Esc para detener)" />
            </Box>
          ) : null}
          {showHistoryScrollbar && (
            <Box position="absolute" alignSelf="flex-end" flexDirection="column" width={1} height={scrollbarHeight}>
              {Array.from({ length: scrollbarHeight }, (_, row) => (
                <Text key={row} color={row >= scrollbarThumbTop && row < scrollbarThumbTop + scrollbarThumbHeight ? C.violet : C.dim}>
                  {row >= scrollbarThumbTop && row < scrollbarThumbTop + scrollbarThumbHeight ? "█" : "│"}
                </Text>
              ))}
            </Box>
          )}
        </Box>

      {pending ? (
        <Approval
          name={pending.name}
          desc={pending.desc}
          onAnswer={(v) => pending.resolve(v)}
        />
      ) : modelUI ? (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={C.border}
          paddingX={1}
          marginTop={1}
        >
          <Text color={C.violet} bold>
            Modelos de {provider?.label}
          </Text>
          {modelUI.status === "loading" ? (
            <Spinner label="buscando modelos…" />
          ) : (
            <ModelPicker
              models={modelUI.models}
              current={provider?.model ?? ""}
              onPick={(m) => {
                setModelUI(null);
                saveModel(m);
              }}
            />
          )}
          <Text color={C.dim}>Escribí para buscar · ↑↓ elegir · Enter confirma · Esc cancela</Text>
        </Box>
      ) : chatPicker ? (
        <ChatPicker
          chats={chatPicker.chats}
          initialQuery={chatPicker.query}
          onPick={openStoredChat}
          onClose={() => setChatPicker(null)}
        />
      ) : (
        <>
          {paletteOpen && matches.length > 0 && (
            <Box
              flexDirection="column"
              borderStyle="round"
              borderColor={C.border}
              paddingX={1}
              marginTop={1}
            >
              {paletteMatches.map((c) => (
                <Text key={c.name} color={matches.indexOf(c) === palSafe ? C.magenta : C.dim} bold={matches.indexOf(c) === palSafe}>
                  {matches.indexOf(c) === palSafe ? "❯ " : "  "}/{c.name.padEnd(10)}
                  <Text color={C.dim} bold={false}>
                    {" "}
                    {c.desc}
                  </Text>
                </Text>
              ))}
              <Text color={C.dim}>↑↓ elegir · Tab completa · Enter ejecuta · Esc cierra ({paletteStart + 1}-{Math.min(paletteStart + paletteMatches.length, matches.length)}/{matches.length})</Text>
            </Box>
          )}
          <Box
            borderStyle="round"
            borderColor={busy ? C.dim : C.border}
            paddingX={1}
            marginTop={paletteOpen && matches.length > 0 ? 0 : 1}
          >
            <Text color={C.magenta}>❯ </Text>
            <TextInput
              value={input}
              onChange={(v) => {
                const next = normalizeInput(inputRef.current, v, pasteStore.current);
                inputRef.current = next;
                lastInputAt.current = Date.now();
                setInput(next);
                setPalIdx(0);
              }}
              onSubmit={onSubmit}
              focus={!busy}
              placeholder={busy ? "esperando…" : "Escribí tu pedido o / para ver los comandos"}
            />
          </Box>
        </>
      )}

      </Box>
      {showSidebar && (
        <Box
          flexDirection="column"
          width={sidebarWidth}
          height={viewRows}
          borderStyle="round"
          borderColor={C.border}
          paddingX={1}
          marginLeft={1}
          flexShrink={0}
        >
          <Box flexDirection="column" alignItems="center" marginBottom={1}>
            <Text>{compactBanner(sidebarWidth - 4)}</Text>
          </Box>
          <Text color={C.violet} bold>IA ACTIVA</Text>
          <Text color={C.cyan}>{provider?.label ?? "Sin proveedor"}</Text>
          <Text color={C.dim}>{provider?.model ?? "Configura un modelo"}</Text>
          <Box marginTop={1} flexDirection="column">
            <Text color={C.violet} bold>CHAT</Text>
            <Text color={C.text}>{fitLines(currentChatName, sidebarWidth - 4, 2)}</Text>
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Text color={C.violet} bold>TOKENS DEL CHAT</Text>
            <Text color={C.text}>≈ {estimatedTokens.toLocaleString("es-AR")}</Text>
            <Text color={C.dim}>{Math.min(100, (estimatedTokens / REFERENCE_CONTEXT_TOKENS) * 100).toFixed(1)}% de 128k*</Text>
            <Text color={C.dim}>*Estimación por texto</Text>
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Text color={C.violet} bold>ESFUERZO DE IA</Text>
            <Text color={C.text}>{EFFORT_LABEL[effort]} · {EFFORT_PERCENT[effort]}%</Text>
            <Text>
              <Text color={C.green}>{"█".repeat(Math.round(EFFORT_PERCENT[effort] / 10))}</Text>
              <Text color={C.dim}>{"░".repeat(10 - Math.round(EFFORT_PERCENT[effort] / 10))}</Text>
            </Text>
            <Text color={C.dim}>/effort &lt;nivel&gt;</Text>
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Text color={C.violet} bold>CARPETA ACTIVA</Text>
            <Text color={C.text}>{process.cwd()}</Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}

function fitLines(value: string, width: number, maxLines: number) {
  const out: string[] = [];
  const limit = Math.max(8, width);
  for (const source of value.split(/\r?\n/)) {
    let line = source.trimEnd();
    while (line.length > limit) {
      let cut = line.lastIndexOf(" ", limit);
      if (cut < 1) cut = limit;
      out.push(line.slice(0, cut));
      line = line.slice(cut).trimStart();
      if (out.length >= maxLines) return out.join("\n");
    }
    out.push(line);
    if (out.length >= maxLines) return out.join("\n");
  }
  return out.join("\n");
}
