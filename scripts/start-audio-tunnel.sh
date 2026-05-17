#!/usr/bin/env bash
# ローカル音声プロキシ (5055) を HTTPS で公開（Supabase Edge 用）
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-5055}"
# 5055 がゾンビプロセスで塞がっている場合: PORT=5056 ./scripts/start-audio-tunnel.sh
CF="${ROOT}/.local/bin/cloudflared"

if [[ ! -x "$CF" ]]; then
  echo "cloudflared がありません。初回のみ:"
  echo "  mkdir -p ${ROOT}/.local/bin"
  echo "  curl -fsSL -o ${ROOT}/.local/bin/cloudflared.tgz \\"
  echo "    https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz"
  echo "  tar -xzf ${ROOT}/.local/bin/cloudflared.tgz -C ${ROOT}/.local/bin cloudflared"
  echo "  chmod +x ${ROOT}/.local/bin/cloudflared"
  exit 1
fi

if ! curl -sf "http://127.0.0.1:${PORT}/health" >/dev/null; then
  echo "先に別ターミナルで: ./scripts/start-audio-proxy.sh"
  exit 1
fi

echo "=== cloudflared quick tunnel → http://127.0.0.1:${PORT} ==="
echo "表示された https://*.trycloudflare.com をコピーし、末尾に /extract を付けて:"
echo "  supabase secrets set YOUTUBE_AUDIO_PROXY_URL=https://XXXX.trycloudflare.com/extract \\"
echo "    YOUTUBE_AUDIO_PROXY_SECRET=wavrick-local-dev-secret"
echo ""
exec "$CF" tunnel --url "http://127.0.0.1:${PORT}"
