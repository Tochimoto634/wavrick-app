#!/usr/bin/env bash
# Hostinger に FTP / ファイルマネージャで上げる ZIP を作る（旧 wavrick-v3.html の差し替え用）
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="${ROOT}/dist"
APP_ZIP="${DIST}/wavrick-hostinger-upload.zip"
REDIRECT_ZIP="${DIST}/wavrick-v3-redirect.zip"
mkdir -p "$DIST"

rm -f "$APP_ZIP" "$REDIRECT_ZIP"
cd "$ROOT"
zip -r "$APP_ZIP" \
  index.html \
  app.js \
  styles.css \
  oauth-done.html \
  .htaccess

cd "$ROOT/hostinger"
zip -j "$REDIRECT_ZIP" wavrick-v3-redirect.html

echo ""
echo "=== できました（2つ）==="
echo "1) 新アプリ本体: $APP_ZIP"
echo "   → public_html 直下に解凍（index.html がトップ）"
echo "   → https://wavrick.com/"
echo ""
echo "2) 旧URL用リダイレクト: $REDIRECT_ZIP"
echo "   → public_html/wavrick-v3.html として配置（任意）"
echo ""
echo "※ 以前 /wavrick/ に置いていた場合:"
echo "   public_html/wavrick/index.html を hostinger/wavrick-subfolder-redirect.html に差し替えると / へ誘導できます。"
