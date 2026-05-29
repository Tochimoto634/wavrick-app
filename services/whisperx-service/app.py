"""
WhisperX HTTP service — word-level transcription for Wavrick media pipeline.

POST /transcribe
  - multipart field `file` (audio), or
  - JSON { "audioUrl": "https://...", "batchSize": 16 }

GET /health
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
from urllib.parse import urlparse

import httpx
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse

from transcribe import transcribe_aligned

app = FastAPI(title="Wavrick WhisperX Service", version="1.0.0")
logger = logging.getLogger("wavrick.whisperx.http")
logging.basicConfig(level=logging.INFO)

WAVRICK_WHISPERX_BUILD = 8

MAX_BYTES = int(os.environ.get("WHISPERX_MAX_BYTES", str(24 * 1024 * 1024)))
SERVICE_SECRET = (os.environ.get("WHISPERX_SERVICE_SECRET") or os.environ.get("PROXY_SECRET") or "").strip()
ALLOWED_AUDIO_HOST_SUFFIXES = tuple(
    h.strip().lower()
    for h in (os.environ.get("WHISPERX_ALLOWED_AUDIO_HOSTS") or "").split(",")
    if h.strip()
)


def _check_auth(authorization: str | None) -> None:
    if not SERVICE_SECRET:
        return
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Authorization: Bearer <secret> required")
    token = authorization[7:].strip()
    if token != SERVICE_SECRET:
        raise HTTPException(status_code=403, detail="Invalid service secret")


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
        raise HTTPException(status_code=400, detail="audioUrl must use https")
    host = (parsed.hostname or "").lower()
    if _blocked_host(host):
        raise HTTPException(status_code=400, detail="audioUrl host is not allowed")
    if ALLOWED_AUDIO_HOST_SUFFIXES:
        if not any(host == suf or host.endswith("." + suf) for suf in ALLOWED_AUDIO_HOST_SUFFIXES):
            raise HTTPException(status_code=400, detail="audioUrl host is not in allowlist")


async def _fetch_audio_url(url: str) -> tuple[bytes, str]:
    _audio_url_allowed(url)
    async with httpx.AsyncClient(follow_redirects=True, timeout=600.0) as client:
        async with client.stream("GET", url) as resp:
            if resp.status_code != 200:
                body = (await resp.aread())[:300]
                raise HTTPException(
                    status_code=502,
                    detail=f"audioUrl fetch failed ({resp.status_code}): {body!r}",
                )
            cl = resp.headers.get("content-length")
            if cl and int(cl) > MAX_BYTES:
                raise HTTPException(status_code=413, detail="audioUrl Content-Length exceeds limit")
            chunks: list[bytes] = []
            total = 0
            async for chunk in resp.aiter_bytes():
                total += len(chunk)
                if total > MAX_BYTES:
                    raise HTTPException(status_code=413, detail="audio file too large")
                chunks.append(chunk)
    data = b"".join(chunks)
    if len(data) < 256:
        raise HTTPException(status_code=400, detail="audio data too short or empty")
    ext = os.path.splitext(urlparse(url).path)[1].lower().lstrip(".") or "bin"
    if ext not in ("wav", "mp3", "m4a", "webm", "ogg", "flac", "opus", "mp4", "aac"):
        ext = "bin"
    return data, ext


def _suffix_from_upload(filename: str | None, content_type: str | None) -> str:
    if filename and "." in filename:
        ext = filename.rsplit(".", 1)[-1].lower()
        if ext in ("wav", "mp3", "m4a", "webm", "ogg", "flac", "opus", "mp4", "aac"):
            return ext
    ct = (content_type or "").lower()
    if "mpeg" in ct or "mp3" in ct:
        return "mp3"
    if "wav" in ct:
        return "wav"
    if "mp4" in ct or "m4a" in ct:
        return "m4a"
    if "webm" in ct:
        return "webm"
    return "bin"


def _run_transcribe(path: str, batch_size: int | None) -> dict:
    try:
        return transcribe_aligned(path, batch_size=batch_size)
    except Exception as e:
        logger.exception("transcribe failed")
        raise HTTPException(status_code=500, detail=str(e)) from e


@app.get("/health")
def health():
    return {
        "ok": True,
        "service": "whisperx",
        "build": WAVRICK_WHISPERX_BUILD,
        "features": ["align", "silence_detect"],
    }


@app.post("/transcribe")
async def transcribe(
    request: Request,
    authorization: str | None = Header(default=None),
):
    _check_auth(authorization)
    content_type = (request.headers.get("content-type") or "").lower()

    if "multipart/form-data" in content_type:
        form = await request.form()
        upload = form.get("file")
        if upload is None:
            raise HTTPException(status_code=400, detail='multipart field "file" is required')
        raw = await upload.read()
        if len(raw) > MAX_BYTES:
            raise HTTPException(status_code=413, detail="upload too large")
        if len(raw) < 256:
            raise HTTPException(status_code=400, detail="upload too short")
        suffix = _suffix_from_upload(getattr(upload, "filename", None), getattr(upload, "content_type", None))
        batch_size = None
        bs_raw = form.get("batchSize")
        if bs_raw is not None:
            try:
                batch_size = int(bs_raw)
            except (TypeError, ValueError):
                pass
        with tempfile.NamedTemporaryFile(suffix=f".{suffix}", delete=False) as tmp:
            tmp.write(raw)
            tmp_path = tmp.name
        try:
            result = _run_transcribe(tmp_path, batch_size)
        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
        if isinstance(result, dict):
            result["build"] = WAVRICK_WHISPERX_BUILD
        return JSONResponse(result)

    try:
        payload = await request.json()
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=400, detail="Invalid JSON body") from e

    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="JSON body must be an object")

    audio_url = str(payload.get("audioUrl") or "").strip()
    if not audio_url:
        raise HTTPException(
            status_code=400,
            detail='Provide multipart "file" or JSON {"audioUrl":"https://..."}',
        )

    batch_size = payload.get("batchSize")
    if batch_size is not None:
        try:
            batch_size = int(batch_size)
        except (TypeError, ValueError):
            batch_size = None

    data, suffix = await _fetch_audio_url(audio_url)
    with tempfile.NamedTemporaryFile(suffix=f".{suffix}", delete=False) as tmp:
        tmp.write(data)
        tmp_path = tmp.name
    try:
        result = _run_transcribe(tmp_path, batch_size)
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
    if isinstance(result, dict):
        result["build"] = WAVRICK_WHISPERX_BUILD
    return JSONResponse(result)


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", "8081"))
    uvicorn.run("app:app", host="0.0.0.0", port=port, reload=False)
