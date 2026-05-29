#!/usr/bin/env bash
# ローカル AI を止めて最新コードで再起動（古い [Wavrick-6] 対策）
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/_whisperx_url.sh
source "${ROOT}/scripts/_whisperx_url.sh"

expected_transcribe="$(
  grep -E '^WAVRICK_TRANSCRIBE_BUILD\s*=' "${ROOT}/scripts/local_media_pipeline.py" \
    | head -1 \
    | sed -E 's/.*=\s*([0-9]+).*/\1/'
)"
expected_whisperx="$(
  grep -E '^WAVRICK_WHISPERX_BUILD\s*=' "${ROOT}/services/whisperx-service/app.py" \
    | head -1 \
    | sed -E 's/.*=\s*([0-9]+).*/\1/'
)"

echo "期待ビルド: media-pipeline=${expected_transcribe} whisperx=${expected_whisperx}"

for port in 8889; do
  pids="$(lsof -ti ":${port}" 2>/dev/null || true)"
  if [[ -n "${pids}" ]]; then
    echo "停止: port ${port} (PID ${pids})"
    echo "${pids}" | xargs kill -9 2>/dev/null || true
    sleep 1
  fi
done
if wavrick_whisperx_use_local; then
  pids="$(lsof -ti :8081 2>/dev/null || true)"
  if [[ -n "${pids}" ]]; then
    echo "停止: port 8081 (PID ${pids})"
    echo "${pids}" | xargs kill -9 2>/dev/null || true
    sleep 1
  fi
fi

WX_PID=""
if wavrick_whisperx_use_local; then
  echo ""
  echo "起動: WhisperX (8081) …"
  "${ROOT}/scripts/start-whisperx.sh" &
  WX_PID=$!
  sleep 2
else
  echo ""
  echo "WhisperX: リモート $(wavrick_whisperx_base_url)（ローカル 8081 は起動しません）"
fi

echo "起動: dev server (8889) …"
"${ROOT}/scripts/start-dev-server.sh" &
DEV_PID=$!
sleep 1

echo ""
echo "確認:"
curl -sf "http://127.0.0.1:8889/api/media-pipeline/health" 2>/dev/null | python3 -m json.tool 2>/dev/null \
  || echo "  8889: 未応答"
if wavrick_whisperx_use_local; then
  curl -sf "http://127.0.0.1:8081/health" 2>/dev/null | python3 -m json.tool 2>/dev/null \
    || echo "  8081: 未応答"
else
  curl -sf "$(wavrick_whisperx_base_url)/health" 2>/dev/null | python3 -m json.tool 2>/dev/null \
    || echo "  リモート WhisperX: 未応答 ($(wavrick_whisperx_base_url))"
fi

echo ""
echo "開く: http://127.0.0.1:8889/index.html"
echo "末尾が [Wavrick-${expected_transcribe}] になるまで再文字起こししてください。"
echo "（WhisperX PID=${WX_PID} / dev PID=${DEV_PID} — ログは各ターミナル）"
