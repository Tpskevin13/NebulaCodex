#!/usr/bin/env bash
# Prueba el .dmg de macOS: lo monta, instala en una carpeta HOME de mentira, abre la app y desinstala.
# Uso: test-macos-installer.sh <NebulaCodex.dmg> <versión esperada>
set -euo pipefail
dmg=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
version=$2
here=$(cd "$(dirname "$0")" && pwd)

mnt=$(mktemp -d)
# -noverify: la verificación de checksum de hdiutil se queda colgada en los runners de macOS.
hdiutil attach "$dmg" -mountpoint "$mnt" -nobrowse -readonly -noverify -noautofsck -noautoopen
trap 'hdiutil detach "$mnt" -force >/dev/null 2>&1 || true' EXIT

echo "== contenido del disco"
ls -la "$mnt"
app="$mnt/NebulaCodex.app"
test -d "$app"
test -f "$mnt/LEEME.txt"
plutil -lint "$app/Contents/Info.plist"
test -x "$app/Contents/MacOS/NebulaCodex"
test -f "$app/Contents/Resources/NebulaCodex.icns"
file "$app/Contents/Resources/runtime/node-arm64" | grep -q arm64
file "$app/Contents/Resources/runtime/node-x64" | grep -q x86_64

echo "== la ventana de Terminal se abre con el comando bien citado (aunque la ruta tenga espacios y comillas)"
fake_home="$(mktemp -d)/it's a home"
export HOME="$fake_home"
mkdir -p "$HOME/Desktop"
NEBULACODEX_NONINTERACTIVE=1 NEBULACODEX_APPS_DIR="$HOME/Applications" bash "$mnt/Instalar NebulaCodex.command"
installed="$HOME/Applications/NebulaCodex.app"
test -d "$installed"
sed 's#/usr/bin/osascript#cat#' "$installed/Contents/MacOS/NebulaCodex" > "$installed/Contents/MacOS/launcher-test"
chmod +x "$installed/Contents/MacOS/launcher-test"
applescript=$("$installed/Contents/MacOS/launcher-test")
rm -f "$installed/Contents/MacOS/launcher-test"
echo "$applescript"
shellcmd=$(printf '%s\n' "$applescript" | sed -n 's/^ *do script "\(.*\)"$/\1/p' | sed -e 's/\\"/"/g' -e 's/\\\\/\\/g')
shellcmd=${shellcmd#clear; }
set +e
out=$(bash -c "$shellcmd" < /dev/null 2>&1)
set -e
echo "$out" | grep -q "terminal interactiva"

echo "== comando nebulacodex, versión y primer arranque"
cmd="$HOME/.local/bin/nebulacodex"
test -L "$HOME/Desktop/NebulaCodex"
[ "$("$cmd" --version)" = "NebulaCodex $version" ]
"$cmd" --help | grep -q "/providers"
python3 "$here/pty-smoke.py" "$cmd"
test ! -e "$installed/Contents/Resources/runtime/node-x64"   # sólo queda el Node de este Mac
grep -q ">>> NebulaCodex >>>" "$HOME/.zprofile" || echo "(PATH ya incluía ~/.local/bin)"

echo "== desinstalar"
NEBULACODEX_NONINTERACTIVE=1 NEBULACODEX_APPS_DIR="$HOME/Applications" bash "$mnt/Desinstalar NebulaCodex.command"
test ! -e "$installed"
test ! -e "$cmd"
test ! -e "$HOME/Desktop/NebulaCodex"
if [ -f "$HOME/.zprofile" ] && grep -q ">>> NebulaCodex >>>" "$HOME/.zprofile"; then echo "quedó el bloque de PATH en ~/.zprofile"; exit 1; fi

echo "Instalador de macOS: todo OK"
