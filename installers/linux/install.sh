#!/bin/sh
# Instalador de NebulaCodex para Linux.
# Instala el programa con su propio Node.js (no hace falta tener Node instalado), crea el comando
# `nebulacodex`, una entrada en el menú de aplicaciones y un acceso directo en el escritorio.
# shellcheck disable=SC2015  # los `a && b || true` son intencionales: nunca deben abortar el script
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
PAYLOAD="$HERE/payload"

MODE=user
WANT_DESKTOP=1
WANT_MENU=1

usage() {
  cat <<USAGE
Instalador de NebulaCodex

Uso: sh install.sh [opciones]

  --system        Instala para todos los usuarios en /opt (hay que ejecutarlo con sudo)
  --no-desktop    No crea el acceso directo en el escritorio
  --no-menu       No crea la entrada en el menú de aplicaciones
  -h, --help      Muestra esta ayuda

Sin opciones instala sólo para tu usuario, sin necesidad de sudo.
Para desinstalar: ejecutá uninstall.sh (queda copiado dentro de la carpeta de instalación).
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --system) MODE=system ;;
    --no-desktop) WANT_DESKTOP=0 ;;
    --no-menu) WANT_MENU=0 ;;
    -h | --help) usage; exit 0 ;;
    *) echo "Opción desconocida: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

say() { printf '%s\n' "$*"; }
fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Linux" ] || fail "este instalador es sólo para Linux (sistema detectado: $(uname -s))."
[ -x "$PAYLOAD/runtime/node" ] || fail "el paquete está incompleto (falta runtime/node)."

# La arquitectura del paquete tiene que coincidir con la de la máquina.
PKG_ARCH=$(sed -n 's/^arch=//p' "$PAYLOAD/manifest.txt" 2>/dev/null | head -n 1)
case "$(uname -m)" in
  x86_64 | amd64) MACHINE=x64 ;;
  aarch64 | arm64) MACHINE=arm64 ;;
  *) MACHINE=$(uname -m) ;;
esac
if [ -n "$PKG_ARCH" ] && [ "$PKG_ARCH" != "$MACHINE" ]; then
  fail "este paquete es para $PKG_ARCH y tu equipo es $MACHINE. Descargá el instalador que corresponde."
fi

# Comprueba que el Node incluido arranca (falla, por ejemplo, en distribuciones con musl como Alpine).
if ! NODE_VERSION=$("$PAYLOAD/runtime/node" --version 2>/dev/null); then
  fail "el Node.js incluido no se puede ejecutar en este sistema (¿Alpine/musl o glibc muy vieja?). Instalá Node.js 18+ y usá el código fuente: https://github.com/Tpskevin13/NebulaCodex"
fi

if [ "$MODE" = system ]; then
  [ "$(id -u)" -eq 0 ] || fail "--system necesita permisos de administrador: ejecutá  sudo sh $0 --system"
  APP_DIR=/opt/nebulacodex
  BIN_DIR=/usr/local/bin
  APPS_DIR=/usr/share/applications
  ICON_DIR=/usr/share/icons/hicolor/512x512/apps
else
  [ -n "${HOME:-}" ] && [ -d "$HOME" ] || fail "no se pudo determinar tu carpeta personal (HOME)."
  DATA_HOME=${XDG_DATA_HOME:-$HOME/.local/share}
  APP_DIR=$DATA_HOME/nebulacodex
  BIN_DIR=$HOME/.local/bin
  APPS_DIR=$DATA_HOME/applications
  ICON_DIR=$DATA_HOME/icons/hicolor/512x512/apps
fi
LINK=$BIN_DIR/nebulacodex
ICON=$ICON_DIR/nebulacodex.png
MENU_FILE=$APPS_DIR/nebulacodex.desktop

VERSION=$(sed -n 's/^version=//p' "$PAYLOAD/manifest.txt" 2>/dev/null | head -n 1)
say "Instalando NebulaCodex ${VERSION:-} (Node.js incluido: $NODE_VERSION)"
say "  Programa: $APP_DIR"

# Si ya había una instalación, se recuerdan sus accesos directos para que el desinstalador no deje restos.
OLD_INFO="$APP_DIR/install-info.txt"
OLD_MENU=
OLD_DESKTOP=
if [ -f "$OLD_INFO" ]; then
  OLD_MENU=$(sed -n 's/^menu_file=//p' "$OLD_INFO" | head -n 1)
  OLD_DESKTOP=$(sed -n 's/^desktop_file=//p' "$OLD_INFO" | head -n 1)
fi

