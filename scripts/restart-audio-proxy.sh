#!/usr/bin/env bash
# 音声プロキシ (5055) を停止して最新 app.py + demucs で再起動
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-5055}"

echo "ポート ${PORT} の既存プロセスを停止…"
lsof -ti ":${PORT}" 2>/dev/null | xargs kill -9 2>/dev/null || true
sleep 1

if ! "${ROOT}/services/youtube-audio-proxy/.venv/bin/python3" -c "import demucs" 2>/dev/null; then
  echo "demucs 未導入 → install-demucs.sh を実行します"
  "${ROOT}/scripts/install-demucs.sh"
fi

echo "プロキシ起動…"
exec "${ROOT}/scripts/start-audio-proxy.sh"
