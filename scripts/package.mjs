#!/usr/bin/env node
// Empaqueta NebulaCodex en instaladores autónomos (incluyen su propio Node.js).
//
//   npm ci && npm run build
//   node scripts/package.mjs --target linux-x64      -> release/NebulaCodex-<v>-linux-x64.sh
//   node scripts/package.mjs --target linux-arm64    -> release/NebulaCodex-<v>-linux-arm64.sh
//   node scripts/package.mjs --target macos          -> release/NebulaCodex-<v>-macos.dmg        (hay que correrlo en macOS)
//   node scripts/package.mjs --target windows-x64    -> release/NebulaCodex-<v>-windows-x64-setup.exe y -portable.zip (en Windows, con Inno Setup)
//
// Opciones:  --out DIR  --work DIR  --payload DIR  --node-bin FILE  --assemble-only
//   --payload DIR     usa una carpeta ya preparada (dist/, node_modules/, package.json) en vez de ejecutar `npm ci --omit=dev`
//   --node-bin FILE   usa ese ejecutable de Node en lugar de descargar el oficial (sólo para pruebas locales)
//   --assemble-only   deja armada la carpeta del instalador pero no crea el archivo final
// Variables: NODE_VERSION (por ejemplo 24.15.0; por defecto la última 24.x) y NODE_MAJOR (por defecto 24).
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALLERS = path.join(ROOT, "installers");
const NODE_MAJOR = process.env.NODE_MAJOR || "24";
const TARGETS = ["linux-x64", "linux-arm64", "macos", "windows-x64"];

const log = (...args) => console.log("[package]", ...args);
const die = (message) => {
  console.error(`[package] ERROR: ${message}`);
  process.exit(1);
};

function parseArgs(argv) {
  const opts = { out: path.join(ROOT, "release"), work: path.join(ROOT, "build", "package") };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i] ?? die(`falta el valor de ${arg}`);
    if (arg === "--target") opts.target = next();
    else if (arg === "--out") opts.out = path.resolve(next());
    else if (arg === "--work") opts.work = path.resolve(next());
    else if (arg === "--payload") opts.payload = path.resolve(next());
    else if (arg === "--node-bin") opts.nodeBin = path.resolve(next());
    else if (arg === "--assemble-only") opts.assembleOnly = true;
    else die(`opción desconocida: ${arg}`);
  }
  if (!TARGETS.includes(opts.target)) die(`--target tiene que ser uno de: ${TARGETS.join(", ")}`);
  return opts;
}

function run(cmd, args, options = {}) {
  log("$", cmd, args.join(" "));
  execFileSync(cmd, args, { stdio: "inherit", ...options });
}

