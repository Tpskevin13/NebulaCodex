#!/usr/bin/env node
import fs from "node:fs";
import { render } from "ink";
import { App } from "./app/App.js";
import { handleCliArgs } from "./cli.js";
import { enableLineDiff } from "./ui/line-diff.js";
import { createAltScreen } from "./ui/screen.js";

function readVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "desconocida";
  } catch {
    return "desconocida";
  }
}

// `--version` y `--help` se responden antes de tocar la terminal: sirven para verificar una instalación sin abrir la interfaz.
const cli = handleCliArgs(process.argv.slice(2), readVersion());
if (cli) {
  try {
    fs.writeSync(1, `${cli.output}\n`);
  } catch {
    console.log(cli.output);
  }
  process.exit(cli.exitCode);
}

if (!process.stdin.isTTY) {
  console.error("NebulaCodex necesita una terminal interactiva.");
  process.exit(1);
}

// Se trabaja en la pantalla alternativa: no hay historial que se ensucie al maximizar, minimizar o redimensionar
// y, al salir, la terminal vuelve a como estaba. (Antes se borraba todo el historial de la terminal al iniciar.)
const screen = createAltScreen(
  (text) => process.stdout.write(text),
  (text) => fs.writeSync(process.stdout.fd, text),
);
if (process.stdout.isTTY) screen.enter();

process.on("exit", () => screen.leave());
for (const signal of ["SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    screen.leave();
    process.exit(0);
  });
}
// Un error inesperado se muestra después de salir de la pantalla alternativa; si no, se perdería junto con ella.
const crash = (error: unknown) => {
  screen.leave();
  console.error(error);
  process.exit(1);
};
process.on("uncaughtException", crash);
process.on("unhandledRejection", crash);

enableLineDiff(process.stdout);
render(<App />);
