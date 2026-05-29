#!/usr/bin/env bash
# 音声プロキシ (5055) が止まっていたらバックグラウンドで起動（トンネルは作らない）
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-5055}"
LOG_DIR="${ROOT}/.local/logs"
mkdir -p "$LOG_DIR"

if curl -sf "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
  echo "音声プロキシは既に起動中 (port ${PORT})"
  exit 0
fi

echo "音声プロキシを起動します (port ${PORT})…"
VENV="${ROOT}/services/youtube-audio-proxy/.venv"
PY="python3"
if [[ ! -x "${VENV}/bin/python3" ]]; then
  echo "仮想環境を作成しています（初回のみ数分かかります）…"
  python3 -m venv "${VENV}"
  "${VENV}/bin/pip" install -q --upgrade pip
  "${VENV}/bin/pip" install -q -r "${ROOT}/services/youtube-audio-proxy/requirements.txt" \
    || "${VENV}/bin/pip" install -r "${ROOT}/services/youtube-audio-proxy/requirements.txt"
fi
[[ -x "${VENV}/bin/python3" ]] && PY="${VENV}/bin/python3"
lsof -ti ":${PORT}" 2>/dev/null | xargs kill -9 2>/dev/null || true
sleep 1
(
  cd "${ROOT}/services/youtube-audio-proxy"
  export PROXY_SECRET="${PROXY_SECRET:-wavrick-local-dev-secret}" PORT="${PORT}"
  exec "$PY" app.py
) >>"${LOG_DIR}/audio-proxy.log" 2>&1 &
echo $! >"${LOG_DIR}/audio-proxy.pid"
for _ in $(seq 1 15); do
  curl -sf "http://127.0.0.1:${PORT}/health" >/dev/null && break
  sleep 1
done
curl -sf "http://127.0.0.1:${PORT}/health" >/dev/null && echo "→ OK" || {
  echo "起動失敗。ログ: ${LOG_DIR}/audio-proxy.log"
  tail -10 "${LOG_DIR}/audio-proxy.log" || true
  exit 1
}
