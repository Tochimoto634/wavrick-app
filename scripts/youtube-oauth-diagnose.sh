#!/usr/bin/env bash
# Google「このアプリのリクエストは無効です」の原因切り分け
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REF="gdolqgcftxqxaacjyqla"
CALLBACK="https://${REF}.supabase.co/functions/v1/youtube-oauth-callback"

ANON=""
if [[ -f "${ROOT}/index.html" ]]; then
  ANON="$(grep -o 'supabaseAnonKey: "[^"]*"' "${ROOT}/index.html" | head -1 | sed 's/.*"\(.*\)"/\1/')"
fi

echo "=== Google OAuth 診断 ==="
echo ""
echo "【Google Cloud に登録すべき値（コピペ）】"
echo ""
echo "■ 承認済みのリダイレクト URI（必須・1文字も違うと失敗）"
echo "  ${CALLBACK}"
echo ""
echo "■ 承認済みの JavaScript 生成元（推奨）"
echo "  http://localhost:8889"
echo "  http://127.0.0.1:8889"
echo ""
echo "■ OAuth 同意画面"
echo "  - スコープに YouTube Data API v3 → youtube.readonly を追加"
echo "  - テスト中なら「テストユーザー」に、ログインする Gmail を追加"
echo "  - YouTube Data API v3 が「有効」になっている同じ GCP プロジェクト"
echo ""
echo "■ Supabase secrets の GOOGLE_CLIENT_ID は、上記と同じ GCP プロジェクトの"
echo "  「ウェブアプリケーション」クライアントの ID であること"
echo ""

if [[ -z "$ANON" ]]; then
  echo "（anon key が取れないのでリダイレクト先の確認はスキップ）"
  exit 0
fi

echo "【secrets の GOOGLE_CLIENT_ID 形式チェック】"
echo "  supabase secrets list では値は見えません。直近で次のように短い ID だけ"
echo "  set していないか確認: ...teebaqppdl7fkp0h7qqrlda72n5nbd8b （× 末尾 .apps... 必須）"
echo ""

URL="https://${REF}.supabase.co/functions/v1/youtube-oauth-start?channel_key=handle:test&parent_origin=http://localhost:8889&apikey=${ANON}"
echo "【実際に Google へ送っている redirect_uri】"
LOC="$(curl -s -D - -o /dev/null -G "$URL" -H "apikey: ${ANON}" --max-redirs 0 2>/dev/null | awk 'tolower($1)=="location:"{print $2}' | tr -d '\r' || true)"
if [[ -z "$LOC" ]]; then
  LOC="$(curl -s -o /dev/null -w "%{redirect_url}" -G "$URL" -H "apikey: ${ANON}" --max-redirs 0 2>/dev/null || true)"
fi
if [[ -z "$LOC" ]]; then
  BODY="$(curl -s "$URL" -H "apikey: ${ANON}" | head -c 300)"
  echo "  302 ではありませんでした。応答:"
  echo "  ${BODY}"
  echo ""
  echo "  → secrets 未設定なら: ./scripts/set-youtube-oauth-secrets.sh"
  exit 0
fi

REDIRECT_URI="$(python3 -c "
from urllib.parse import urlparse, parse_qs
import sys
q = parse_qs(urlparse(sys.argv[1]).query)
print(q.get('redirect_uri',[''])[0])
" "$LOC" 2>/dev/null || echo "")"

if [[ -n "$REDIRECT_URI" ]]; then
  echo "  ${REDIRECT_URI}"
  if [[ "$REDIRECT_URI" == "$CALLBACK" ]]; then
    echo ""
    echo "  ✅ コードが送る URI と推奨登録値は一致しています。"
    echo "  → Google Console の「承認済みのリダイレクト URI」に上と完全一致があるか確認してください。"
  else
    echo ""
    echo "  ⚠️ 推奨値と不一致。Console には実際の値を登録するか、設定を見直してください。"
  fi
else
  echo "  （Google へのリダイレクト URL から redirect_uri を取得できませんでした）"
  echo "  Location: ${LOC:0:120}..."
fi
