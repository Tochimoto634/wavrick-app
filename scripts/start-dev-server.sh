#!/usr/bin/env bash
# WAVRICK ローカル表示用（http://localhost:8889）
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-8889}"
cd "$ROOT"

if lsof -ti ":${PORT}" >/dev/null 2>&1; then
  echo "port ${PORT} は既に使用中です（古い [Wavrick-N] のままのことがあります）。"
  lsof -i ":${PORT}" -P 2>/dev/null | head -3
  echo ""
  echo "開くURL: http://127.0.0.1:${PORT}/"
  echo "最新コードで再起動: ./scripts/restart-local-ai.sh"
  echo "止めるだけ: lsof -ti :${PORT} | xargs kill -9"
  exit 0
fi

echo "WAVRICK → http://127.0.0.1:${PORT}/"
echo "AI台本: トンネル不要。別ターミナルで:"
echo "  ./scripts/start-audio-proxy.sh   (5055)"
echo "  ./scripts/start-whisperx.sh      (8081・文字起こし)"
echo "APIキー: .local/secrets.env（scripts/secrets.env.example 参照）"
echo "まとめて起動: ./scripts/start-local-ai.sh"
echo "（止める: Ctrl+C）"
exec python3 "${ROOT}/scripts/dev_server.py" "$PORT"
