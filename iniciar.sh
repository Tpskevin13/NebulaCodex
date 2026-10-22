#!/usr/bin/env bash
# Lanzador de NebulaCodex para Mac y Linux: instala, compila y abre.
set -e

APP="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="${NEBULACODEX_WORKDIR:-$HOME}"
[ -d "$WORK" ] || WORK="/"

if ! command -v node >/dev/null 2>&1; then
  echo "Falta Node.js. Instalalo desde https://nodejs.org (version 18 o mayor)."
  exit 1
fi
NODE_VERSION="$(node --version 2>/dev/null || true)"
NODE_MAJOR="${NODE_VERSION#v}"
NODE_MAJOR="${NODE_MAJOR%%.*}"
if [[ ! "$NODE_MAJOR" =~ ^[0-9]+$ ]]; then
  echo "No pude detectar la versión de Node.js. Instalá Node.js 18 o mayor."
  exit 1
fi
if (( NODE_MAJOR < 18 )); then
  echo "NebulaCodex necesita Node.js 18 o mayor; está instalada la versión $NODE_VERSION."
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "No se encontró npm. Reinstalá Node.js 18 o mayor con npm incluido."
  exit 1
fi

cd "$APP"

needs_install=0
if [ ! -d node_modules ]; then
  needs_install=1
elif [ -f package-lock.json ] && [ -f node_modules/.package-lock.json ] && [ package-lock.json -nt node_modules/.package-lock.json ]; then
  needs_install=1
fi
if (( needs_install )); then
  echo "Instalando dependencias..."
  npm install --no-audit --no-fund --loglevel=error
fi

needs_build=0
if [ ! -f dist/index.js ]; then
  needs_build=1
elif [ -n "$(find src -type f -newer dist/index.js -print -quit 2>/dev/null)" ]; then
  needs_build=1
elif [ tsconfig.json -nt dist/index.js ]; then
  needs_build=1
fi
if (( needs_build )); then
  echo "Compilando NebulaCodex..."
  npm run build --silent
fi

if [ ! -d "$WORK" ]; then
  echo "No se encontró la carpeta de trabajo: $WORK"
  exit 1
fi

cd "$WORK"
exec node "$APP/dist/index.js" "$@"
