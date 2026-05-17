#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/services/youtube-audio-proxy"

export PROXY_SECRET="${PROXY_SECRET:-wavrick-local-dev-secret}"
export PORT="${PORT:-5055}"

echo "Starting YouTube audio proxy on http://127.0.0.1:${PORT}/extract"
echo "PROXY_SECRET=${PROXY_SECRET}"
echo "Health: http://127.0.0.1:${PORT}/health"
echo ""
echo "Supabase Edge から使うには ngrok 等で公開してください: ngrok http ${PORT}"
echo "  または: ./scripts/start-audio-tunnel.sh（cloudflared）"
echo ""

# Cursor / IDE の HTTP_PROXY が yt-dlp の YouTube 取得を壊すことがあるため無効化
for _v in HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy \
  GIT_HTTP_PROXY GIT_HTTPS_PROXY SOCKS_PROXY SOCKS5_PROXY socks_proxy socks5_proxy; do
  unset "$_v" 2>/dev/null || true
done

VENV="${ROOT}/services/youtube-audio-proxy/.venv"
if [[ -x "${VENV}/bin/python3" ]]; then
  exec "${VENV}/bin/python3" app.py
fi

if command -v pip3 >/dev/null 2>&1; then
  pip3 install --user -q -r requirements.txt 2>/dev/null \
    || PIP_BREAK_SYSTEM_PACKAGES=1 pip3 install -q -r requirements.txt 2>/dev/null \
    || pip3 install --user -r requirements.txt
  exec python3 app.py
fi

echo "pip3 not found. Install Python 3 or use: docker compose up --build"
exit 1
