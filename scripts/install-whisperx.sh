#!/usr/bin/env bash
# WhisperX サービス（CPU）— venv 作成と依存インストール
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SVC="${ROOT}/services/whisperx-service"
VENV="${SVC}/.venv"

pick_python() {
  # WhisperX は Python 3.14 非対応（<3.14）
  local candidates=(
    python3.12
    python3.11
    python3.10
    /opt/homebrew/opt/python@3.12/bin/python3.12
    /usr/local/opt/python@3.12/bin/python3.12
  )
  for cmd in "${candidates[@]}"; do
    if [[ -x "$cmd" ]] || command -v "$cmd" >/dev/null 2>&1; then
      local ver
      ver="$("$cmd" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")' 2>/dev/null)" || continue
      local major minor
      major="${ver%%.*}"
      minor="${ver#*.}"
      if [[ "$major" -eq 3 ]] && [[ "$minor" -ge 10 ]] && [[ "$minor" -le 13 ]]; then
        echo "$cmd"
        return 0
      fi
    fi
  done
  return 1
}

PY="$(pick_python)" || {
  echo "Python 3.10–3.12 が必要です（WhisperX は 3.14 非対応）。"
  echo "  macOS: brew install python@3.12"
  echo "  その後: ./scripts/install-whisperx.sh"
  exit 1
}

echo "Using: $($PY --version) ($PY)"
echo "venv: ${VENV}"

# 3.14 などで作った古い venv を捨てる
if [[ -d "${VENV}" ]]; then
  old_ver="$("${VENV}/bin/python3" -c 'import sys; print(sys.version_info.minor)' 2>/dev/null || echo 99)"
  if [[ "$old_ver" -ge 14 ]] || [[ "$old_ver" -lt 10 ]]; then
    echo "Removing incompatible venv (Python 3.${old_ver})..."
    rm -rf "${VENV}"
  fi
fi

if [[ ! -d "${VENV}" ]]; then
  "$PY" -m venv "${VENV}"
fi

# shellcheck source=/dev/null
source "${VENV}/bin/activate"
pip install -U pip wheel

echo "Installing PyTorch (CPU)..."
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu

echo "Installing WhisperX service deps..."
pip install -r "${SVC}/requirements.txt"

echo ""
echo "Done. Start with: ./scripts/start-whisperx.sh"
"${VENV}/bin/python3" -c "import torch; import whisperx; print('torch', torch.__version__, 'cuda', torch.cuda.is_available())"
