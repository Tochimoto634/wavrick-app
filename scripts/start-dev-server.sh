#!/usr/bin/env bash
# WAVRICK ローカル表示用（http://localhost:8889）
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-8889}"
cd "$ROOT"

if lsof -ti ":${PORT}" >/dev/null 2>&1; then
  echo "port ${PORT} は既に使用中です。"
  lsof -i ":${PORT}" -P 2>/dev/null | head -3
  echo ""
  echo "開くURL: http://127.0.0.1:${PORT}/"
  echo "止める: lsof -ti :${PORT} | xargs kill -9"
  exit 0
fi

echo "WAVRICK → http://127.0.0.1:${PORT}/"
echo "（止める: Ctrl+C）"
exec python3 "${ROOT}/scripts/dev_server.py" "$PORT"
