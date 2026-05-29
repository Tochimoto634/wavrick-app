#!/usr/bin/env bash
# Mac からレンタルサーバーへ WhisperX 用ファイルを rsync（初回・更新）
# 使い方:
#   export DEPLOY_HOST=user@your-server.example
#   export DEPLOY_PATH=/opt/wavrick-app
#   ./scripts/deploy-whisperx-to-server.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

HOST="${DEPLOY_HOST:-}"
REMOTE="${DEPLOY_PATH:-/opt/wavrick-app}"

if [[ -z "${HOST}" ]]; then
  echo "DEPLOY_HOST を設定してください。例:"
  echo "  export DEPLOY_HOST=ubuntu@1.2.3.4"
  echo "  export DEPLOY_PATH=/opt/wavrick-app"
  exit 1
fi

echo "→ ${HOST}:${REMOTE}"
rsync -avz --delete \
  --exclude '.venv' \
  --exclude '__pycache__' \
  --exclude '.git' \
  "${ROOT}/services/whisperx-service/" \
  "${HOST}:${REMOTE}/services/whisperx-service/"

rsync -avz \
  "${ROOT}/scripts/install-whisperx-server.sh" \
  "${ROOT}/scripts/whisperx_timeline.py" \
  "${HOST}:${REMOTE}/scripts/"

echo ""
echo "サーバーで実行:"
echo "  ssh ${HOST}"
echo "  cd ${REMOTE} && ./scripts/install-whisperx-server.sh"
echo "  sudo systemctl restart wavrick-whisperx"
