"""
YouTube URL -> best audio file (bytes), optional AI vocal stem for ADR + Whisper.

Pipeline (/extract):
  1. yt-dlp download (+ ffmpeg -> mp3 when available)
  2. demucs two-stems vocal separation (htdemucs) when enabled
  3. Return clean vocal MP3/WAV to browser WaveSurfer and media-pipeline Whisper

Run:
  pip install -r requirements.txt
  # CPU torch (recommended for demucs):
  pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu
  PROXY_SECRET=... python app.py

Docker: docker build -t wavrick-yt-audio . && docker run -e PROXY_SECRET=... -p 8080:8080 wavrick-yt-audio
"""

from __future__ import annotations

import glob
import logging
import os
import shutil
import subprocess
import sys
import tempfile
from urllib.parse import urlparse

from flask import Flask, Response, abort, jsonify, request
import yt_dlp

app = Flask(__name__)
logger = logging.getLogger("wavrick.yt_audio")
logging.basicConfig(level=logging.INFO)

MAX_BYTES = 24 * 1024 * 1024

# m4a(AAC) を優先。ffmpeg があれば 192kbps MP3 に変換（webm opus より聴きやすい）
_AUDIO_FORMAT = (
    "bestaudio[ext=m4a]/bestaudio[acodec^=mp4a]/"
    "bestaudio[ext=webm]/bestaudio/best"
)

# Demucs vocal separation (shared by record-workspace + Whisper preprocess)
_VOCAL_SEPARATION = os.environ.get("WAVRICK_VOCAL_SEPARATION", "1").strip().lower() not in (
    "0",
    "false",
    "no",
    "off",
)
_DEMUCS_MODEL = os.environ.get("WAVRICK_DEMUCS_MODEL", "htdemucs").strip() or "htdemucs"
_DEMUCS_TIMEOUT_SEC = int(os.environ.get("WAVRICK_DEMUCS_TIMEOUT", "600"))


def _guess_mimetype(path: str) -> str:
    ext = os.path.splitext(path)[1].lower()
    return {
        ".m4a": "audio/mp4",
        ".mp4": "audio/mp4",
        ".mp3": "audio/mpeg",
        ".wav": "audio/wav",
        ".webm": "audio/webm",
        ".ogg": "audio/ogg",
        ".opus": "audio/ogg",
    }.get(ext, "application/octet-stream")


def _ydl_options(out_tmpl: str) -> dict:
    # YouTube はクライアント検証が頻繁に変わる。android+web と player_js_version=actual で 403 を回避。
    opts: dict = {
        "format": _AUDIO_FORMAT,
        "outtmpl": out_tmpl,
        "noplaylist": True,
        "quiet": True,
        "no_warnings": False,
        "max_filesize": MAX_BYTES,
        "socket_timeout": 120,
        "proxy": "",
        "extractor_args": {
            "youtube": {
                "player_client": ["android", "web"],
                "player_js_version": ["actual"],
            }
        },
    }
    if shutil.which("ffmpeg"):
        opts["postprocessors"] = [
            {
                "key": "FFmpegExtractAudio",
                "preferredcodec": "mp3",
                "preferredquality": "192",
            }
        ]
    return opts


# 収録ワークスペース（ブラウザ）からローカル / 本番オリジンで POST /extract するため
_CORS_ORIGIN = os.environ.get("WAVRICK_CORS_ORIGIN", "*")


@app.after_request
def _cors_headers(resp):
    resp.headers["Access-Control-Allow-Origin"] = _CORS_ORIGIN
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    resp.headers["Access-Control-Expose-Headers"] = (
        "X-Wavrick-Vocal-Separated, X-Wavrick-Audio-Stem"
    )
    return resp


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


_FFMPEG_CANDIDATES = (
    "ffmpeg",
    "/opt/homebrew/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
)


def find_ffmpeg() -> str | None:
    for candidate in _FFMPEG_CANDIDATES:
        if candidate == "ffmpeg":
            found = shutil.which("ffmpeg")
            if found:
                return found
        elif os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


def demucs_available() -> bool:
    if not find_ffmpeg():
        return False
    try:
        import demucs  # noqa: F401
    except ImportError:
        return False
    return True


def _run_ffmpeg(args: list[str], timeout: int = 120) -> None:
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        raise RuntimeError(
            "ffmpeg が見つかりません。Mac では brew install ffmpeg を実行してください。"
        )
    proc = subprocess.run(
        [ffmpeg, *args],
        capture_output=True,
        timeout=timeout,
        check=False,
    )
    if proc.returncode != 0:
        err = (proc.stderr or b"").decode("utf-8", errors="replace")[-800:]
        raise RuntimeError(f"ffmpeg failed ({proc.returncode}): {err}")


