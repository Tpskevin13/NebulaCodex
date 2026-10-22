#!/usr/bin/env bash
# Ejecuta un comando y, si falla, deja las últimas líneas de su salida como anotación de GitHub Actions
# (visible en la pestaña del job y por la API sin necesidad de descargar los logs).
# Uso: scripts/ci/run.sh "<título>" <comando> [args...]
title=$1
shift
log=$(mktemp)
set +e
"$@" 2>&1 | tee "$log"
code=${PIPESTATUS[0]}
if [ "$code" -ne 0 ]; then
  msg=$(tail -n 60 "$log" | sed $'s/\x1b\\[[0-9;]*[A-Za-z]//g')
  msg=${msg//'%'/'%25'}
  msg=${msg//$'\r'/'%0D'}
  msg=${msg//$'\n'/'%0A'}
  echo "::error title=${title} (código ${code})::${msg}"
fi
exit "$code"
