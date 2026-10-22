export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, any>;
}

export interface Msg {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolName?: string;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, any>; // JSON schema
}

export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "done"; toolCalls: ToolCall[] };

export type ProviderKind = "openai" | "anthropic";

export interface ProviderPreset {
  id: string;
  label: string;
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  needsKey: boolean;
  envKey?: string;
  hint: string;
  /** Some providers need a deployment-specific URL instead of a fixed global endpoint. */
  customBaseUrl?: boolean;
  /** Header used for the key when the provider does not accept Bearer auth. */
  authHeader?: "authorization" | "api-key";
}

export interface ProviderSettings {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}

export type EffortLevel = "low" | "medium" | "high" | "max";

/** Capacidades que el enrutador puede asignar a un modelo distinto del principal. */
export type TaskKind =
  | "principal"
  | "code"
  | "refactor"
  | "debug"
  | "docs"
  | "chat"
  | "reasoning"
  | "vision"
  | "three_d"
  | "image"
  | "fast";

/** Referencia serializable a un modelo de un proveedor concreto. */
export interface ModelRef {
  provider: string;
  model: string;
}

export interface RoutingConfig {
  /** Desactivado por defecto: el modelo activo sigue siendo el único usado. */
  enabled: boolean;
  /** Modelo orquestador; también es el respaldo cuando una tarea no tiene modelo propio. */
  principal?: ModelRef;
  tasks?: Partial<Record<TaskKind, ModelRef>>;
}

export interface Config {
  active: string;
  providers: Record<string, ProviderSettings>;
  effort?: EffortLevel;
  /** Tope de tokens de salida por respuesta; evita que un proveedor reserve el máximo del modelo. */
  maxOutputTokens?: number;
  routing?: RoutingConfig;
  /** Última carpeta de trabajo, para retomarla al volver a abrir. */
  lastDirectory?: string;
}

export interface ResolvedProvider extends ProviderPreset {
  apiKey: string;
}
