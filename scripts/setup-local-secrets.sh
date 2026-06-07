#!/usr/bin/env bash
# .local/secrets.env に API キーを書き込む（対話式）
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${ROOT}/.local/secrets.env"
mkdir -p "${ROOT}/.local"

echo "=== WAVRICK ローカル API キー設定 ==="
echo ""
echo "保存先: ${DEST}"
echo "（Supabase の secrets とは別です。ここに書かないと 127.0.0.1:8889 では動きません）"
echo ""

if [[ -f "$DEST" ]]; then
  echo "現在の OPENAI_API_KEY の長さ: $(grep -E '^OPENAI_API_KEY=' "$DEST" 2>/dev/null | cut -d= -f2- | wc -c | tr -d ' ')"
  echo "（40 未満ならまだ sk-... のサンプルのままです）"
  echo ""
fi

read -r -p "OpenAI API キー (sk- で始まる長い文字列) を貼り付けて Enter: " OPENAI_KEY
OPENAI_KEY="${OPENAI_KEY//$'\r'/}"
OPENAI_KEY="${OPENAI_KEY#"${OPENAI_KEY%%[![:space:]]*}"}"
OPENAI_KEY="${OPENAI_KEY%"${OPENAI_KEY##*[![:space:]]}"}"

if [[ -z "$OPENAI_KEY" ]]; then
  echo "キャンセルしました。"
  exit 1
fi
if [[ "$OPENAI_KEY" == *"..."* ]] || [[ ${#OPENAI_KEY} -lt 40 ]]; then
  echo "❌ キーが短すぎるか sk-... のままです。platform.openai.com/api-keys で作成した本物を貼ってください。"
  exit 1
fi
if [[ ! "$OPENAI_KEY" =~ ^sk- ]]; then
  echo "❌ sk- で始まる OpenAI キーを貼ってください。"
  exit 1
fi

read -r -p "xAI API キー (xai-..., 台本生成用・Enter でスキップ): " XAI_KEY
XAI_KEY="${XAI_KEY//$'\r'/}"
XAI_KEY="${XAI_KEY#"${XAI_KEY%%[![:space:]]*}"}"
XAI_KEY="${XAI_KEY%"${XAI_KEY##*[![:space:]]}"}"

cat >"$DEST" <<EOF
# 自動生成 $(date -Iseconds) — setup-local-secrets.sh
OPENAI_API_KEY=${OPENAI_KEY}
EOF

if [[ -n "$XAI_KEY" && "$XAI_KEY" != *"..."* && ${#XAI_KEY} -ge 20 ]]; then
  echo "XAI_API_KEY=${XAI_KEY}" >>"$DEST"
fi

cat >>"$DEST" <<'EOF'
PROXY_SECRET=wavrick-local-dev-secret
# RunPod Serverless（推奨）— ローカル 8081 不要:
# RUNPOD_API_KEY=rpa_...
# RUNPOD_WHISPERX_ENDPOINT_ID=<endpoint-id>
# → docs/whisperx-runpod-serverless.md
# RunPod GPU Pod:
# WHISPERX_SERVICE_URL=http://<RunPod-TCP-IP>:<外部ポート>
# WHISPERX_SERVICE_SECRET=<Pod の env と同じ>
# → docs/whisperx-runpod.md
EOF

chmod 600 "$DEST" 2>/dev/null || true

echo ""
echo "✅ 保存しました: ${DEST}"
echo ""
echo "次:"
echo "  lsof -ti :8889 | xargs kill -9 2>/dev/null; ./scripts/start-dev-server.sh"
echo "  ./scripts/check-local-ai.sh"
echo ""
