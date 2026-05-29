#!/usr/bin/env bash
# いま何が動いているか・次に何をすればいいか（日本語）
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT=8889

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  WAVRICK いまの状態"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if lsof -ti ":${PORT}" >/dev/null 2>&1; then
  echo "✅ サイト用サーバー … 動いています（ポート ${PORT}）"
  echo "   ブラウザ → http://127.0.0.1:${PORT}/"
else
  echo "⬜ サイト用サーバー … 止まっています"
  echo ""
  echo "   【やること】どれか1つのターミナルで:"
  echo "   cd ${ROOT}"
  echo "   ./scripts/start-dev-server.sh"
  echo "   （表示が出たらそのターミナルは閉じない）"
fi

echo ""
if curl -sf "http://127.0.0.1:${PORT}/api/media-pipeline" -X OPTIONS >/dev/null 2>&1; then
  echo "✅ ローカル AI API (/api/media-pipeline) … 利用可（8889 はトンネル不要）"
elif lsof -ti ":${PORT}" >/dev/null 2>&1; then
  echo "⚠️  8889 は動いていますが dev_server ではない可能性（python3 -m http.server だと AI 不可）"
  echo "    → ./scripts/start-dev-server.sh で起動し直してください"
fi

if pgrep -fl "cloudflared.*5055" >/dev/null 2>&1; then
  echo "✅ Cloudflare トンネル … 動いている（本番 Supabase 経由の開発向け）"
else
  echo "⬜ Cloudflare トンネル … 不要（http://127.0.0.1:8889 のみ使う場合）"
fi

if curl -sf http://127.0.0.1:5055/health >/dev/null 2>&1; then
  echo "✅ YouTube音声プロキシ（5055）… 動いている"
else
  echo "⬜ YouTube音声プロキシ … 止まっている"
  echo "    → ./scripts/start-audio-proxy.sh"
fi

if curl -sf http://127.0.0.1:8081/health >/dev/null 2>&1; then
  wx_build="$(curl -sf http://127.0.0.1:8081/health 2>/dev/null | python3 -c 'import sys,json; print(json.load(sys.stdin).get("build","?"))' 2>/dev/null || echo "?")"
  if [ "$wx_build" = "3" ]; then
    echo "✅ WhisperX（8081）… build 3（無音検出・最新）"
  else
    echo "⚠️  WhisperX（8081）… 動いているが build=${wx_build}（3 なら再起動）"
  fi
else
  echo "⬜ WhisperX … 止まっている"
  echo "    → ./scripts/install-whisperx.sh（初回）→ ./scripts/start-whisperx.sh"
fi

if [[ -f "${ROOT}/.local/secrets.env" ]] || [[ -n "${XAI_API_KEY:-}" ]]; then
  echo "✅ xAI (Grok) キー … 設定あり"
else
  echo "⬜ xAI キー … .local/secrets.env に XAI_API_KEY（台本生成に必要）"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ターミナルは最大2枚でOK"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  [1] サイト用 … start-dev-server だけ（普段はこれだけ）"
echo "  [2] 作業用 … supabase deploy など（必要なときだけ開く）"
echo ""
echo "  deploy を [1] に貼ってもサイトは壊れません。"
echo "  ただログが流れて分かりにくいだけです。"
echo ""
