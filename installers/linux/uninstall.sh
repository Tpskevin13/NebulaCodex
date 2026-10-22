#!/bin/sh
# Desinstalador de NebulaCodex para Linux.
# Quita el programa, el comando, el menú y el acceso directo. Tu configuración y tus chats
# (~/.nebulacodex) se conservan, salvo que uses --purge.
# shellcheck disable=SC2015  # los `a && b || true` son intencionales: nunca deben abortar el script
set -eu

PURGE=0
for arg in "$@"; do
  case "$arg" in
    --purge) PURGE=1 ;;
    -h | --help)
      echo "Uso: sh uninstall.sh [--purge]"
      echo "  --purge   borra también ~/.nebulacodex (configuración, API keys y chats guardados)"
      exit 0 ;;
    *) echo "Opción desconocida: $arg" >&2; exit 2 ;;
  esac
done

HERE=$(cd "$(dirname "$0")" && pwd)
INFO="$HERE/install-info.txt"
[ -f "$INFO" ] || { echo "No encuentro $INFO: este script tiene que ejecutarse desde la carpeta de instalación." >&2; exit 1; }
get() { sed -n "s/^$1=//p" "$INFO" | head -n 1; }

MODE=$(get mode)
APP_DIR=$(get app_dir)
LINK=$(get link)
ICON=$(get icon)
MENU_FILE=$(get menu_file)
DESKTOP_FILE=$(get desktop_file)

if [ "$MODE" = system ] && [ "$(id -u)" -ne 0 ]; then
  echo "Esta instalación es para todos los usuarios: ejecutá  sudo sh $0" >&2
  exit 1
fi
# Sólo se borra una carpeta que realmente sea la instalación (nunca "/" ni una ruta vacía).
case "$APP_DIR" in
  */nebulacodex) ;;
  *) echo "Ruta de instalación inesperada: '$APP_DIR'. No se borra nada." >&2; exit 1 ;;
esac
[ -d "$APP_DIR" ] && [ "$(cd "$APP_DIR" && pwd -P)" = "$(cd "$HERE" && pwd -P)" ] || { echo "Este script no está en $APP_DIR. No se borra nada." >&2; exit 1; }

# El comando sólo se borra si todavía apunta a esta instalación.
if [ -n "$LINK" ] && [ -L "$LINK" ] && [ "$(readlink "$LINK")" = "$APP_DIR/bin/nebulacodex" ]; then rm -f "$LINK"; fi
[ -n "$MENU_FILE" ] && rm -f "$MENU_FILE"
[ -n "$DESKTOP_FILE" ] && rm -f "$DESKTOP_FILE"
[ -n "$ICON" ] && rm -f "$ICON"
if [ -n "$MENU_FILE" ]; then
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$(dirname "$MENU_FILE")" >/dev/null 2>&1 || true
fi

cd /
rm -rf "$APP_DIR"
echo "NebulaCodex se desinstaló."

if [ "$PURGE" -eq 1 ] && [ -n "${HOME:-}" ] && [ -d "$HOME/.nebulacodex" ]; then
  rm -rf "$HOME/.nebulacodex"
  echo "Se borró $HOME/.nebulacodex (configuración y chats)."
else
  echo "Tu configuración y tus chats siguen en ~/.nebulacodex (para borrarlos: rm -rf ~/.nebulacodex)."
fi
