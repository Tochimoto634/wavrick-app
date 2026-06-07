#!/usr/bin/env bash
# WhisperX の接続先 URL を解決（.local/secrets.env → 環境変数 → デフォルト）
_wavrick_root() {
  cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd
}

wavrick_load_whisperx_env() {
  local secrets="$(_wavrick_root)/.local/secrets.env"
  if [[ -f "${secrets}" ]]; then
    set -a
    # shellcheck source=/dev/null
    source "${secrets}" 2>/dev/null || true
    set +a
  fi
}

wavrick_runpod_whisperx_endpoint_id() {
  wavrick_load_whisperx_env
  echo "${RUNPOD_WHISPERX_ENDPOINT_ID:-${RUNPOD_ENDPOINT_ID:-}}"
}

wavrick_whisperx_base_url() {
  wavrick_load_whisperx_env
  local endpoint_id
  endpoint_id="$(wavrick_runpod_whisperx_endpoint_id)"
  if [[ -n "${endpoint_id}" ]]; then
    echo "https://${endpoint_id}.api.runpod.ai"
    return
  fi
  local url="${WHISPERX_SERVICE_URL:-http://127.0.0.1:8081}"
  echo "${url%/}"
}

# ローカル 8081 を起動すべきか（リモート URL / RunPod Serverless なら false）
wavrick_whisperx_use_local() {
  if [[ -n "$(wavrick_runpod_whisperx_endpoint_id)" ]]; then
    return 1
  fi
  local url
  url="$(wavrick_whisperx_base_url | tr '[:upper:]' '[:lower:]')"
  case "${url}" in
    http://127.0.0.1:* | http://localhost:* | "" ) return 0 ;;
    * ) return 1 ;;
  esac
}

wavrick_whisperx_health_path() {
  if [[ -n "$(wavrick_runpod_whisperx_endpoint_id)" ]]; then
    echo "/ping"
  else
    echo "/health"
  fi
}
