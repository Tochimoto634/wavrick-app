#!/usr/bin/env bash
# Cursor ターミナル用: AI 台本に必要な「プロキシ + トンネル + secrets」をまとめて整える
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
LOG_DIR="${ROOT}/.local/logs"
mkdir -p "$LOG_DIR"
VENV="${ROOT}/services/youtube-audio-proxy/.venv"
PORT_PROXY="${PORT:-5055}"
SECRET="${PROXY_SECRET:-wavrick-local-dev-secret}"
CF="${ROOT}/.local/bin/cloudflared"

# IDE プロキシで yt-dlp が壊れないように
for _v in HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy \
  GIT_HTTP_PROXY GIT_HTTPS_PROXY SOCKS_PROXY SOCKS5_PROXY socks_proxy socks5_proxy; do
  unset "$_v" 2>/dev/null || true
done

echo "=== WAVRICK AI セットアップ（Cursor用）==="
echo ""

# --- 音声プロキシ（先に確認。動いていれば venv 不要）---
if curl -sf "http://127.0.0.1:${PORT_PROXY}/health" >/dev/null 2>&1; then
  echo "[1/5] 音声プロキシは既に起動中 (port ${PORT_PROXY}) ← そのまま使います"
else
  echo "[1/5] 音声プロキシを準備..."
  if [[ ! -x "${VENV}/bin/python3" ]]; then
    if python3 -c "import flask, yt_dlp" 2>/dev/null; then
      echo "    システム Python に flask/yt_dlp あり（venv スキップ）"
    else
      echo "    Python venv を作成..."
      python3 -m venv "$VENV"
      "${VENV}/bin/pip" install -q -r "${ROOT}/services/youtube-audio-proxy/requirements.txt"
    fi
  elif ! "${VENV}/bin/python3" -c "import flask, yt_dlp" 2>/dev/null; then
    echo "    venv に flask/yt_dlp がないため pip install..."
    "${VENV}/bin/pip" install -q -r "${ROOT}/services/youtube-audio-proxy/requirements.txt"
  fi
  echo "    音声プロキシを起動 (port ${PORT_PROXY})..."
  lsof -ti ":${PORT_PROXY}" 2>/dev/null | xargs kill -9 2>/dev/null || true
  sleep 1
  PY="python3"
  [[ -x "${VENV}/bin/python3" ]] && PY="${VENV}/bin/python3"
  (
    cd "${ROOT}/services/youtube-audio-proxy"
    export PROXY_SECRET="$SECRET" PORT="$PORT_PROXY"
    exec "$PY" app.py
  ) >>"${LOG_DIR}/audio-proxy.log" 2>&1 &
  echo $! >"${LOG_DIR}/audio-proxy.pid"
  for _ in $(seq 1 15); do
    curl -sf "http://127.0.0.1:${PORT_PROXY}/health" >/dev/null && break
    sleep 1
  done
  curl -sf "http://127.0.0.1:${PORT_PROXY}/health" >/dev/null || {
    echo "プロキシ起動失敗。ログ: ${LOG_DIR}/audio-proxy.log"
    tail -20 "${LOG_DIR}/audio-proxy.log" || true
    exit 1
  }
  echo "    → http://127.0.0.1:${PORT_PROXY}/health OK"
fi

# --- cloudflared ---
if [[ ! -x "$CF" ]]; then
  echo "cloudflared がありません。ダウンロード中..."
  mkdir -p "${ROOT}/.local/bin"
  curl -fsSL -o "${ROOT}/.local/bin/cloudflared.tgz" \
    "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz"
  tar -xzf "${ROOT}/.local/bin/cloudflared.tgz" -C "${ROOT}/.local/bin" cloudflared
  chmod +x "$CF"
fi

echo "[2/5] トンネルを再起動..."
if [[ -f "${LOG_DIR}/tunnel.pid" ]]; then
  kill "$(cat "${LOG_DIR}/tunnel.pid")" 2>/dev/null || true
fi
pkill -f "cloudflared tunnel --url http://127.0.0.1:${PORT_PROXY}" 2>/dev/null || true
sleep 1
: >"${LOG_DIR}/tunnel.log"
"$CF" tunnel --url "http://127.0.0.1:${PORT_PROXY}" >>"${LOG_DIR}/tunnel.log" 2>&1 &
echo $! >"${LOG_DIR}/tunnel.pid"

TUNNEL_URL=""
for _ in $(seq 1 30); do
  TUNNEL_URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "${LOG_DIR}/tunnel.log" 2>/dev/null | head -1 || true)"
  [[ -n "$TUNNEL_URL" ]] && break
  sleep 1
done

if [[ -z "$TUNNEL_URL" ]]; then
  echo "トンネル URL を取得できませんでした。ログ末尾:"
  tail -15 "${LOG_DIR}/tunnel.log" || true
  echo ""
  echo "手動: 別タブで ./scripts/start-audio-tunnel.sh を実行し、表示 URL を"
  echo "  ./scripts/set-youtube-proxy-secrets.sh <URL> に渡してください。"
  exit 1
fi
echo "    → ${TUNNEL_URL}"

# --- ローカル extract テスト ---
echo "[3/5] ローカル extract テスト..."
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 600 \
  -X POST "http://127.0.0.1:${PORT_PROXY}/extract" \
  -H "Authorization: Bearer ${SECRET}" \
  -H "Content-Type: application/json" \
  -d '{"videoUrl":"https://www.youtube.com/watch?v=jNQXAC9IVRw"}' || echo "000")
if [[ "$HTTP_CODE" == "200" ]]; then
  echo "    → extract OK (HTTP 200)"
else
  echo "    → extract HTTP ${HTTP_CODE}（YouTube 取得失敗の可能性。ログ: ${LOG_DIR}/audio-proxy.log）"
fi

# --- Supabase secrets ---
echo "[4/5] Supabase secrets を更新..."
if "${ROOT}/scripts/set-youtube-proxy-secrets.sh" "$TUNNEL_URL"; then
  echo ""
  echo "=== 完了 ==="
  echo "ブラウザ: http://localhost:8889 （既に起動中ならそのまま）"
  echo "トンネル: ${TUNNEL_URL}/extract"
  echo "ログ: ${LOG_DIR}/"
  echo ""
  echo "依頼フォーム → 短い YouTube URL →「動画URLから台本を自動生成」"
else
  echo ""
  echo "secrets 更新に失敗（supabase login が必要かも）。手動:"
  echo "  ./scripts/set-youtube-proxy-secrets.sh ${TUNNEL_URL}"
  exit 1
fi
