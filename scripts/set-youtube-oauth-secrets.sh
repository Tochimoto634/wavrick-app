#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

CLIENT_ID="${GOOGLE_CLIENT_ID:-}"
CLIENT_SECRET="${GOOGLE_CLIENT_SECRET:-}"
STATE_SECRET="${YOUTUBE_OAUTH_STATE_SECRET:-}"

if [[ -z "$CLIENT_ID" ]]; then
  read -r -p "GOOGLE_CLIENT_ID: " CLIENT_ID
fi
if [[ -z "$CLIENT_SECRET" ]]; then
  read -r -s -p "GOOGLE_CLIENT_SECRET: " CLIENT_SECRET
  echo ""
fi
if [[ -z "$STATE_SECRET" ]]; then
  if command -v openssl >/dev/null 2>&1; then
    STATE_SECRET="$(openssl rand -hex 32)"
    echo "YOUTUBE_OAUTH_STATE_SECRET を自動生成しました"
  else
    read -r -p "YOUTUBE_OAUTH_STATE_SECRET (32文字以上推奨): " STATE_SECRET
  fi
fi

if [[ -z "$CLIENT_ID" || -z "$CLIENT_SECRET" || -z "$STATE_SECRET" ]]; then
  echo "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / YOUTUBE_OAUTH_STATE_SECRET が必要です。"
  exit 1
fi

if [[ "$CLIENT_ID" != *".apps.googleusercontent.com" ]]; then
  echo "ERROR: GOOGLE_CLIENT_ID の末尾が .apps.googleusercontent.com ではありません。"
  echo "  入力値: ${CLIENT_ID}"
  echo "  Google Console の「クライアント ID」をコピペし直してください（短い数字だけでは不可）。"
  exit 1
fi

supabase secrets set \
  "GOOGLE_CLIENT_ID=${CLIENT_ID}" \
  "GOOGLE_CLIENT_SECRET=${CLIENT_SECRET}" \
  "YOUTUBE_OAUTH_STATE_SECRET=${STATE_SECRET}"

echo "Done. 次: supabase functions deploy youtube-oauth-start youtube-oauth-callback"
