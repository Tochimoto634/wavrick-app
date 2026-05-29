#!/usr/bin/env bash
# Hostinger 本番用 ZIP + 同梱ファイル検証
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
  js/wavrick-customer-account.js \
  js/wavrick-pricing.js \
  js/wavrick-transaction.js \
  js/wavrick-work-cases.js \
  js/wavrick-delivery-handoff.js \
  js/wavrick-speaker-assign.js \
  js/wavrick-talent-stats.js \
  record-workspace.html \
  record-workspace.css \
  record-workspace-mic-test.html \
  record-booth.html \
  record-booth.css \
  js/record-workspace \
  js/record-booth \
  oauth-done.html \
  .htaccess

cd "$ROOT/hostinger"
zip -j "$REDIRECT_ZIP" wavrick-v3-redirect.html

echo ""
echo "=== ZIP 同梱チェック ==="
for f in \
  index.html \
  app.js \
  styles.css \
  js/wavrick-speaker-assign.js \
  js/wavrick-talent-stats.js \
  record-workspace.html \
  record-booth.html \
  js/record-workspace/app.js \
  js/record-workspace/script-cue-ops.js \
  js/record-booth/booth-app.js; do
  if unzip -l "$APP_ZIP" | awk '{print $NF}' | grep -qxF "$f"; then
    echo "  OK  $f"
  else
    echo "  NG  $f （ZIP に無い）"
    exit 1
  fi
done

echo ""
echo "=== キャッシュバスター（index.html）==="
grep -E 'app\.js\?v=|styles\.css\?v=' "$ROOT/index.html" || true

echo ""
echo "=== デプロイ手順 ==="
echo "  詳細: hostinger/DEPLOY-RELEASE-1.md"
echo ""
echo "=== できました ==="
echo "1) $APP_ZIP"
echo "2) $REDIRECT_ZIP"
echo ""
echo "open \"$APP_ZIP\""
