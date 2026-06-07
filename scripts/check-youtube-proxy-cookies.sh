#!/usr/bin/env bash
# Railway 音声プロキシが cookies を読めているか /health で確認
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ -f "${ROOT}/.local/secrets.env" ]]; then
  # shellcheck disable=SC1091
  source "${ROOT}/.local/secrets.env"
fi
BASE="${YOUTUBE_AUDIO_PROXY_URL:-}"
if [[ -z "${BASE}" ]]; then
  echo "YOUTUBE_AUDIO_PROXY_URL が未設定です。"
  echo "例: export YOUTUBE_AUDIO_PROXY_URL=https://xxxx.up.railway.app/extract"
  exit 1
fi
HEALTH="${BASE%/extract}/health"
echo "GET ${HEALTH}"
curl -sS "${HEALTH}" | python3 -m json.tool
echo ""
echo "確認:"
echo "  youtubeCookiesLoaded が true → cookies 設定 OK"
echo "  remoteComponents に ejs:github → 最新コードがデプロイ済み"
echo "  どちらかダメなら Railway で Redeploy（GitHub 連携の最新 main）"
