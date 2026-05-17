#!/usr/bin/env bash
# Cursor ターミナル用: OAuth 関数デプロイ + 簡易ヘルスチェック
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
REF="gdolqgcftxqxaacjyqla"

echo "=== YouTube OAuth デプロイ ==="
supabase functions deploy youtube-oauth-start youtube-oauth-callback

echo ""
echo "=== ヘルスチェック（302 が理想 = Google へリダイレクト）==="
# anon は index.html と同じ（公開キー）。未設定なら 403 のことがあります
ANON="${SUPABASE_ANON_KEY:-}"
if [[ -z "$ANON" ]] && [[ -f "${ROOT}/index.html" ]]; then
  ANON="$(grep -o 'supabaseAnonKey: "[^"]*"' "${ROOT}/index.html" | head -1 | sed 's/.*"\(.*\)"/\1/')"
fi
URL="https://${REF}.supabase.co/functions/v1/youtube-oauth-start?channel_key=handle:test&parent_origin=http://localhost:8889"
if [[ -n "$ANON" ]]; then
  URL="${URL}&apikey=${ANON}"
fi
curl -sI "$URL" -H "apikey: ${ANON}" | head -8 || true
echo ""
echo "500 / Missing secrets → ./scripts/set-youtube-oauth-secrets.sh"
echo "404 → デプロイ失敗。上の deploy を再実行"
echo ""
echo "ブラウザ: http://localhost:8889 → 依頼フォーム → Googleでチャンネル所有を確認"
