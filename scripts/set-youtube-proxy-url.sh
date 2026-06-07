#!/usr/bin/env bash
# Supabase の YOUTUBE_AUDIO_PROXY_URL を更新（Railway の公開 URL 変更時）
set -euo pipefail
REF="${SUPABASE_PROJECT_REF:-gdolqgcftxqxaacjyqla}"
BASE="${1:-}"
if [[ -z "${BASE}" ]]; then
  echo "使い方: $0 https://あなたのサービス.up.railway.app"
  echo "  （末尾の /extract は自動で付けます）"
  exit 1
fi
BASE="${BASE%/}"
BASE="${BASE%/extract}"
PROXY_URL="${BASE}/extract"
echo "設定する URL: ${PROXY_URL}"
supabase secrets set --project-ref "${REF}" "YOUTUBE_AUDIO_PROXY_URL=${PROXY_URL}"
echo "Done. 続けて: supabase functions deploy media-pipeline youtube-video-meta --project-ref ${REF}"
