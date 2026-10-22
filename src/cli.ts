/** Opciones de línea de comandos que se resuelven sin abrir la interfaz (`--version`, `--help`). */
export interface CliResult {
  output: string;
  exitCode: number;
}

const HELP = `NebulaCodex {version} — agente de código libre para la terminal

Uso:
  nebulacodex            Abre la aplicación en la carpeta actual
  nebulacodex --version  Muestra la versión
  nebulacodex --help     Muestra esta ayuda

La configuración (proveedores, API keys, modelos) se hace dentro de la app con /providers.
Se guarda en ~/.nebulacodex/config.json.`;

/** Devuelve el texto a imprimir y el código de salida, o `null` si hay que abrir la app normalmente. */
export function handleCliArgs(argv: readonly string[], version: string): CliResult | null {
  if (argv.includes("--version") || argv.includes("-v")) {
    return { output: `NebulaCodex ${version}`, exitCode: 0 };
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    return { output: HELP.replace("{version}", version), exitCode: 0 };
  }
  return null;
}
