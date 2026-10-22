#!/usr/bin/env python3
"""Abre la app en una terminal real (pty) y comprueba que llega a la pantalla de Proveedores.

Sirve para verificar una instalación: con una carpeta HOME vacía, NebulaCodex debe arrancar y mostrar
la configuración de proveedores (la primera vez no hay ninguno configurado).

Uso: pty-smoke.py <comando> [args...]
"""
import fcntl
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import time

EXPECTED = "Proveedores de IA"
TIMEOUT = 30

if len(sys.argv) < 2:
    sys.exit("uso: pty-smoke.py <comando> [args...]")

pid, fd = pty.fork()
if pid == 0:
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    os.environ["TERM"] = "xterm-256color"
    # Ink, en un entorno de CI, sólo dibuja el último cuadro al salir. Se quitan esas variables para ver la interfaz como en una PC.
    for key in [k for k in os.environ if k in ("CI", "CONTINUOUS_INTEGRATION", "BUILD_NUMBER", "RUN_ID") or k.startswith("CI_")]:
        del os.environ[key]
    os.execvp(sys.argv[1], sys.argv[1:])

ansi = re.compile(rb"\x1b\[[0-9;?:]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]")
raw = b""
found = False
deadline = time.time() + TIMEOUT
while time.time() < deadline:
    ready, _, _ = select.select([fd], [], [], 0.5)
    if ready:
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk:
            break
        raw += chunk
        if EXPECTED in ansi.sub(b"", raw).decode("utf-8", "replace"):
            found = True
            break

def drain(seconds):
    """Lee y descarta lo que escriba la app: en macOS un proceso no termina de salir mientras la terminal tenga salida sin leer."""
    end = time.time() + seconds
    while time.time() < end:
        if fd < 0:
            time.sleep(0.2)
            continue
        ready, _, _ = select.select([fd], [], [], 0.2)
        if ready:
            try:
                if not os.read(fd, 65536):
                    return
            except OSError:
                return


def reap(seconds):
    end = time.time() + seconds
    while time.time() < end:
        try:
            done, _ = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            return True
        if done:
            return True
        drain(0.2)
    return False


# Salir con Ctrl+C y, si no responde, terminar el proceso. Nunca se espera de forma indefinida.
try:
    os.write(fd, b"\x03")
except OSError:
    pass
if not reap(3):
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    try:
        os.close(fd)  # al cerrar la terminal, el proceso termina de salir aunque tuviera salida pendiente
    except OSError:
        pass
    fd = -1
    reap(5)

if found:
    print(f"OK: la app arrancó y mostró «{EXPECTED}».")
    sys.exit(0)
text = ansi.sub(b"", raw).decode("utf-8", "replace")
print(f"FALLO: no apareció «{EXPECTED}» en {TIMEOUT} s. Salida recibida:\n{text[-2000:]}")
sys.exit(1)