async function fetchBuffer(url) {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
      log(`descarga fallida (${attempt}/4): ${url} — ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
    }
  }
  throw new Error(`no se pudo descargar ${url}: ${lastError?.message}`);
}

const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");
const rm = (target) => fs.rmSync(target, { recursive: true, force: true });
const mkdir = (target) => fs.mkdirSync(target, { recursive: true });

// ---------------------------------------------------------------- Node.js oficial

/** Resuelve la versión de Node a incluir y las sumas SHA-256 publicadas por nodejs.org. */
async function resolveNode(opts) {
  if (opts.nodeBin) {
    return { version: (process.env.NODE_VERSION || process.version).replace(/^v/, ""), sums: new Map() };
  }
  const pinned = process.env.NODE_VERSION?.replace(/^v/, "");
  const tag = pinned ? `v${pinned}` : `latest-v${NODE_MAJOR}.x`;
  const text = (await fetchBuffer(`https://nodejs.org/dist/${tag}/SHASUMS256.txt`)).toString("utf8");
  const sums = new Map();
  for (const line of text.split("\n")) {
    const match = line.match(/^([0-9a-f]{64})\s+(\S+)$/);
    if (match) sums.set(match[2], match[1]);
  }
  const version = pinned ?? text.match(/node-v(\d+\.\d+\.\d+)-/)?.[1];
  if (!version) die(`no pude determinar la versión de Node.js desde ${tag}/SHASUMS256.txt`);
  return { version, sums };
}

/** Descarga un archivo de nodejs.org (con caché) y verifica su SHA-256. Devuelve la ruta local. */
async function downloadNodeFile(node, name, cacheDir) {
  const expected = node.sums.get(name);
  if (!expected) die(`nodejs.org no publica ${name} para la versión ${node.version}`);
  mkdir(cacheDir);
  const file = path.join(cacheDir, `${node.version}-${name.replaceAll("/", "_")}`);
  if (fs.existsSync(file) && sha256(fs.readFileSync(file)) === expected) return file;
  log(`descargando ${name} (Node ${node.version})`);
  const data = await fetchBuffer(`https://nodejs.org/dist/v${node.version}/${name}`);
  if (sha256(data) !== expected) die(`SHA-256 incorrecto para ${name}: se esperaba ${expected}`);
  fs.writeFileSync(file, data);
  return file;
}

/** Saca `bin/node` y la licencia de un .tar.gz oficial de Node.js (Linux o macOS). */
async function fetchNodeUnix(node, platform, opts, cacheDir, outDir) {
  const archiveName = `node-v${node.version}-${platform}.tar.gz`;
  const archive = await downloadNodeFile(node, archiveName, cacheDir);
  const root = `node-v${node.version}-${platform}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nebulacodex-node-"));
  try {
    run("tar", ["-xzf", archive, "-C", tmp, `${root}/bin/node`, `${root}/LICENSE`]);
    fs.copyFileSync(path.join(tmp, root, "bin", "node"), outDir.binary);
    fs.chmodSync(outDir.binary, 0o755);
    if (outDir.license) fs.copyFileSync(path.join(tmp, root, "LICENSE"), outDir.license);
  } finally {
    rm(tmp);
  }
}

async function installNodeBinary(node, platform, opts, cacheDir, target) {
  if (opts.nodeBin) {
    fs.copyFileSync(opts.nodeBin, target.binary);
    fs.chmodSync(target.binary, 0o755);
    return;
  }
  await fetchNodeUnix(node, platform, opts, cacheDir, target);
}

// ---------------------------------------------------------------- Programa (dist + dependencias de producción)

function stageApp(opts, dest) {
  rm(dest);
  if (opts.payload) {
    log(`usando la carpeta de programa indicada: ${opts.payload}`);
    fs.cpSync(opts.payload, dest, { recursive: true });
    return;
  }
  if (!fs.existsSync(path.join(ROOT, "dist", "index.js"))) die("falta dist/index.js: ejecutá `npm run build` antes de empaquetar.");
  mkdir(dest);
  fs.cpSync(path.join(ROOT, "dist"), path.join(dest, "dist"), { recursive: true, filter: (src) => !src.endsWith(".tsbuildinfo") });
  for (const file of ["package.json", "package-lock.json", "LICENSE"]) fs.copyFileSync(path.join(ROOT, file), path.join(dest, file));
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  run(npm, ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: dest, shell: process.platform === "win32" });
}

function readVersion(appDir) {
  return JSON.parse(fs.readFileSync(path.join(appDir, "package.json"), "utf8")).version;
}

function verifyApp(appDir) {
  for (const required of ["dist/index.js", "package.json", "node_modules/ink/package.json", "node_modules/react/package.json"]) {
    if (!fs.existsSync(path.join(appDir, required))) die(`el programa empaquetado está incompleto: falta ${required}`);
  }
}

// ---------------------------------------------------------------- Carpeta común del instalador

function writeManifest(dir, fields) {
  fs.writeFileSync(path.join(dir, "manifest.txt"), Object.entries(fields).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
}

function copyExecutable(src, dest) {
  fs.copyFileSync(src, dest);
  fs.chmodSync(dest, 0o755);
}

/** Arma la carpeta que se instala: app/, bin/, runtime/, manifest.txt, LICENSE. */
function assemblePayload(dir, appStage, { version, node, target, arch }) {
  rm(dir);
  mkdir(path.join(dir, "bin"));
  mkdir(path.join(dir, "runtime"));
  fs.cpSync(appStage, path.join(dir, "app"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "LICENSE"), path.join(dir, "LICENSE"));
  writeManifest(dir, { version, target, arch, node: node.version, built: new Date().toISOString() });
}

// ---------------------------------------------------------------- Linux

async function buildLinux(arch, opts, ctx) {
  const name = `nebulacodex-${ctx.version}-linux-${arch}`;
  const parent = path.join(opts.work, `linux-${arch}`);
  const root = path.join(parent, name);
  const payload = path.join(root, "payload");
  rm(parent);
  assemblePayload(payload, ctx.appStage, { version: ctx.version, node: ctx.node, target: `linux-${arch}`, arch });
  copyExecutable(path.join(INSTALLERS, "common", "nebulacodex"), path.join(payload, "bin", "nebulacodex"));
  fs.copyFileSync(path.join(ROOT, "assets", "icon.png"), path.join(payload, "icon.png"));
  await installNodeBinary(ctx.node, `linux-${arch === "x64" ? "x64" : "arm64"}`, opts, ctx.cache, {
    binary: path.join(payload, "runtime", "node"),
    license: path.join(payload, "runtime", "LICENSE-node.txt"),
  });
  copyExecutable(path.join(INSTALLERS, "linux", "install.sh"), path.join(root, "install.sh"));
  copyExecutable(path.join(INSTALLERS, "linux", "uninstall.sh"), path.join(root, "uninstall.sh"));
  log(`carpeta lista: ${root}`);
  if (opts.assembleOnly) return [];

  const tgz = path.join(parent, `${name}.tar.gz`);
  run("tar", ["-czf", tgz, "--owner=0", "--group=0", "--numeric-owner", "-C", parent, name]);

  // Encabezado de shell + .tar.gz = un único archivo ejecutable con `sh`.
  const template = fs.readFileSync(path.join(INSTALLERS, "linux", "header.sh"), "utf8").replaceAll("@VERSION@", ctx.version).replaceAll("@ARCH@", arch);
  const size = (bytes) => template.replace("@HEADER_BYTES@", String(bytes).padStart(6, " "));
  const headerLength = Buffer.byteLength(size(0));
  const header = Buffer.from(size(headerLength), "utf8");
  if (header.length !== headerLength) die("el encabezado del instalador cambió de tamaño");
  mkdir(opts.out);
  const out = path.join(opts.out, `NebulaCodex-${ctx.version}-linux-${arch}.sh`);
  fs.writeFileSync(out, Buffer.concat([header, fs.readFileSync(tgz)]), { mode: 0o755 });
  return [out];
}

// ---------------------------------------------------------------- macOS

async function buildMacos(opts, ctx) {
  const parent = path.join(opts.work, "macos");
  const stage = path.join(parent, "dmg");
  const app = path.join(stage, "NebulaCodex.app");
  const resources = path.join(app, "Contents", "Resources");
  rm(parent);
  mkdir(path.join(app, "Contents", "MacOS"));
  assemblePayload(resources, ctx.appStage, { version: ctx.version, node: ctx.node, target: "macos", arch: "arm64+x64" });
  copyExecutable(path.join(INSTALLERS, "common", "nebulacodex"), path.join(resources, "bin", "nebulacodex"));
  for (const arch of ["arm64", "x64"]) {
    await installNodeBinary(ctx.node, `darwin-${arch}`, opts, ctx.cache, {
      binary: path.join(resources, "runtime", `node-${arch}`),
      license: arch === "arm64" ? path.join(resources, "runtime", "LICENSE-node.txt") : null,
    });
  }
  copyExecutable(path.join(INSTALLERS, "macos", "launcher.sh"), path.join(app, "Contents", "MacOS", "NebulaCodex"));
  fs.copyFileSync(path.join(ROOT, "assets", "icon.icns"), path.join(resources, "NebulaCodex.icns"));
  const minMacos = Number(ctx.node.version.split(".")[0]) >= 24 ? "13.5" : "11.0";
  const plist = fs.readFileSync(path.join(INSTALLERS, "macos", "Info.plist.in"), "utf8").replaceAll("@VERSION@", ctx.version).replaceAll("@MIN_MACOS@", minMacos);
  fs.writeFileSync(path.join(app, "Contents", "Info.plist"), plist);
  for (const file of ["Instalar NebulaCodex.command", "Desinstalar NebulaCodex.command"]) {
    copyExecutable(path.join(INSTALLERS, "macos", file), path.join(stage, file));
  }
  fs.copyFileSync(path.join(INSTALLERS, "macos", "LEEME.txt"), path.join(stage, "LEEME.txt"));
  fs.symlinkSync("/Applications", path.join(stage, "Applications"));
  log(`carpeta lista: ${stage}`);
  if (opts.assembleOnly) return [];
  if (process.platform !== "darwin") die("el .dmg sólo se puede crear en macOS (usá --assemble-only para armar la carpeta en otro sistema).");

  mkdir(opts.out);
  const out = path.join(opts.out, `NebulaCodex-${ctx.version}-macos.dmg`);
  rm(out);
  run("hdiutil", ["create", "-volname", "NebulaCodex", "-srcfolder", stage, "-fs", "HFS+", "-format", "UDZO", "-ov", out]);
  return [out];
}

// ---------------------------------------------------------------- Windows

function findIscc() {
  const candidates = [
    process.env.ISCC,
    "C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe",
    "C:\\Program Files\\Inno Setup 6\\ISCC.exe",
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "Inno Setup 6", "ISCC.exe"),
  ].filter(Boolean);
  return candidates.find((file) => fs.existsSync(file));
}

function makeZip(parent, name, out) {
  rm(out);
  if (process.platform === "win32") {
    // bsdtar de Windows (no el tar de Git Bash) sabe escribir .zip
    const tar = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
    run(tar, ["-a", "-c", "-f", out, "-C", parent, name]);
  } else {
    run("zip", ["-r", "-q", out, name], { cwd: parent });
  }
}

async function buildWindows(opts, ctx) {
  const parent = path.join(opts.work, "windows-x64");
  const payload = path.join(parent, "payload");
  rm(parent);
  assemblePayload(payload, ctx.appStage, { version: ctx.version, node: ctx.node, target: "windows-x64", arch: "x64" });
  fs.copyFileSync(path.join(INSTALLERS, "windows", "nebulacodex.cmd"), path.join(payload, "bin", "nebulacodex.cmd"));
  const exe = path.join(payload, "runtime", "node.exe");
  if (opts.nodeBin) fs.copyFileSync(opts.nodeBin, exe);
  else fs.copyFileSync(await downloadNodeFile(ctx.node, "win-x64/node.exe", ctx.cache), exe);
  log(`carpeta lista: ${payload}`);
  if (opts.assembleOnly) return [];

  mkdir(opts.out);
  const outputs = [];

  // Versión portátil: descomprimir y ejecutar NebulaCodex.cmd.
  const portableName = `NebulaCodex-${ctx.version}-windows-x64-portable`;
  const portable = path.join(parent, portableName);
  fs.cpSync(payload, portable, { recursive: true });
  fs.writeFileSync(path.join(portable, "NebulaCodex.cmd"), '@echo off\r\ncall "%~dp0bin\\nebulacodex.cmd" %*\r\n');
  fs.writeFileSync(
    path.join(portable, "LEEME.txt"),
    "NebulaCodex (version portatil)\r\n\r\nDoble clic en NebulaCodex.cmd para abrirlo. No instala nada en el sistema.\r\n" +
      "Para tener acceso directo, menu Inicio y el comando 'nebulacodex', usa el instalador (setup.exe).\r\n" +
      "La configuracion (proveedor, API key, modelo) se hace dentro de la app con /providers.\r\n",
  );
  const zip = path.join(opts.out, `${portableName}.zip`);
  makeZip(parent, portableName, zip);
  outputs.push(zip);

  // Instalador con Inno Setup.
  const iscc = findIscc();
  if (!iscc) die("no encontré Inno Setup (ISCC.exe). Instalalo con `choco install innosetup` o definí la variable ISCC.");
  const base = `NebulaCodex-${ctx.version}-windows-x64-setup`;
  run(iscc, [
    "/Q",
    `/DAppVersion=${ctx.version}`,
    `/DPayloadDir=${payload}`,
    `/DIconFile=${path.join(ROOT, "assets", "icon.ico")}`,
    `/DLicenseFile=${path.join(ROOT, "LICENSE")}`,
    `/DOutputDir=${opts.out}`,
    `/DOutputBase=${base}`,
    path.join(INSTALLERS, "windows", "NebulaCodex.iss"),
  ]);
  const setup = path.join(opts.out, `${base}.exe`);
  if (!fs.existsSync(setup)) die(`Inno Setup no generó ${setup}`);
  outputs.push(setup);
  return outputs;
}

// ---------------------------------------------------------------- Principal

const opts = parseArgs(process.argv.slice(2));
mkdir(opts.work);
const node = await resolveNode(opts);
const appStage = path.join(opts.work, "app");
stageApp(opts, appStage);
verifyApp(appStage);
const ctx = { version: readVersion(appStage), node, appStage, cache: path.join(opts.work, "..", "package-cache") };
log(`NebulaCodex ${ctx.version} · Node.js ${node.version} · destino: ${opts.target}`);

let outputs;
if (opts.target === "linux-x64") outputs = await buildLinux("x64", opts, ctx);
else if (opts.target === "linux-arm64") outputs = await buildLinux("arm64", opts, ctx);
else if (opts.target === "macos") outputs = await buildMacos(opts, ctx);
else outputs = await buildWindows(opts, ctx);

for (const file of outputs) {
  const data = fs.readFileSync(file);
  log(`OK ${path.relative(ROOT, file)}  ${(data.length / 1048576).toFixed(1)} MiB  sha256 ${sha256(data)}`);
}
