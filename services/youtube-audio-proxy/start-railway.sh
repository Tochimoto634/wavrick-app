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

# gthread: /health and 503 BUSY stay responsive while yt-dlp holds a thread.
# timeout 240s must stay below Edge PROXY_EXTRACT_TIMEOUT_MS (250s) so gunicorn
# can finish/fail the HTTP request instead of Deno aborting with "Signal timed out".
THREADS="${WAVRICK_GUNICORN_THREADS:-4}"
GUNICORN_TIMEOUT="${WAVRICK_GUNICORN_TIMEOUT:-240}"
exec gunicorn --bind "0.0.0.0:${PORT:-8080}" \
  --worker-class gthread \
  --workers 1 \
  --threads "${THREADS}" \
  --timeout "${GUNICORN_TIMEOUT}" \
  app:app
