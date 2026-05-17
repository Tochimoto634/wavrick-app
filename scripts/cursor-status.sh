#!/usr/bin/env bash
# いま何が動いているか一覧（Cursor ターミナル用）
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
echo "=== WAVRICK 状態 ==="
echo ""
for port in 8889 5055 5056; do
  if lsof -i ":${port}" -P >/dev/null 2>&1; then
    echo "✅ port ${port} … 起動中"
    lsof -i ":${port}" -P 2>/dev/null | tail -1
  else
    echo "⬜ port ${port} … 停止"
  fi
done
echo ""
if pgrep -fl cloudflared >/dev/null 2>&1; then
  echo "✅ cloudflared … 起動中"
  pgrep -fl cloudflared | head -2
  if [[ -f "${ROOT}/.local/logs/tunnel.log" ]]; then
    url="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "${ROOT}/.local/logs/tunnel.log" 2>/dev/null | tail -1 || true)"
    [[ -n "$url" ]] && echo "   URL: ${url}/extract"
  fi
else
  echo "⬜ cloudflared … 停止"
fi
echo ""
curl -sf http://127.0.0.1:8889/ >/dev/null && echo "✅ http://localhost:8889 … WAVRICK 応答 OK" || echo "⬜ http://localhost:8889 … 未起動（cd wavrick-app && python3 -m http.server 8889）"
curl -sf http://127.0.0.1:5055/health >/dev/null && echo "✅ http://127.0.0.1:5055/health … プロキシ OK" || echo "⬜ 音声プロキシ … 未起動（./scripts/start-audio-proxy.sh）"
echo ""
echo "AI 台本: ./scripts/cursor-ai-setup.sh"
echo "YouTube OAuth: ./scripts/youtube-oauth-setup.sh → set-youtube-oauth-secrets → cursor-youtube-oauth.sh"
echo "（8889 の http.server は止めないで OK）"
