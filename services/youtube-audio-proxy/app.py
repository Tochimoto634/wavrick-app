"""
YouTube URL -> best audio file (bytes). Used by Supabase Edge `media-pipeline` (YOUTUBE_AUDIO_PROXY_URL).

Run: docker build -t wavrick-yt-audio . && docker run -e PROXY_SECRET=... -p 8080:8080 wavrick-yt-audio
"""

from __future__ import annotations

import glob
import os
import shutil
import tempfile
from urllib.parse import urlparse

from flask import Flask, Response, abort, request
import yt_dlp

app = Flask(__name__)

MAX_BYTES = 24 * 1024 * 1024

# IDE / CI の HTTP_PROXY が YouTube 取得を壊すことがある
_STRIP_PROXY_ENV = (
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "GIT_HTTP_PROXY",
    "GIT_HTTPS_PROXY",
    "SOCKS_PROXY",
    "SOCKS5_PROXY",
    "socks_proxy",
    "socks5_proxy",
)


def clear_download_proxies() -> None:
    for key in _STRIP_PROXY_ENV:
        os.environ.pop(key, None)


def host_allowed(url: str) -> bool:
    try:
        h = (urlparse(url).hostname or "").lower()
    except Exception:
        return False
    if h in {"youtube.com", "youtu.be", "m.youtube.com", "music.youtube.com", "www.youtube.com"}:
        return True
    return h.endswith(".youtube.com")


@app.post("/extract")
def extract():
    secret = os.environ.get("PROXY_SECRET", "").strip()
    if secret:
        auth = request.headers.get("Authorization", "")
        if auth != f"Bearer {secret}":
            abort(401)

    payload = request.get_json(silent=True) or {}
    url = (payload.get("videoUrl") or payload.get("url") or "").strip()
    if not url or not host_allowed(url):
        abort(400)

    out_dir = tempfile.mkdtemp(prefix="wavrick_yt_")
    out_tmpl = os.path.join(out_dir, "out.%(ext)s")

    clear_download_proxies()
    ydl_opts: dict = {
        "format": "bestaudio/best",
        "outtmpl": out_tmpl,
        "noplaylist": True,
        "quiet": True,
        "max_filesize": MAX_BYTES,
        "socket_timeout": 120,
        "proxy": "",
    }

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([url])
    except Exception:
        shutil.rmtree(out_dir, ignore_errors=True)
        abort(502)

    files = glob.glob(os.path.join(out_dir, "out.*"))
    if not files:
        shutil.rmtree(out_dir, ignore_errors=True)
        abort(502)

    path = files[0]
    try:
        with open(path, "rb") as fh:
            data = fh.read()
    finally:
        shutil.rmtree(out_dir, ignore_errors=True)

    if len(data) > MAX_BYTES:
        abort(413)
    if len(data) < 256:
        abort(502)

    return Response(data, mimetype="application/octet-stream")


@app.get("/health")
def health():
    return {"ok": True}


if __name__ == "__main__":
    clear_download_proxies()
    port = int(os.environ.get("PORT", "8080"))
    app.run(host="0.0.0.0", port=port)
