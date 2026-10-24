#!/bin/sh
# Arranca el servidor construido (dist/server/entry.mjs) y prueba HTTP. Uso: sh scripts/smoke.sh
set -eu
PORT="${SMOKE_PORT:-4399}"
BASE="http://127.0.0.1:$PORT"
HOST=127.0.0.1 PORT="$PORT" node --env-file-if-exists=.env dist/server/entry.mjs >.smoke.log 2>&1 &
PID=$!
trap 'kill "$PID" 2>/dev/null || true' EXIT
i=0
until curl -s -o /dev/null "$BASE/api/health"; do
  i=$((i + 1))
  if [ "$i" -ge 30 ]; then
    cat .smoke.log
    exit 1
  fi
  sleep 1
done
HEALTH="$(curl -s "$BASE/api/health")"
echo "$HEALTH" | grep -q '"ok":true'
echo "$HEALTH" | grep -q '"db":true'
code() { curl -s -o /dev/null -w '%{http_code}' "$BASE$1"; }
TODAY="$(node -e 'console.log(new Intl.DateTimeFormat("en-CA",{timeZone:"America/Santiago"}).format(new Date()))')"
test "$(code /)" = 200
test "$(code "/api/disponibilidad?desde=$TODAY&dias=1&modo=taller")" = 200
test "$(code /no-existe)" = 404
test "$(code /admin)" = 303
test "$(code '/reservas/cancelar?token=no-existe')" = 404
test "$(code /robots.txt)" = 200
test "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/tareas/recordatorios")" = 401
test "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/taller/ordenes/x/fotos")" = 401
echo "smoke ok: $HEALTH"