def audio_to_wav(input_path: str, wav_path: str) -> None:
    _run_ffmpeg(
        ["-y", "-i", input_path, "-ar", "44100", "-ac", "2", wav_path],
        timeout=180,
    )


def wav_to_mp3(wav_path: str, mp3_path: str) -> None:
    _run_ffmpeg(
        ["-y", "-i", wav_path, "-codec:a", "libmp3lame", "-q:a", "2", mp3_path],
        timeout=180,
    )


def _patch_demucs_pad1d() -> None:
    """PyTorch 新世代での reflect padding assert 失敗を回避（demucs 互換パッチ）。"""
    try:
        import torch.nn.functional as F
        import demucs.hdemucs as hdemucs
        import demucs.htdemucs as htdemucs
    except ImportError:
        return

    def pad1d_safe(x, paddings, mode="constant", value=0.0):
        length = x.shape[-1]
        padding_left, padding_right = paddings
        if mode == "reflect":
            max_pad = max(padding_left, padding_right)
            if length <= max_pad:
                extra_pad = max_pad - length + 1
                extra_pad_right = min(padding_right, extra_pad)
                extra_pad_left = extra_pad - extra_pad_right
                paddings = (
                    padding_left - extra_pad_left,
                    padding_right - extra_pad_right,
                )
                x = F.pad(x, (extra_pad_left, extra_pad_right))
        return F.pad(x, paddings, mode, value)

    hdemucs.pad1d = pad1d_safe
    htdemucs.pad1d = pad1d_safe


def separate_vocals_demucs(input_wav: str, work_dir: str) -> str:
    """Return path to vocals.wav from demucs --two-stems vocals."""
    _patch_demucs_pad1d()
    out_root = os.path.join(work_dir, "demucs_out")
    os.makedirs(out_root, exist_ok=True)
    runner = os.path.join(os.path.dirname(os.path.abspath(__file__)), "run_demucs.py")
    cmd = [
        sys.executable,
        runner,
        "--two-stems",
        "vocals",
        "-n",
        _DEMUCS_MODEL,
        "--segment",
        "7",
        "--float32",
        "--mp3",
        "-d",
        "cpu",
        "--out",
        out_root,
        input_wav,
    ]
    logger.info("demucs start: %s", " ".join(cmd))
    proc = subprocess.run(
        cmd,
        capture_output=True,
        timeout=_DEMUCS_TIMEOUT_SEC,
        check=False,
    )
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or b"").decode("utf-8", errors="replace")[-1200:]
        raise RuntimeError(f"demucs failed ({proc.returncode}): {err}")

    base = os.path.splitext(os.path.basename(input_wav))[0]
    for ext in ("vocals.mp3", "vocals.wav"):
        expected = os.path.join(out_root, _DEMUCS_MODEL, base, ext)
        if os.path.isfile(expected):
            return expected

    hits = glob.glob(os.path.join(out_root, "**", "vocals.*"), recursive=True)
    hits = [h for h in hits if h.endswith((".wav", ".mp3"))]
    if not hits:
        raise FileNotFoundError("demucs finished but vocals.wav was not found")
    return hits[0]


def apply_vocal_separation(source_path: str, work_dir: str) -> tuple[str, bool]:
    """
    Run vocal stem extraction. Returns (output_path, separated_ok).
    On failure, returns original path and False.
    """
    if not _VOCAL_SEPARATION:
        return source_path, False
    if not demucs_available():
        logger.warning("vocal separation skipped: demucs or ffmpeg not available")
        return source_path, False

    wav_in = os.path.join(work_dir, "source.wav")
    try:
        audio_to_wav(source_path, wav_in)
        vocal_stem = separate_vocals_demucs(wav_in, work_dir)
        if vocal_stem.endswith(".mp3"):
            vocal_out = os.path.join(work_dir, "vocals.mp3")
            shutil.copy2(vocal_stem, vocal_out)
            return vocal_out, True
        vocal_out = os.path.join(work_dir, "vocals.wav")
        shutil.copy2(vocal_stem, vocal_out)
        return vocal_out, True
    except Exception as exc:
        logger.exception("vocal separation failed, using original mix: %s", exc)
        return source_path, False


