#!/bin/bash
# Ejecutable de NebulaCodex.app: abre Terminal y corre NebulaCodex dentro.
RES="$(cd "$(dirname "$0")/../Resources" && pwd)"

# Cita una ruta para el shell (comillas simples) y para AppleScript (escapa \ y ").
shq() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
CMD="clear; $(shq "$RES/bin/nebulacodex"); exit"
AS_CMD="$(printf '%s' "$CMD" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')"

/usr/bin/osascript <<OSA
tell application "Terminal"
  activate
  do script "$AS_CMD"
end tell
OSA
