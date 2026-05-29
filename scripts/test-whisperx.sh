#!/usr/bin/env bash
# WhisperX ヘルスチェック + 任意で短い音声を文字起こし
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-8081}"
BASE="http://127.0.0.1:${PORT}"
SECRET="${WHISPERX_SERVICE_SECRET:-wavrick-local-dev-secret}"

echo "GET ${BASE}/health"
health="$(curl -sf "${BASE}/health")"
echo "$health" | python3 -m json.tool
build="$(echo "$health" | python3 -c "import sys,json; print(json.load(sys.stdin).get('build','?'))" 2>/dev/null || echo "?")"
if [ "$build" = "3" ]; then
  echo "OK: WhisperX build 3（無音検出あり）"
else
  echo "WARN: build=${build}（3 ではない → ./scripts/start-whisperx.sh で再起動）"
fi

AUDIO="${1:-}"
if [[ -z "${AUDIO}" ]]; then
  echo ""
  echo "音声テスト: $0 /path/to/audio.mp3"
  exit 0
fi

if [[ ! -f "${AUDIO}" ]]; then
  echo "File not found: ${AUDIO}"
  exit 1
fi

echo ""
echo "POST ${BASE}/transcribe (CPU — 初回はモデル読込で数分)"
curl -sf -X POST "${BASE}/transcribe" \
  -H "Authorization: Bearer ${SECRET}" \
  -F "file=@${AUDIO}" \
  -o "${ROOT}/.whisperx-test-out.json"

python3 -m json.tool "${ROOT}/.whisperx-test-out.json" | head -80
echo ""
echo "Full JSON: ${ROOT}/.whisperx-test-out.json"
