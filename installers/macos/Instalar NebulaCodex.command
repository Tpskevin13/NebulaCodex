#!/bin/bash
# Instalador de NebulaCodex para macOS.
# Copia NebulaCodex.app a Aplicaciones, crea un acceso directo en el escritorio y el comando `nebulacodex`.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/NebulaCodex.app"
INTERACTIVE=1
[ -n "${NEBULACODEX_NONINTERACTIVE:-}" ] && INTERACTIVE=0

pause_and_exit() {
  local code="$1"
  if [ "$INTERACTIVE" -eq 1 ]; then
    echo ""
    read -r -p "Presioná Enter para cerrar esta ventana..." _
  fi
  exit "$code"
}
fail() { echo "Error: $*" >&2; pause_and_exit 1; }

[ "$(uname -s)" = "Darwin" ] || fail "este instalador es sólo para macOS."
[ -d "$SRC" ] || fail "no encuentro NebulaCodex.app junto a este archivo. Ejecutalo desde el disco NebulaCodex (el .dmg abierto)."

# Destino: /Applications si se puede escribir (usuarios administradores); si no, ~/Applications.
if [ -n "${NEBULACODEX_APPS_DIR:-}" ]; then
  APPS="$NEBULACODEX_APPS_DIR"
elif [ -w /Applications ]; then
  APPS=/Applications
else
  APPS="$HOME/Applications"
fi
mkdir -p "$APPS" || fail "no pude crear $APPS."
DEST="$APPS/NebulaCodex.app"

echo "Instalando NebulaCodex en $APPS ..."
if [ -e "$DEST" ]; then
  [ "$(basename "$DEST")" = "NebulaCodex.app" ] || fail "ruta inesperada: $DEST"
  rm -rf "$DEST" || fail "no pude reemplazar la instalación anterior."
fi
/usr/bin/ditto "$SRC" "$DEST" || fail "no pude copiar la aplicación."

# Se conserva sólo el Node.js que corresponde a este Mac.
case "$(uname -m)" in
  arm64) KEEP=arm64; DROP=x64 ;;
  *) KEEP=x64; DROP=arm64 ;;
esac
if [ -x "$DEST/Contents/Resources/runtime/node-$KEEP" ]; then
  rm -f "$DEST/Contents/Resources/runtime/node-$DROP"
fi

# Esta copia fue instalada por vos: se quita la marca de cuarentena para que macOS no la bloquee.
/usr/bin/xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true

# Comando `nebulacodex` para usar desde la Terminal.
CLI_DIR="$HOME/.local/bin"
if mkdir -p "$CLI_DIR" && ln -sf "$DEST/Contents/Resources/bin/nebulacodex" "$CLI_DIR/nebulacodex"; then
  case ":$PATH:" in
    *":$CLI_DIR:"*) ;;
    *)
      PROFILE="$HOME/.zprofile"
      if ! grep -q ">>> NebulaCodex >>>" "$PROFILE" 2>/dev/null; then
        {
          echo ""
          echo "# >>> NebulaCodex >>>"
          # shellcheck disable=SC2016  # se escribe $HOME literal a propósito
          echo 'export PATH="$HOME/.local/bin:$PATH"'
          echo "# <<< NebulaCodex <<<"
        } >> "$PROFILE"
      fi
      echo "Se agregó ~/.local/bin al PATH en ~/.zprofile (abrí una Terminal nueva para usar el comando 'nebulacodex')." ;;
  esac
fi

# Acceso directo en el escritorio (macOS puede pedir permiso para acceder a la carpeta Escritorio).
if [ -z "${NEBULACODEX_SKIP_DESKTOP:-}" ] && [ -d "$HOME/Desktop" ]; then
  if ln -sfn "$DEST" "$HOME/Desktop/NebulaCodex" 2>/dev/null; then
    echo "Acceso directo creado en el Escritorio."
  else
    echo "No se pudo crear el acceso directo en el Escritorio (podés arrastrar NebulaCodex desde Aplicaciones)."
  fi
fi

echo ""
echo "Listo. Abrí NebulaCodex desde Launchpad, la carpeta Aplicaciones o el Escritorio."
echo "La primera vez, macOS puede pedir permiso para que NebulaCodex controle la Terminal: aceptalo."
echo "La configuración (proveedores, API keys, modelos) se hace dentro de la app con /providers."
pause_and_exit 0
