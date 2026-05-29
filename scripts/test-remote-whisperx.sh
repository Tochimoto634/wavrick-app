#!/usr/bin/env bash
# リモート（またはローカル）WhisperX の疎通確認
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SECRETS="${ROOT}/.local/secrets.env"

if [[ -f "${SECRETS}" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "${SECRETS}" 2>/dev/null || true
  set +a
fi

BASE="${WHISPERX_SERVICE_URL:-http://127.0.0.1:8081}"
BASE="${BASE%/}"
SECRET="${WHISPERX_SERVICE_SECRET:-${PROXY_SECRET:-wavrick-local-dev-secret}}"

echo "URL: ${BASE}"
echo "GET /health …"
curl -sf "${BASE}/health" | python3 -m json.tool

AUDIO="${1:-}"
if [[ -z "${AUDIO}" ]]; then
  echo ""
  echo "音声テスト: $0 /path/to/audio.mp3"
  exit 0
fi

if [[ ! -f "${AUDIO}" ]]; then
  echo "ファイルがありません: ${AUDIO}"
  exit 1
fi

echo ""
echo "POST /transcribe (${AUDIO}) …"
curl -sf -X POST "${BASE}/transcribe" \
  -H "Authorization: Bearer ${SECRET}" \
  -F "file=@${AUDIO}" \
  -o "${ROOT}/.whisperx-remote-test.json"
python3 -m json.tool "${ROOT}/.whisperx-remote-test.json" | head -40
echo "… saved: ${ROOT}/.whisperx-remote-test.json"
