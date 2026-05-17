#!/usr/bin/env bash
# Hostinger に FTP / ファイルマネージャで上げる ZIP を作る
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${ROOT}/dist/wavrick-hostinger-upload.zip"
mkdir -p "${ROOT}/dist"

rm -f "$OUT"
cd "$ROOT"
zip -r "$OUT" \
  index.html \
  app.js \
  styles.css \
  oauth-done.html \
  .htaccess

echo ""
echo "できました: $OUT"
echo ""
echo "Hostinger → ファイルマネージャ → public_html の下のフォルダ例:"
echo "  public_html/wavrick/  ← ここに ZIP を解凍（WordPress 本体は触らない）"
echo "  開くURL例: https://あなたのドメイン/wavrick/"
echo ""
echo "※ トップ（/）を WAVRICK にしたい場合は WordPress と競合するので、"
echo "   サブドメイン（app.ドメイン）の方が安全です。"
