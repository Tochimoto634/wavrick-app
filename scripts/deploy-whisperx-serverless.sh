#!/usr/bin/env bash
# RunPod Serverless 用 WhisperX イメージをビルド & push
# 依存は install-runpod-serverless.sh + verify-runpod-stack.py でビルド時検証済み
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="${1:-}"

if [[ -z "${IMAGE}" ]]; then
  echo "Usage: $0 DOCKER_USER/wavrick-whisperx-serverless:TAG"
  echo "Example: $0 tochimoto/wavrick-whisperx-serverless:stable"
  exit 1
fi

cd "${ROOT}/services/whisperx-service"
echo "Building ${IMAGE} (linux/amd64) …"
echo "  検証: numpy<2 / transformers.Pipeline / CUDA torch / whisperx import"
docker build --platform linux/amd64 -f Dockerfile.runpod-serverless -t "${IMAGE}" .
echo "Pushing ${IMAGE} …"
docker push "${IMAGE}"
echo ""
echo "Done."
echo ""
echo "RunPod Endpoint 設定:"
echo "  Image:          ${IMAGE}"
echo "  Endpoint Type:  Load Balancer"
echo "  HTTP Port:      80"
echo "  Env:            services/whisperx-service/runpod-serverless.env.example"
echo ""
echo "反映後の確認:"
echo "  ./scripts/test-remote-whisperx.sh"
echo "  → build: 15 / cuda_available: true / status: healthy"
