#!/usr/bin/env bash
# Prueba el instalador de Linux en una carpeta HOME de mentira: instala, abre la app, desinstala.
# Uso: test-linux-installer.sh <instalador.sh> <versión esperada>
set -euo pipefail
installer=$(realpath "$1")
version=$2
here=$(cd "$(dirname "$0")" && pwd)

work=$(mktemp -d)
export HOME="$work/home"
mkdir -p "$HOME/Desktop"
unset XDG_DATA_HOME XDG_CONFIG_HOME

echo "== instalar"
sh "$installer"
cmd="$HOME/.local/bin/nebulacodex"
test -x "$cmd"
test -f "$HOME/.local/share/applications/nebulacodex.desktop"
test -x "$HOME/Desktop/NebulaCodex.desktop"
test -f "$HOME/.local/share/icons/hicolor/512x512/apps/nebulacodex.png"

echo "== versión y ayuda"
out=$("$cmd" --version)
[ "$out" = "NebulaCodex $version" ] || { echo "versión inesperada: '$out'"; exit 1; }
"$cmd" --help | grep -q "/providers"

echo "== sin terminal interactiva, la app debe avisar y salir con error"
set +e
msg=$("$cmd" < /dev/null 2>&1)
status=$?
set -e
[ "$status" -eq 1 ] && echo "$msg" | grep -q "terminal interactiva"

echo "== entrada de menú válida"
if command -v desktop-file-validate >/dev/null 2>&1; then
  desktop-file-validate "$HOME/.local/share/applications/nebulacodex.desktop"
else
  echo "(desktop-file-validate no está instalado; se omite)"
fi
grep -q "^Exec=\"$cmd\"" "$HOME/.local/share/applications/nebulacodex.desktop"

echo "== arranque real en una terminal (primer inicio: pantalla de Proveedores)"
python3 "$here/pty-smoke.py" "$cmd"

echo "== reinstalar encima"
sh "$installer" >/dev/null
[ "$("$cmd" --version)" = "NebulaCodex $version" ]

echo "== desinstalar (la configuración se conserva)"
mkdir -p "$HOME/.nebulacodex"
sh "$HOME/.local/share/nebulacodex/uninstall.sh"
test ! -e "$HOME/.local/share/nebulacodex"
test ! -e "$cmd"
test ! -e "$HOME/.local/share/applications/nebulacodex.desktop"
test ! -e "$HOME/Desktop/NebulaCodex.desktop"
test -d "$HOME/.nebulacodex"

echo "Instalador de Linux: todo OK"
