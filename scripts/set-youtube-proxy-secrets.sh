#!/usr/bin/env bash
# 公開 URL を Supabase secrets に反映（要: supabase login + link 済み）
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PUBLIC_BASE="${1:-}"
SECRET="${YOUTUBE_AUDIO_PROXY_SECRET:-wavrick-local-dev-secret}"

if [[ -z "$PUBLIC_BASE" ]]; then
  echo "使い方: $0 https://xxxx.ngrok-free.app"
  echo "       $0 https://xxxx.trycloudflare.com"
  echo "  （/extract は自動で付与します）"
  exit 1
fi

PUBLIC_BASE="${PUBLIC_BASE%/}"
if [[ "$PUBLIC_BASE" == */extract ]]; then
  PROXY_URL="$PUBLIC_BASE"
else
  PROXY_URL="${PUBLIC_BASE}/extract"
fi

echo "Setting:"
echo "  YOUTUBE_AUDIO_PROXY_URL=${PROXY_URL}"
echo "  YOUTUBE_AUDIO_PROXY_SECRET=${SECRET}"
supabase secrets set \
  "YOUTUBE_AUDIO_PROXY_URL=${PROXY_URL}" \
  "YOUTUBE_AUDIO_PROXY_SECRET=${SECRET}"
echo "Done. 依頼フォームで「動画URLから台本を自動生成」を試してください。"
