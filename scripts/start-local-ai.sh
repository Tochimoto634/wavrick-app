#!/usr/bin/env bash
# ローカル AI 一式: 音声プロキシ (5055) + WhisperX (8081) + サイト (8889)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/_whisperx_url.sh
source "${ROOT}/scripts/_whisperx_url.sh"

start_bg() {
  local name="$1"
  local script="$2"
  echo "→ ${name}"
  "$script" &
}

if ! curl -sf http://127.0.0.1:5055/health >/dev/null 2>&1; then
  start_bg "audio-proxy" "${ROOT}/scripts/start-audio-proxy.sh"
  sleep 1
else
  echo "audio-proxy (5055) already running"
fi

if wavrick_whisperx_use_local; then
  EXPECTED_WX="$(
    grep -E '^WAVRICK_WHISPERX_BUILD\s*=' "${ROOT}/services/whisperx-service/app.py" \
      | head -1 \
      | sed -E 's/.*=\s*([0-9]+).*/\1/'
  )"
  RUNNING_WX=""
  if curl -sf http://127.0.0.1:8081/health >/dev/null 2>&1; then
    RUNNING_WX="$(curl -sf http://127.0.0.1:8081/health | python3 -c 'import sys,json; print(json.load(sys.stdin).get("build",""))' 2>/dev/null || echo "")"
  fi
  if [[ -n "${RUNNING_WX}" && "${RUNNING_WX}" != "${EXPECTED_WX}" ]]; then
    echo "whisperx (8081) は build ${RUNNING_WX} のまま → 再起動します（期待: ${EXPECTED_WX}）"
    lsof -ti :8081 | xargs kill -9 2>/dev/null || true
    sleep 1
    RUNNING_WX=""
  fi
  if [[ -z "${RUNNING_WX}" ]]; then
    if [[ ! -x "${ROOT}/services/whisperx-service/.venv/bin/python3" ]]; then
      echo "WhisperX 未インストール → ./scripts/install-whisperx.sh"
      exit 1
    fi
    start_bg "whisperx" "${ROOT}/scripts/start-whisperx.sh"
    sleep 2
  else
    echo "whisperx (8081) already running (build ${RUNNING_WX})"
  fi
else
  wavrick_load_whisperx_env
  WX_BASE="$(wavrick_whisperx_base_url)"
  WX_HEALTH="$(wavrick_whisperx_health_path)"
  echo "WhisperX: リモート ${WX_BASE}（ローカル 8081 はスキップ）"
  AUTH=()
  if [[ -n "${RUNPOD_API_KEY:-}" ]]; then
    AUTH=(-H "Authorization: Bearer ${RUNPOD_API_KEY}")
  elif [[ -n "${WHISPERX_SERVICE_SECRET:-${PROXY_SECRET:-}}" ]]; then
    AUTH=(-H "Authorization: Bearer ${WHISPERX_SERVICE_SECRET:-${PROXY_SECRET}}")
  fi
  WX_CODE="$(curl -sS -o /dev/null -w "%{http_code}" "${AUTH[@]}" "${WX_BASE}${WX_HEALTH}" 2>/dev/null || echo "000")"
  if [[ "${WX_CODE}" != "200" && "${WX_CODE}" != "204" ]]; then
    echo "  ⚠️  リモート ${WX_HEALTH} に届きません (HTTP ${WX_CODE})。.local/secrets.env を確認"
  elif [[ "${WX_CODE}" == "204" ]]; then
    echo "  ⏳ モデルロード中（RunPod Serverless）"
  fi
fi

echo ""
echo "起動確認: ./scripts/wavrick-status.sh"
echo "サイト:   ./scripts/start-dev-server.sh  （別ターミナルでも可）"
echo ""

EXPECTED_DEV="$(
  grep -E '^WAVRICK_TRANSCRIBE_BUILD\s*=' "${ROOT}/scripts/local_media_pipeline.py" \
    | head -1 \
    | sed -E 's/.*=\s*([0-9]+).*/\1/'
)"
RUNNING_DEV=""
if curl -sf http://127.0.0.1:8889/api/media-pipeline/health >/dev/null 2>&1; then
  RUNNING_DEV="$(curl -sf http://127.0.0.1:8889/api/media-pipeline/health | python3 -c 'import sys,json; print(json.load(sys.stdin).get("transcribeBuild",""))' 2>/dev/null || echo "")"
fi
if lsof -ti ":8889" >/dev/null 2>&1; then
  if [[ -n "${RUNNING_DEV}" && "${RUNNING_DEV}" != "${EXPECTED_DEV}" ]]; then
    echo "dev server (8889) は build ${RUNNING_DEV} のまま → 再起動します（期待: ${EXPECTED_DEV}）"
    lsof -ti :8889 | xargs kill -9 2>/dev/null || true
    sleep 1
  elif [[ -n "${RUNNING_DEV}" && "${RUNNING_DEV}" == "${EXPECTED_DEV}" ]]; then
    echo "dev server (8889) already running (build ${RUNNING_DEV}) → http://127.0.0.1:8889/"
    exit 0
  elif [[ -z "${RUNNING_DEV}" ]]; then
    echo "dev server (8889) は応答しますが build 不明 → 再起動推奨: ./scripts/restart-local-ai.sh"
    lsof -ti :8889 | xargs kill -9 2>/dev/null || true
    sleep 1
  else
    echo "dev server (8889) already running → http://127.0.0.1:8889/"
    exit 0
  fi
fi

exec "${ROOT}/scripts/start-dev-server.sh"
