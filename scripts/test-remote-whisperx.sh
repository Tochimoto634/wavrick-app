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

# shellcheck source=scripts/_whisperx_url.sh
source "${ROOT}/scripts/_whisperx_url.sh"

BASE="$(wavrick_whisperx_base_url)"
HEALTH_PATH="$(wavrick_whisperx_health_path)"
SECRET="${WHISPERX_SERVICE_SECRET:-${PROXY_SECRET:-wavrick-local-dev-secret}}"
RUNPOD_KEY="${RUNPOD_API_KEY:-}"

AUTH_HEADER=()
if [[ -n "${RUNPOD_KEY}" ]]; then
  AUTH_HEADER=(-H "Authorization: Bearer ${RUNPOD_KEY}")
elif [[ -n "${SECRET}" ]]; then
  AUTH_HEADER=(-H "Authorization: Bearer ${SECRET}")
fi

echo "URL: ${BASE}"
echo "GET ${HEALTH_PATH} …"
HTTP_CODE="$(curl -sS -o /tmp/wavrick-whisperx-health.json -w "%{http_code}" "${AUTH_HEADER[@]}" "${BASE}${HEALTH_PATH}")"
echo "HTTP ${HTTP_CODE}"
if [[ "${HTTP_CODE}" == "204" ]]; then
  echo "モデルロード中（RunPod Serverless）"
elif [[ "${HTTP_CODE}" == "200" ]]; then
  python3 -m json.tool /tmp/wavrick-whisperx-health.json
else
  cat /tmp/wavrick-whisperx-health.json
  exit 1
fi

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
  "${AUTH_HEADER[@]}" \
  -F "file=@${AUDIO}" \
  -o "${ROOT}/.whisperx-remote-test.json"
python3 -m json.tool "${ROOT}/.whisperx-remote-test.json" | head -40
echo "… saved: ${ROOT}/.whisperx-remote-test.json"
