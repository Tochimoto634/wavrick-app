#!/usr/bin/env bash
# レンタルサーバー（Ubuntu/Debian）上で WhisperX サービスをセットアップ
# 使い方: サーバーにリポジトリを clone したあと、リポジトリルートで実行
#   ./scripts/install-whisperx-server.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SVC="${ROOT}/services/whisperx-service"
VENV="${SVC}/.venv"
ENV_FILE="${SVC}/deploy/.env"

pick_python() {
  local candidates=(python3.12 python3.11 python3.10 python3)
  for cmd in "${candidates[@]}"; do
    if command -v "$cmd" >/dev/null 2>&1; then
      local ver
      ver="$("$cmd" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")' 2>/dev/null)" || continue
      local major="${ver%%.*}" minor="${ver#*.}"
      if [[ "$major" -eq 3 ]] && [[ "$minor" -ge 10 ]] && [[ "$minor" -le 13 ]]; then
        echo "$cmd"
        return 0
      fi
    fi
  done
  return 1
}

echo "=== Wavrick WhisperX（サーバー用） ==="
echo "ROOT: ${ROOT}"

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg がありません。例: sudo apt update && sudo apt install -y ffmpeg"
  exit 1
fi

PY="$(pick_python)" || {
  echo "Python 3.10–3.12 が必要です。"
  echo "  Ubuntu 例: sudo apt install -y python3.12 python3.12-venv"
  exit 1
}
echo "Python: $($PY --version)"

if [[ -d "${VENV}" ]]; then
  old_minor="$("${VENV}/bin/python3" -c 'import sys; print(sys.version_info.minor)' 2>/dev/null || echo 99)"
  if [[ "$old_minor" -ge 14 ]] || [[ "$old_minor" -lt 10 ]]; then
    echo "Removing incompatible venv..."
    rm -rf "${VENV}"
  fi
fi

if [[ ! -d "${VENV}" ]]; then
  "$PY" -m venv "${VENV}"
fi

# shellcheck source=/dev/null
source "${VENV}/bin/activate"
pip install -U pip wheel

if command -v nvidia-smi >/dev/null 2>&1; then
  echo "CUDA 検出 → GPU 版 PyTorch"
  pip install torch torchaudio
  export WHISPERX_DEVICE="${WHISPERX_DEVICE:-cuda}"
  export WHISPERX_COMPUTE_TYPE="${WHISPERX_COMPUTE_TYPE:-float16}"
  export WHISPERX_BATCH_SIZE="${WHISPERX_BATCH_SIZE:-16}"
else
  echo "GPU なし → CPU 版 PyTorch（遅いです。GPU サーバー推奨）"
  pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu
  export WHISPERX_DEVICE="${WHISPERX_DEVICE:-cpu}"
  export WHISPERX_COMPUTE_TYPE="${WHISPERX_COMPUTE_TYPE:-int8}"
  export WHISPERX_BATCH_SIZE="${WHISPERX_BATCH_SIZE:-8}"
fi

pip install -r "${SVC}/requirements.txt"

if [[ ! -f "${ENV_FILE}" ]]; then
  mkdir -p "${SVC}/deploy"
  SECRET="$(openssl rand -hex 24 2>/dev/null || date +%s | shasum -a 256 | cut -c1-48)"
  cat >"${ENV_FILE}" <<EOF
# ${ENV_FILE} — systemd / 手動起動用
PORT=8081
WHISPERX_SERVICE_SECRET=${SECRET}
WHISPERX_DEVICE=${WHISPERX_DEVICE}
WHISPERX_COMPUTE_TYPE=${WHISPERX_COMPUTE_TYPE}
WHISPERX_MODEL=large-v3
WHISPERX_BATCH_SIZE=${WHISPERX_BATCH_SIZE}
WHISPERX_MAX_BYTES=25165824
EOF
  chmod 600 "${ENV_FILE}"
  echo ""
  echo "作成: ${ENV_FILE}"
  echo "  WHISPERX_SERVICE_SECRET を Mac の .local/secrets.env と Supabase secrets に同じ値で設定してください。"
fi

"${VENV}/bin/python3" -c "import torch, whisperx; print('torch', torch.__version__, 'cuda', torch.cuda.is_available())"

echo ""
echo "✅ インストール完了"
echo ""
echo "手動起動（確認用）:"
echo "  set -a && source ${ENV_FILE} && set +a"
echo "  cd ${SVC} && ${VENV}/bin/uvicorn app:app --host 127.0.0.1 --port \${PORT:-8081}"
echo ""
echo "常駐（systemd）:"
echo "  sudo cp ${SVC}/deploy/wavrick-whisperx.service /etc/systemd/system/"
echo "  sudo systemctl daemon-reload"
echo "  sudo systemctl enable --now wavrick-whisperx"
echo ""
echo "前に Nginx/Caddy で HTTPS リバースプロキシを張り、"
echo "  WHISPERX_SERVICE_URL=https://wx.あなたのドメイン"
echo "を Mac / Supabase に設定します。詳細: docs/whisperx-remote-server.md"
