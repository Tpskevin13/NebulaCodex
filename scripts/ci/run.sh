#!/usr/bin/env bash
# Ejecuta un comando con tiempo máximo y, si falla o se cuelga, deja las últimas líneas de su salida
# (y la lista de procesos) como anotación de GitHub Actions: se ven en la pestaña del job y por la API
# sin necesidad de descargar los logs.
# Uso: [RUN_TIMEOUT=segundos] scripts/ci/run.sh "<título>" <comando> [args...]
title=$1
shift
timeout=${RUN_TIMEOUT:-900}
log=$(mktemp)

"$@" >"$log" 2>&1 &
pid=$!
tail -n +1 -f "$log" &
tailpid=$!

elapsed=0
hung=0
while kill -0 "$pid" 2>/dev/null; do
  if [ "$elapsed" -ge "$timeout" ]; then
    hung=1
    break
  fi
  sleep 1
  elapsed=$((elapsed + 1))
done

procs=
if [ "$hung" -eq 1 ]; then
  procs=$(ps -axo pid,ppid,stat,etime,command 2>/dev/null | grep -v -E ' \[[^]]+\]$' | tail -n 40)
  pkill -P "$pid" 2>/dev/null
  kill "$pid" 2>/dev/null
  code=124
else
  wait "$pid"
  code=$?
fi
sleep 1
kill "$tailpid" 2>/dev/null

if [ "$code" -ne 0 ]; then
  msg=$(tail -n 60 "$log" | sed $'s/\x1b\\[[0-9;]*[A-Za-z]//g')
  if [ "$hung" -eq 1 ]; then
    msg="SE COLGÓ (más de ${timeout} s). Procesos:
${procs}

Última salida:
${msg}"
  fi
  msg=${msg//'%'/'%25'}
  msg=${msg//$'\r'/'%0D'}
  msg=${msg//$'\n'/'%0A'}
  echo "::error title=${title} (código ${code})::${msg}"
fi
exit "$code"
