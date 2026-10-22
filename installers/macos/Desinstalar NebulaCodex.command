#!/bin/bash
# Desinstalador de NebulaCodex para macOS. Conserva tu configuración y chats (~/.nebulacodex) salvo que lo pidas.
set -u

INTERACTIVE=1
[ -n "${NEBULACODEX_NONINTERACTIVE:-}" ] && INTERACTIVE=0

echo "Desinstalando NebulaCodex ..."
for apps in "${NEBULACODEX_APPS_DIR:-/Applications}" "$HOME/Applications"; do
  if [ -d "$apps/NebulaCodex.app" ]; then
    rm -rf "$apps/NebulaCodex.app" && echo "Se borró $apps/NebulaCodex.app"
  fi
done

# Accesos directos y comando: sólo si todavía apuntan a una instalación de NebulaCodex.
[ -L "$HOME/Desktop/NebulaCodex" ] && rm -f "$HOME/Desktop/NebulaCodex"
if [ -L "$HOME/.local/bin/nebulacodex" ] && readlink "$HOME/.local/bin/nebulacodex" | grep -q "NebulaCodex.app"; then
  rm -f "$HOME/.local/bin/nebulacodex"
fi

# Quita el bloque que agregó el instalador en ~/.zprofile.
PROFILE="$HOME/.zprofile"
if grep -q ">>> NebulaCodex >>>" "$PROFILE" 2>/dev/null; then
  TMP="$(mktemp)"
  sed '/# >>> NebulaCodex >>>/,/# <<< NebulaCodex <<</d' "$PROFILE" > "$TMP" && cat "$TMP" > "$PROFILE"
  rm -f "$TMP"
fi

if [ "$INTERACTIVE" -eq 1 ] && [ -d "$HOME/.nebulacodex" ]; then
  read -r -p "¿Borrar también tu configuración, API keys y chats guardados (~/.nebulacodex)? [s/N] " answer
  case "$answer" in
    s | S | si | SI | sí | Sí) rm -rf "$HOME/.nebulacodex" && echo "Se borró ~/.nebulacodex" ;;
    *) echo "Tu configuración y tus chats siguen en ~/.nebulacodex" ;;
  esac
fi

echo "Listo."
if [ "$INTERACTIVE" -eq 1 ]; then
  echo ""
  read -r -p "Presioná Enter para cerrar esta ventana..." _
fi
exit 0
