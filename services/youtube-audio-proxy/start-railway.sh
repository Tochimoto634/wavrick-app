#!/bin/sh
set -eu

POT_PORT="${WAVRICK_YT_POT_PORT:-4416}"
POT_ENABLED="${WAVRICK_YT_POT_ENABLED:-1}"

if [ "${POT_ENABLED}" != "0" ] && [ -f /opt/bgutil/server/build/main.js ]; then
  echo "Starting bgutil POT provider on 127.0.0.1:${POT_PORT} ..."
  node /opt/bgutil/server/build/main.js --port "${POT_PORT}" &
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    if curl -sf "http://127.0.0.1:${POT_PORT}/ping" >/dev/null 2>&1; then
      echo "POT provider ready."
      break
    fi
    sleep 1
  done
fi

exec gunicorn --bind "0.0.0.0:${PORT:-8080}" --workers 1 --timeout 300 app:app
