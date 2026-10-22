#!/bin/sh
# Instalador autoextraíble de NebulaCodex @VERSION@ (Linux @ARCH@).
#
#   sh NebulaCodex-@VERSION@-linux-@ARCH@.sh              instala para tu usuario (sin sudo)
#   sudo sh NebulaCodex-@VERSION@-linux-@ARCH@.sh --system  instala para todos los usuarios
#   sh NebulaCodex-@VERSION@-linux-@ARCH@.sh --help       muestra todas las opciones
set -eu

self=$0
if [ ! -f "$self" ]; then
  echo "Descargá el archivo y ejecutalo con:  sh NebulaCodex-@VERSION@-linux-@ARCH@.sh" >&2
  exit 1
fi
for tool in tar gzip tail mktemp; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Falta la herramienta '$tool'." >&2; exit 1; }
done

tmp=$(mktemp -d "${TMPDIR:-/tmp}/nebulacodex-setup.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
trap 'exit 130' INT TERM HUP

tail -c +$((@HEADER_BYTES@ + 1)) "$self" | tar -xzf - -C "$tmp"
dir="$tmp/nebulacodex-@VERSION@-linux-@ARCH@"
[ -f "$dir/install.sh" ] || { echo "El archivo está dañado: volvé a descargarlo." >&2; exit 1; }

status=0
sh "$dir/install.sh" "$@" || status=$?
exit "$status"
# --- fin del encabezado: a partir de acá hay un .tar.gz ---