# --- 1. Programa (se reemplaza una instalación anterior sin tocar tu configuración en ~/.nebulacodex) ---
mkdir -p "$(dirname "$APP_DIR")"
STAGE="$APP_DIR.new.$$"
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp -R "$PAYLOAD/." "$STAGE/"
cp "$HERE/uninstall.sh" "$STAGE/uninstall.sh"
chmod 755 "$STAGE/uninstall.sh" "$STAGE/bin/nebulacodex" "$STAGE/runtime/node"
if [ -d "$APP_DIR" ]; then
  rm -rf "$APP_DIR.old"
  mv "$APP_DIR" "$APP_DIR.old"
fi
mv "$STAGE" "$APP_DIR"
rm -rf "$APP_DIR.old"

# --- 2. Comando `nebulacodex` ---
mkdir -p "$BIN_DIR"
ln -sf "$APP_DIR/bin/nebulacodex" "$LINK"
say "  Comando:  $LINK"

# --- 3. Icono y entrada de menú ---
mkdir -p "$ICON_DIR"
cp "$PAYLOAD/icon.png" "$ICON"

desktop_entry() {
  cat <<ENTRY
[Desktop Entry]
Type=Application
Version=1.0
Name=NebulaCodex
GenericName=Agente de código para la terminal
Comment=Agente de código libre para la terminal con muchos proveedores de IA
Exec="$LINK"
Icon=$ICON
Terminal=true
Categories=Development;ConsoleOnly;
Keywords=ai;agent;code;terminal;llm;nebula;codex;
StartupNotify=false
ENTRY
}

DESKTOP_FILE=
if [ "$WANT_MENU" -eq 1 ]; then
  mkdir -p "$APPS_DIR"
  desktop_entry > "$MENU_FILE"
  chmod 644 "$MENU_FILE"
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS_DIR" >/dev/null 2>&1 || true
  say "  Menú:     $MENU_FILE"
fi

# --- 4. Acceso directo en el escritorio (sólo instalación de usuario y si existe la carpeta Escritorio) ---
if [ "$WANT_DESKTOP" -eq 1 ] && [ "$MODE" = user ]; then
  DESKTOP_DIR=
  if command -v xdg-user-dir >/dev/null 2>&1; then
    DESKTOP_DIR=$(xdg-user-dir DESKTOP 2>/dev/null || true)
  fi
  if [ -z "$DESKTOP_DIR" ] || [ "$DESKTOP_DIR" = "$HOME" ] || [ ! -d "$DESKTOP_DIR" ]; then
    DESKTOP_DIR=
    for candidate in "$HOME/Desktop" "$HOME/Escritorio"; do
      if [ -d "$candidate" ]; then DESKTOP_DIR=$candidate; break; fi
    done
  fi
  if [ -n "$DESKTOP_DIR" ]; then
    DESKTOP_FILE=$DESKTOP_DIR/NebulaCodex.desktop
    desktop_entry > "$DESKTOP_FILE"
    chmod 755 "$DESKTOP_FILE"
    # GNOME pide "Permitir lanzar" la primera vez; esto lo marca como confiable cuando hay sesión gráfica.
    command -v gio >/dev/null 2>&1 && gio set "$DESKTOP_FILE" metadata::trusted true >/dev/null 2>&1 || true
    say "  Escritorio: $DESKTOP_FILE"
  else
    say "  Escritorio: no se encontró la carpeta Escritorio, no se creó el acceso directo."
  fi
fi

# --- 5. Datos para desinstalar ---
MENU_RECORD=
[ "$WANT_MENU" -eq 1 ] && MENU_RECORD=$MENU_FILE
[ -z "$MENU_RECORD" ] && [ -n "$OLD_MENU" ] && [ -f "$OLD_MENU" ] && MENU_RECORD=$OLD_MENU
[ -z "$DESKTOP_FILE" ] && [ -n "$OLD_DESKTOP" ] && [ -f "$OLD_DESKTOP" ] && DESKTOP_FILE=$OLD_DESKTOP
{
  echo "mode=$MODE"
  echo "app_dir=$APP_DIR"
  echo "link=$LINK"
  echo "icon=$ICON"
  echo "menu_file=$MENU_RECORD"
  echo "desktop_file=$DESKTOP_FILE"
} > "$APP_DIR/install-info.txt"

say ""
say "Listo. Abrí NebulaCodex desde el menú de aplicaciones, el escritorio o escribiendo:  nebulacodex"
case ":${PATH:-}:" in
  *":$BIN_DIR:"*) ;;
  *) say "Nota: $BIN_DIR no está en tu PATH. Cerrá y abrí la sesión, o agregá esta línea a ~/.profile:"
     say "      export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac
say "La configuración (proveedores, API keys, modelos) se hace dentro de la app con /providers."
