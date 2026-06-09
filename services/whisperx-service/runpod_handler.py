"""
RunPod Queue 型 Serverless 用ハンドラ（非同期 /run → /status）。

input: { "audioUrl": "https://..." }
output: transcribe_aligned と同じ JSON（segments / words / build 等）
"""

from __future__ import annotations

import logging
import os
import tempfile
from urllib.parse import urlparse

import httpx
import runpod

from transcribe import transcribe_aligned

logger = logging.getLogger("wavrick.whisperx.runpod")
logging.basicConfig(level=logging.INFO)

WAVRICK_WHISPERX_BUILD = 16
MAX_BYTES = int(os.environ.get("WHISPERX_MAX_BYTES", str(48 * 1024 * 1024)))
ALLOWED_AUDIO_HOST_SUFFIXES = tuple(
    h.strip().lower()
    for h in (os.environ.get("WHISPERX_ALLOWED_AUDIO_HOSTS") or "").split(",")
    if h.strip()
)


def _blocked_host(hostname: str) -> bool:
    h = (hostname or "").lower()
    if not h:
        return True
    if h in ("localhost", "127.0.0.1", "0.0.0.0", "metadata.google.internal"):
        return True
    if h.endswith(".local"):
        return True
    return False


def _audio_url_allowed(url: str) -> None:
    parsed = urlparse(url)
    if parsed.scheme != "https":
        raise ValueError("audioUrl must use https")
    host = (parsed.hostname or "").lower()
    if _blocked_host(host):
        raise ValueError("audioUrl host is not allowed")
    if ALLOWED_AUDIO_HOST_SUFFIXES:
        if not any(host == suf or host.endswith("." + suf) for suf in ALLOWED_AUDIO_HOST_SUFFIXES):
            raise ValueError("audioUrl host is not in allowlist")


def _fetch_audio_url(url: str) -> tuple[bytes, str]:
    _audio_url_allowed(url)
    with httpx.Client(follow_redirects=True, timeout=600.0) as client:
        with client.stream("GET", url) as resp:
            if resp.status_code != 200:
                body = resp.read()[:300]
                raise ValueError(f"audioUrl fetch failed ({resp.status_code}): {body!r}")
            cl = resp.headers.get("content-length")
            if cl and int(cl) > MAX_BYTES:
                raise ValueError("audioUrl Content-Length exceeds limit")
            chunks: list[bytes] = []
            total = 0
            for chunk in resp.iter_bytes():
                total += len(chunk)
                if total > MAX_BYTES:
                    raise ValueError("audio file too large")
                chunks.append(chunk)
    data = b"".join(chunks)
    if len(data) < 256:
        raise ValueError("audio data too short or empty")
    ext = os.path.splitext(urlparse(url).path)[1].lower().lstrip(".") or "bin"
    if ext not in ("wav", "mp3", "m4a", "webm", "ogg", "flac", "opus", "mp4", "aac"):
        ext = "bin"
    return data, ext


def handler(job: dict) -> dict:
    payload = job.get("input") if isinstance(job, dict) else None
    if not isinstance(payload, dict):
        raise ValueError('input must be an object with "audioUrl"')

    audio_url = str(payload.get("audioUrl") or "").strip()
    if not audio_url:
        raise ValueError('input.audioUrl is required')

    batch_size = payload.get("batchSize")
    if batch_size is not None:
        try:
            batch_size = int(batch_size)
        except (TypeError, ValueError):
            batch_size = None

    data, suffix = _fetch_audio_url(audio_url)
    with tempfile.NamedTemporaryFile(suffix=f".{suffix}", delete=False) as tmp:
        tmp.write(data)
        tmp_path = tmp.name
    try:
        result = transcribe_aligned(tmp_path, batch_size=batch_size)
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass

    if isinstance(result, dict):
        result["build"] = WAVRICK_WHISPERX_BUILD
    return result


if __name__ == "__main__":
    runpod.serverless.start({"handler": handler})