def download_youtube_audio(url: str, out_dir: str) -> str:
    out_tmpl = os.path.join(out_dir, "out.%(ext)s")
    clear_download_proxies()
    ydl_opts = _ydl_options(out_tmpl)
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        ydl.download([url])
    files = glob.glob(os.path.join(out_dir, "out.*"))
    if not files:
        raise RuntimeError("yt-dlp produced no output file")
    return files[0]


def read_audio_file(path: str) -> tuple[bytes, str]:
    with open(path, "rb") as fh:
        data = fh.read()
    return data, _guess_mimetype(path)


@app.route("/extract", methods=["OPTIONS"])
def extract_options():
    return Response("", status=204)


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

    vocal_requested = payload.get("vocalSeparate", payload.get("vocalOnly", True))
    if isinstance(vocal_requested, str):
        vocal_requested = vocal_requested.strip().lower() not in ("0", "false", "no", "off")
    else:
        vocal_requested = bool(vocal_requested)

    out_dir = tempfile.mkdtemp(prefix="wavrick_yt_")
    separated = False
    try:
        path = download_youtube_audio(url, out_dir)
        if vocal_requested and _VOCAL_SEPARATION:
            path, separated = apply_vocal_separation(path, out_dir)
        data, mime = read_audio_file(path)
    except Exception as exc:
        logger.exception("extract failed for %s", url)
        shutil.rmtree(out_dir, ignore_errors=True)
        detail = str(exc).strip() or exc.__class__.__name__
        if "403" in detail or "Forbidden" in detail:
            detail = (
                "YouTube から音声を取得できませんでした（403）。"
                " しばらくして再試行するか、音声ファイルを直接アップロードしてください。"
                f" 詳細: {detail[:240]}"
            )
        return jsonify({"ok": False, "error": detail}), 502
    finally:
        shutil.rmtree(out_dir, ignore_errors=True)

    if len(data) > MAX_BYTES:
        abort(413)
    if len(data) < 256:
        abort(502)

    resp = Response(data, mimetype=mime)
    resp.headers["X-Wavrick-Vocal-Separated"] = "1" if separated else "0"
    resp.headers["X-Wavrick-Audio-Stem"] = "vocals" if separated else "mix"
    return resp


@app.post("/video-meta")
def video_meta():
    secret = os.environ.get("PROXY_SECRET", "").strip()
    if secret:
        auth = request.headers.get("Authorization", "")
        if auth != f"Bearer {secret}":
            abort(401)

    payload = request.get_json(silent=True) or {}
    url = (payload.get("videoUrl") or payload.get("url") or "").strip()
    if not url or not host_allowed(url):
        abort(400)

    clear_download_proxies()
    try:
        with yt_dlp.YoutubeDL({"quiet": True, "noplaylist": True, "skip_download": True, "proxy": ""}) as ydl:
            info = ydl.extract_info(url, download=False)
    except Exception as exc:
        logger.exception("video-meta failed for %s", url)
        return jsonify({"ok": False, "error": str(exc)}), 422

    if not info:
        return jsonify({"ok": False, "error": "動画情報を取得できませんでした。"}), 422

    channel_id = str(info.get("channel_id") or info.get("uploader_id") or "")
    channel_url = str(info.get("channel_url") or info.get("uploader_url") or "")
    uploader = str(info.get("uploader") or info.get("channel") or "")
    channel_key = ""
    if channel_url:
        try:
            parsed = urlparse(channel_url)
            path = parsed.path or ""
            parts = [p for p in path.split("/") if p]
            if parts and parts[0].startswith("@"):
                channel_key = f"handle:{parts[0].lower()}"
            elif len(parts) >= 2 and parts[0] == "channel":
                channel_key = f"channel:{parts[1]}"
        except Exception:
            channel_key = ""
    if not channel_key and channel_id:
        channel_key = f"channel:{channel_id}"

    return jsonify(
        {
            "ok": True,
            "videoId": str(info.get("id") or ""),
            "title": str(info.get("title") or ""),
            "channelId": channel_id,
            "channelKey": channel_key,
            "channelTitle": uploader,
            "channelUrl": channel_url,
        }
    )


@app.get("/health")
def health():
    return jsonify(
        {
            "ok": True,
            "vocalSeparationEnabled": _VOCAL_SEPARATION,
            "vocalSeparationReady": demucs_available(),
            "demucsModel": _DEMUCS_MODEL,
            "ffmpeg": find_ffmpeg(),
        }
    )


if __name__ == "__main__":
    clear_download_proxies()
    port = int(os.environ.get("PORT", "8080"))
    app.run(host="0.0.0.0", port=port)
