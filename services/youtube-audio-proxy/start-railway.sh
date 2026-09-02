#!/bin/sh
set -eu

POT_PORT="${WAVRICK_YT_POT_PORT:-4416}"
POT_ENABLED="${WAVRICK_YT_POT_ENABLED:-1}"
POT_SERVER_HOME="${WAVRICK_YT_POT_SERVER_HOME:-/opt/bgutil/server}"

if [ "${POT_ENABLED}" != "0" ] && [ -f "${POT_SERVER_HOME}/build/main.js" ]; then
  echo "Starting bgutil POT provider on 127.0.0.1:${POT_PORT} ..."
  (
    cd "${POT_SERVER_HOME}"
    node build/main.js --port "${POT_PORT}"
  ) >/tmp/bgutil-pot.log 2>&1 &
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do
    if curl -sf "http://127.0.0.1:${POT_PORT}/ping" >/dev/null 2>&1; then
      echo "POT provider ready."
      break
    fi
    sleep 1
  done
  if ! curl -sf "http://127.0.0.1:${POT_PORT}/ping" >/dev/null 2>&1; then
    echo "WARN: POT provider did not respond; yt-dlp will try script mode fallback."
    tail -n 20 /tmp/bgutil-pot.log 2>/dev/null || true
  fi
fi

exec gunicorn --bind "0.0.0.0:${PORT:-8080}" --workers 1 --timeout 300 app:app
