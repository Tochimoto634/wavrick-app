#!/bin/sh
set -eu

# Script-mode POT (bgutil) is invoked by yt-dlp; optional HTTP server is best-effort.
POT_PORT="${WAVRICK_YT_POT_PORT:-4416}"
POT_ENABLED="${WAVRICK_YT_POT_ENABLED:-1}"
POT_SERVER_HOME="${WAVRICK_YT_POT_SERVER_HOME:-/opt/bgutil/server}"
NODE_BIN="${WAVRICK_NODE_PATH:-/usr/local/bin/node}"

if [ "${POT_ENABLED}" != "0" ] && [ -x "${NODE_BIN}" ] && [ -f "${POT_SERVER_HOME}/build/main.js" ]; then
  (
    cd "${POT_SERVER_HOME}"
    "${NODE_BIN}" build/main.js --port "${POT_PORT}"
  ) >/tmp/bgutil-pot.log 2>&1 &
fi

export PATH="/usr/local/bin:${PATH}"

exec gunicorn --bind "0.0.0.0:${PORT:-8080}" --workers 1 --timeout 300 app:app
