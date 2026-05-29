#!/usr/bin/env bash
# WhisperX サービス（CPU）— http://127.0.0.1:8081
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SVC="${ROOT}/services/whisperx-service"
VENV="${SVC}/.venv"

export WHISPERX_SERVICE_SECRET="${WHISPERX_SERVICE_SECRET:-wavrick-local-dev-secret}"
export WHISPERX_DEVICE="${WHISPERX_DEVICE:-cpu}"
export WHISPERX_MODEL="${WHISPERX_MODEL:-large-v3}"
export WHISPERX_COMPUTE_TYPE="${WHISPERX_COMPUTE_TYPE:-int8}"
export WHISPERX_BATCH_SIZE="${WHISPERX_BATCH_SIZE:-8}"
export PORT="${PORT:-8081}"

if [[ ! -x "${VENV}/bin/python3" ]]; then
  echo "venv がありません。先に実行: ./scripts/install-whisperx.sh"
  exit 1
fi

if ! "${VENV}/bin/python3" -c "import whisperx" 2>/dev/null; then
  echo "whisperx 未導入 → ./scripts/install-whisperx.sh"
  exit 1
fi

cd "${SVC}"
echo "WhisperX (CPU) build 8 → http://127.0.0.1:${PORT}"
echo "  Health:  curl http://127.0.0.1:${PORT}/health"
echo "  Secret:  WHISPERX_SERVICE_SECRET=${WHISPERX_SERVICE_SECRET}"
echo "  Model:   ${WHISPERX_MODEL} device=${WHISPERX_DEVICE} compute=${WHISPERX_COMPUTE_TYPE}"
echo ""
echo "初回リクエスト時にモデルダウンロードがあり数分かかります。"
echo "Supabase / media-pipeline 用: WHISPERX_SERVICE_URL=http://127.0.0.1:${PORT}"
echo ""

for _v in HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy; do
  unset "$_v" 2>/dev/null || true
done

exec "${VENV}/bin/uvicorn" app:app --host 127.0.0.1 --port "${PORT}" --timeout-keep-alive 600
