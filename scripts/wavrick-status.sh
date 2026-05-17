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
if pgrep -fl "cloudflared.*${PORT}" >/dev/null 2>&1 || pgrep -fl "cloudflared.*5055" >/dev/null 2>&1; then
  echo "✅ AI用トンネル（cloudflared）… 動いている可能性あり"
else
  echo "⬜ AI用トンネル … 止まっている（AI台本を使う日だけ必要）"
fi

if lsof -ti :5055 >/dev/null 2>&1; then
  echo "✅ YouTube音声プロキシ（5055）… 動いている"
else
  echo "⬜ YouTube音声プロキシ … 止まっている（AI台本を使う日だけ必要）"
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
