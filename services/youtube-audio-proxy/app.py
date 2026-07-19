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

import base64
import glob
import logging
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from urllib.parse import urlparse

from flask import Flask, Response, abort, jsonify, request
import yt_dlp

app = Flask(__name__)
logger = logging.getLogger("wavrick.yt_audio")
logging.basicConfig(level=logging.INFO)

# 返却する音声の上限（Whisper 投入用 MP3 想定）。128kbps なら約 50 分弱まで。
MAX_BYTES = int(os.environ.get("WAVRICK_MAX_AUDIO_BYTES", str(48 * 1024 * 1024)))

# 高ビットレート単体ストリームは途中で切れることがあるため abr 上限付きで「動画全长」を優先
_AUDIO_FORMAT = (
    "bestaudio[ext=m4a][acodec^=mp4a][abr<=128]/"
    "bestaudio[abr<=128]/"
    "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best"
)
_AUDIO_FORMAT_FALLBACK = "bestaudio[abr<=96]/bestaudio"
_AUDIO_FORMAT_LAST_RESORT = "bestaudio/best"
_AUDIO_FORMAT_ANY = "ba/b/w"
_AUDIO_FORMAT_MUX = "b/w"
_AUDIO_FORMAT_BEST = "best"
# health の extractBuild と揃える（Railway で新コードが載ったか確認用）
_EXTRACT_BUILD = 15

# v3 ADR: language-specific dubbed track extraction
_LANG_DISPLAY = {
    "ja": "日本語",
    "en": "英語",
    "es": "スペイン語",
    "ko": "韓国語",
    "zh": "中国語",
}
# 動画長の何割未満なら「途中切断」とみなすか
_MIN_DURATION_RATIO = float(os.environ.get("WAVRICK_AUDIO_MIN_DURATION_RATIO", "0.88"))

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


_COOKIE_CACHE_PATH: str | None = None


def _yt_proxy() -> str:
    return os.environ.get("WAVRICK_YT_PROXY", "").strip()


def _resolve_yt_cookiefile() -> str | None:
    """ファイルパス / 環境変数テキスト / Base64 / .local cookies から yt-dlp 用 cookies.txt を用意。"""
    global _COOKIE_CACHE_PATH

    path = os.environ.get("WAVRICK_YT_COOKIES", "").strip()
    if path and os.path.isfile(path):
        return path
    if _COOKIE_CACHE_PATH and os.path.isfile(_COOKIE_CACHE_PATH):
        return _COOKIE_CACHE_PATH

    # Local defaults (repo .local is gitignored)
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
    for candidate in (
        os.path.join(root, ".local", "youtube-cookies-filtered.txt"),
        os.path.join(root, ".local", "youtube-cookies.txt"),
    ):
        if os.path.isfile(candidate) and os.path.getsize(candidate) > 32:
            logger.info("YouTube cookies loaded from %s", candidate)
            return candidate

    text = os.environ.get("WAVRICK_YT_COOKIES_TEXT", "").strip()
    if not text:
        b64 = os.environ.get("WAVRICK_YT_COOKIES_B64", "").strip()
        if b64:
            try:
                text = base64.b64decode(b64).decode("utf-8", errors="replace").strip()
            except Exception:
                logger.warning("WAVRICK_YT_COOKIES_B64 decode failed")
                text = ""

    if not text:
        return None

    fd, cache_path = tempfile.mkstemp(prefix="wavrick_yt_cookies_", suffix=".txt")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(text if text.endswith("\n") else f"{text}\n")
    _COOKIE_CACHE_PATH = cache_path
    logger.info("YouTube cookies loaded from env (%d bytes)", len(text))
    return cache_path


def _friendly_yt_extract_error(detail: str) -> str:
    if "Sign in to confirm" in detail or "not a bot" in detail.lower():
        return (
            "YouTube がボット判定しています。"
            " 対処: ① ブラウザから新しい cookies を書き出す（./scripts/export-youtube-cookies-for-railway.sh）"
            " ② 数分待って再試行 ③ 音声ファイルを直接アップロード。"
            f" 詳細: {detail[:240]}"
        )
    if "403" in detail or "Forbidden" in detail:
        return (
            "YouTube から音声を取得できませんでした（403）。"
            " Railway 等のデータセンター IP が弾かれていることが多いです。"
            " 対処: ① ./scripts/export-youtube-cookies-for-railway.sh で新しい cookies を Railway の WAVRICK_YT_COOKIES_B64 に設定"
            " ② 必要なら WAVRICK_YT_PROXY（住宅系プロキシ）を設定"
            " ③ しばらくして再試行、または音声ファイルを直接アップロード。"
            f" 詳細: {detail[:240]}"
        )
    if "requested format is not available" in detail.lower() or "no video formats found" in detail.lower():
        return (
            "YouTube から利用可能な音声形式を取得できませんでした。"
            " 別の動画で試すか、mp3/m4a を直接アップロードしてください。"
            f" 詳細: {detail[:240]}"
        )
    return detail


def _remote_components() -> list[str]:
    raw = os.environ.get("WAVRICK_YT_REMOTE_COMPONENTS", "ejs:github").strip()
    if raw.lower() in ("0", "false", "no", "off"):
        return []
    return [part.strip() for part in raw.split(",") if part.strip()]


def _js_runtimes() -> dict:
    runtimes: dict = {}
    node = shutil.which("node")
    if node:
        runtimes["node"] = {"path": node}
    deno = shutil.which("deno")
    if deno:
        runtimes["deno"] = {"path": deno}
    return runtimes


def _normalize_player_clients(clients: list[str], *, use_cookies: bool) -> list[str]:
    """Cookie 利用時は android が yt-dlp 側でスキップされるため除外する。"""
    if not use_cookies or not _resolve_yt_cookiefile():
        return clients
    return [c for c in clients if c != "android"]


def _player_client_attempts(*, use_cookies: bool = True) -> list[list[str]]:
    """
    Railway + Cookie では tv DRM / SABR で bestaudio が空になることがある。
    複数言語吹替トラックは web_safari / tv_downgraded でないと見えないことが多い。
    """
    raw = os.environ.get("WAVRICK_YT_PLAYER_CLIENT", "").strip()
    primary = _normalize_player_clients(
        [c.strip() for c in raw.split(",") if c.strip()],
        use_cookies=use_cookies,
    )
    if use_cookies and _resolve_yt_cookiefile():
        defaults: list[list[str]] = [
            ["web_safari", "web"],
            ["tv_downgraded", "web"],
            ["web", "tv", "tv_embedded"],
            ["tv", "tv_embedded", "web"],
            ["web"],
            ["mweb", "web"],
            ["ios", "web"],
        ]
    else:
        defaults = [
            ["web_safari", "android", "web"],
            ["tv_downgraded", "web"],
            ["android", "web"],
            ["tv", "tv_embedded", "android", "web"],
            ["web"],
            ["ios", "web"],
            ["mweb", "web"],
        ]
    if primary:
        return [primary] + [d for d in defaults if d != primary]
    return defaults


def _language_probe_client_attempts(*, use_cookies: bool = True) -> list[list[str]]:
    """Clients that are most likely to expose multi-language / dubbed audio tracks."""
    raw = os.environ.get("WAVRICK_YT_LANG_PLAYER_CLIENT", "").strip()
    if raw:
        primary = _normalize_player_clients(
            [c.strip() for c in raw.split(",") if c.strip()],
            use_cookies=use_cookies,
        )
        if primary:
            return [primary]
    # tv_downgraded is currently the most reliable for AI/multi-language audio.
    preferred = [
        ["tv_downgraded"],
        ["web_safari"],
        ["web"],
        ["mweb"],
        ["android"],
        ["ios"],
    ]
    return [
        _normalize_player_clients(clients, use_cookies=use_cookies) or clients
        for clients in preferred
    ]


def _youtube_extractor_args(player_clients: list[str] | None = None) -> dict:
    clients = player_clients or _player_client_attempts(use_cookies=True)[0]
    return {
        "youtube": {
            "player_client": clients,
            # Keep webpage enabled for lang probe-friendly clients when possible;
            # skip only when using cookie challenge-prone paths via env override.
            "player_skip": (
                []
                if os.environ.get("WAVRICK_YT_KEEP_WEBPAGE", "").strip().lower()
                in ("1", "true", "yes", "on")
                else ["webpage"]
            ),
            "player_js_version": ["actual"],
        }
    }


def _base_ydl_opts(
    *,
    use_cookies: bool = True,
    player_clients: list[str] | None = None,
    force_ipv4: bool | None = None,
    force_ipv6: bool | None = None,
    **extra,
) -> dict:
    # Default force_ipv4 helps some Railway/CDN cases, but language-dub tracks
    # frequently mint googlevideo URLs bound to the probe IP family. Forcing
    # IPv4 after an IPv6-bound URL → HTTP 403. Callers can override.
    if force_ipv4 is None:
        env = os.environ.get("WAVRICK_YT_FORCE_IPV4", "").strip().lower()
        if env in ("0", "false", "no", "off"):
            force_ipv4 = False
        elif env in ("1", "true", "yes", "on"):
            force_ipv4 = True
        else:
            force_ipv4 = True
    opts: dict = {
        "quiet": True,
        "noplaylist": True,
        "proxy": _yt_proxy(),
        "extractor_args": _youtube_extractor_args(player_clients),
    }
    if force_ipv4:
        opts["force_ipv4"] = True
    if force_ipv6:
        opts["force_ipv6"] = True
    if use_cookies:
        cookiefile = _resolve_yt_cookiefile()
        if cookiefile:
            opts["cookiefile"] = cookiefile
    runtimes = _js_runtimes()
    if runtimes:
        opts["js_runtimes"] = runtimes
    remote = _remote_components()
    if remote:
        opts["remote_components"] = remote
    opts.update(extra)
    return opts


def _ydl_options(
    out_tmpl: str,
    *,
    format_selector: str | None = None,
    use_cookies: bool = True,
    player_clients: list[str] | None = None,
) -> dict:
    # YouTube はクライアント検証が頻繁に変わる。複数 player_client で 403 / 形式なしを回避。
    opts = _base_ydl_opts(
        use_cookies=use_cookies,
        player_clients=player_clients,
        format=format_selector or _AUDIO_FORMAT,
        outtmpl=out_tmpl,
        no_warnings=False,
        # max_filesize を付けると高ビットレートの元音声が途中で切れる（10分動画が約4〜5分で終わる等）。
        # サイズ制限は ffmpeg 後の返却バイト（read_audio_file 後）だけでかける。
        socket_timeout=300,
        nopart=True,
        retries=5,
        fragment_retries=10,
    )
    if shutil.which("ffmpeg"):
        opts["postprocessors"] = [
            {
                "key": "FFmpegExtractAudio",
                "preferredcodec": "mp3",
                "preferredquality": "128",
            }
        ]
    return opts


from cors_utils import resolve_cors_origin
from rate_limit import check_extract_limit, check_video_meta_limit, rate_limit_config


@app.after_request
def _cors_headers(resp):
    origin = resolve_cors_origin(request.headers.get("Origin"))
    if origin:
        resp.headers["Access-Control-Allow-Origin"] = origin
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


def probe_media_duration_sec(path: str) -> float:
    """ffprobe でメディアの長さ（秒）を取得。失敗時は 0。"""
    ffprobe = shutil.which("ffprobe")
    if not ffprobe or not os.path.isfile(path):
        return 0.0
    proc = subprocess.run(
        [
            ffprobe,
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            path,
        ],
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    if proc.returncode != 0:
        return 0.0
    try:
        return max(0.0, float((proc.stdout or "").strip()))
    except ValueError:
        return 0.0


def youtube_video_duration_sec(url: str) -> float:
    """yt-dlp で動画メタの長さ（秒）。失敗時は 0（ダウンロード側で再判定）。"""
    clear_download_proxies()
    last_err: BaseException | None = None
    for use_cookies in (True, False) if _resolve_yt_cookiefile() else (False,):
        for clients in _player_client_attempts(use_cookies=use_cookies):
            try:
                opts = _base_ydl_opts(
                    skip_download=True,
                    use_cookies=use_cookies,
                    player_clients=clients,
                )
                with yt_dlp.YoutubeDL(opts) as ydl:
                    info = ydl.extract_info(url, download=False)
                if not info:
                    continue
                return max(0.0, float(info.get("duration") or 0))
            except Exception as exc:
                last_err = exc
                if not _is_format_or_challenge_error(exc):
                    logger.warning("video duration probe failed (%s)", exc)
                continue
    if last_err:
        logger.warning("video duration unavailable for %s: %s", url, last_err)
    return 0.0


def _is_audio_truncated(actual_sec: float, expected_sec: float) -> bool:
    if not (expected_sec >= 90 and actual_sec > 0):
        return False
    return actual_sec < expected_sec * _MIN_DURATION_RATIO


def audio_to_wav(input_path: str, wav_path: str) -> None:
    dur = probe_media_duration_sec(input_path)
    timeout = max(180, int(dur * 3) + 60) if dur > 0 else 180
    _run_ffmpeg(
        ["-y", "-i", input_path, "-ar", "44100", "-ac", "2", wav_path],
        timeout=timeout,
    )


def wav_to_mp3(wav_path: str, mp3_path: str) -> None:
    _run_ffmpeg(
        ["-y", "-i", wav_path, "-codec:a", "libmp3lame", "-b:a", "128k", mp3_path],
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


def _clear_out_files(out_dir: str) -> None:
    for old in glob.glob(os.path.join(out_dir, "out.*")):
        try:
            os.remove(old)
        except OSError:
            pass


def download_youtube_audio(
    url: str,
    out_dir: str,
    *,
    format_selector: str | None = None,
    use_cookies: bool = True,
    player_clients: list[str] | None = None,
) -> str:
    out_tmpl = os.path.join(out_dir, "out.%(ext)s")
    clear_download_proxies()
    _clear_out_files(out_dir)
    ydl_opts = _ydl_options(
        out_tmpl,
        format_selector=format_selector,
        use_cookies=use_cookies,
        player_clients=player_clients,
    )
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        ydl.download([url])
    files = glob.glob(os.path.join(out_dir, "out.*"))
    if not files:
        raise RuntimeError("yt-dlp produced no output file")
    return files[0]


def _normalize_lang_code(raw: str | None) -> str:
    return (raw or "").strip().lower().split("-")[0]


def _language_format_selector(target_lang: str, *, prefer_dub: bool = True) -> str:
    """
    yt-dlp format selector for a specific language audio track.

    Avoid `:not(...)` — older yt-dlp (and some builds) raise
    "Invalid format specification: Unexpected '('".
    Prefer probe-selected format_id when available; these selectors are fallbacks.
    """
    code = _normalize_lang_code(target_lang)
    if not code:
        return _AUDIO_FORMAT
    # Prefer dubbed / AI dub notes first, then any matching language audio.
    if prefer_dub:
        return (
            f"ba[language^={code}][format_note*=dub]/"
            f"ba[language^={code}][format_note*=Dub]/"
            f"bestaudio[language^={code}][format_note*=dub]/"
            f"ba[language^={code}]/"
            f"bestaudio[language^={code}]"
        )
    return f"ba[language^={code}]/bestaudio[language^={code}]"


def _audio_tracks_from_info(info: dict) -> list[dict]:
    """Enumerate audio-capable formats with language metadata."""
    formats = info.get("formats") or []
    tracks: list[dict] = []
    seen: set[tuple[str, str]] = set()
    for fmt in formats:
        acodec = fmt.get("acodec")
        if acodec in (None, "none"):
            continue
        vcodec = fmt.get("vcodec")
        lang_raw = str(fmt.get("language") or "").strip().lower()
        # Never use language_preference — it is often numeric and pollutes matching.
        note = str(fmt.get("format_note") or "")
        fmt_str = str(fmt.get("format") or "")
        audio_track = str(fmt.get("audio_track") or "")
        lang = lang_raw if re.fullmatch(r"[a-z]{2,3}([_-][a-z0-9]+)?", lang_raw or "") else ""
        if not lang:
            blob = f"{note} {fmt_str} {audio_track}".lower()
            for code in ("ja", "en", "es", "ko", "zh", "fr", "de", "pt", "it", "ru", "hi", "id", "th", "vi"):
                if (
                    f"[{code}]" in blob
                    or f"({code})" in blob
                    or f" {code} " in f" {blob} "
                    or blob.startswith(f"{code} ")
                    or blob.endswith(f" {code}")
                    or f"language={code}" in blob
                    or f"lang={code}" in blob
                ):
                    lang = code
                    break
            name_map = {
                "japanese": "ja",
                "日本語": "ja",
                "english": "en",
                "spanish": "es",
                "korean": "ko",
                "중국어": "zh",
                "chinese": "zh",
                "mandarin": "zh",
            }
            if not lang:
                for name, code in name_map.items():
                    if name in blob:
                        lang = code
                        break
        fmt_id = str(fmt.get("format_id") or "")
        key = (lang, fmt_id)
        if key in seen:
            continue
        seen.add(key)
        direct_url = str(fmt.get("url") or "").strip()
        manifest_url = str(fmt.get("manifest_url") or "").strip()
        http_headers = fmt.get("http_headers") if isinstance(fmt.get("http_headers"), dict) else {}
        tracks.append(
            {
                "formatId": fmt_id,
                "language": lang,
                "formatNote": note,
                "abr": fmt.get("abr"),
                "ext": fmt.get("ext") or "m4a",
                "isAudioOnly": vcodec in (None, "none"),
                "hasUrl": bool(direct_url or manifest_url),
                "downloadUrl": direct_url or None,
                "manifestUrl": manifest_url or None,
                "httpHeaders": {str(k): str(v) for k, v in http_headers.items()},
            }
        )
    return tracks


def _merge_audio_tracks(*track_lists: list[dict]) -> list[dict]:
    merged: list[dict] = []
    seen: set[tuple[str, str]] = set()
    for tracks in track_lists:
        for t in tracks:
            key = (str(t.get("language") or ""), str(t.get("formatId") or ""))
            if key in seen:
                # Prefer entries that have URL / richer note
                existing = next(
                    (x for x in merged if (str(x.get("language") or ""), str(x.get("formatId") or "")) == key),
                    None,
                )
                if existing and not existing.get("hasUrl") and t.get("hasUrl"):
                    existing.update(t)
                continue
            seen.add(key)
            merged.append(dict(t))
    return merged


def _track_lang_signals(track: dict) -> set[str]:
    """Collect all language codes hinted by metadata (field, note, xtags)."""
    signals: set[str] = set()
    raw = str(track.get("language") or "").strip().lower()
    if raw and re.fullmatch(r"[a-z]{2,3}([_-][a-z0-9]+)?", raw):
        signals.add(_normalize_lang_code(raw))
    note = str(track.get("formatNote") or "").lower()
    bracket = re.search(r"\[([a-z]{2,3}(?:-[a-z0-9]+)?)\]", note)
    if bracket:
        signals.add(_normalize_lang_code(bracket.group(1)))
    name_map = {
        "japanese": "ja",
        "日本語": "ja",
        "korean": "ko",
        "한국어": "ko",
        "english": "en",
        "spanish": "es",
        "chinese": "zh",
        "mandarin": "zh",
        "arabic": "ar",
        "french": "fr",
        "german": "de",
        "hindi": "hi",
        "indonesian": "id",
        "italian": "it",
        "portuguese": "pt",
        "russian": "ru",
    }
    for name, code in name_map.items():
        if name in note:
            signals.add(code)
    xt = _track_xtags_lang(track)
    if xt:
        xt_code = _normalize_lang_code(xt)
        if xt_code:
            signals.add(xt_code)
    signals.discard("")
    return signals


def _track_declared_lang_code(track: dict) -> str:
    """
    Best language code for a track.

    Prefer format_note markers ([ko] Korean, …) over the `language` field when
    they disagree — some yt-dlp clients mis-tag the default dub language onto
    every 140-* variant (which caused ko-as-ja downloads).
    """
    note = str(track.get("formatNote") or "").lower()
    bracket = re.search(r"\[([a-z]{2,3}(?:-[a-z0-9]+)?)\]", note)
    if bracket:
        return _normalize_lang_code(bracket.group(1))
    name_map = (
        ("japanese", "ja"),
        ("日本語", "ja"),
        ("korean", "ko"),
        ("한국어", "ko"),
        ("english", "en"),
        ("spanish", "es"),
        ("chinese", "zh"),
        ("mandarin", "zh"),
        ("arabic", "ar"),
        ("french", "fr"),
        ("german", "de"),
        ("hindi", "hi"),
        ("indonesian", "id"),
        ("italian", "it"),
        ("portuguese", "pt"),
        ("russian", "ru"),
    )
    for name, code in name_map:
        if name in note:
            return code
    raw = str(track.get("language") or "").strip().lower()
    if raw and re.fullmatch(r"[a-z]{2,3}([_-][a-z0-9]+)?", raw):
        return _normalize_lang_code(raw)
    return ""


def _track_matches_language(track: dict, target_lang: str) -> bool:
    code = _normalize_lang_code(target_lang)
    if not code:
        return False
    signals = _track_lang_signals(track)
    if not signals:
        return False
    # Any conflicting signal → not a match (never treat ko note as ja).
    if any(s != code for s in signals):
        return False
    return code in signals


def _format_id_lang_signals(tracks: list[dict], format_id: str) -> set[str]:
    """Union of language signals for a format_id across all probe clients/entries."""
    fid = str(format_id or "").strip()
    if not fid:
        return set()
    signals: set[str] = set()
    for t in tracks:
        if str(t.get("formatId") or "").strip() != fid:
            continue
        signals |= _track_lang_signals(t)
    signals.discard("")
    return signals


def _format_id_exclusively_target_lang(
    tracks: list[dict], format_id: str, target_lang: str
) -> bool:
    """
    True only when every language signal seen for this format_id equals target.

    Important: yt-dlp may emit duplicate format rows such as (language=ja, 140-9)
    from a buggy client AND (language=ko, 140-9) from a good one. Matching a single
    row is not enough — the format_id as a whole must be unambiguous.
    """
    code = _normalize_lang_code(target_lang)
    if not code:
        return False
    signals = _format_id_lang_signals(tracks, format_id)
    return bool(signals) and signals == {code}


def _tracks_for_target_lang(tracks: list[dict], target_lang: str) -> list[dict]:
    """Return downloadable track rows whose format_id is exclusively target_lang."""
    code = _normalize_lang_code(target_lang)
    if not code:
        return []
    out: list[dict] = []
    seen_fid: set[str] = set()
    # Prefer richer rows (hasUrl, dubbed) but only for exclusive format ids.
    candidates = [t for t in tracks if _track_matches_language(t, target_lang)]
    for t in sorted(candidates, key=_score_language_track, reverse=True):
        fid = str(t.get("formatId") or "").strip()
        if not fid or fid in seen_fid:
            continue
        if not _format_id_exclusively_target_lang(tracks, fid, target_lang):
            logger.warning(
                "reject ambiguous/mis-tagged format_id=%s for target=%s signals=%s",
                fid,
                target_lang,
                sorted(_format_id_lang_signals(tracks, fid)),
            )
            continue
        seen_fid.add(fid)
        out.append(t)
    # Also pick a representative row for exclusive format ids even if the "best"
    # scored row lost the soft match (should be rare).
    by_fid: dict[str, list[dict]] = {}
    for t in tracks:
        fid = str(t.get("formatId") or "").strip()
        if fid:
            by_fid.setdefault(fid, []).append(t)
    for fid, group in by_fid.items():
        if fid in seen_fid:
            continue
        if not _format_id_exclusively_target_lang(tracks, fid, target_lang):
            continue
        best = max(group, key=_score_language_track)
        seen_fid.add(fid)
        out.append(best)
    return out


def _select_language_format_id(tracks: list[dict], target_lang: str) -> str | None:
    pool_src = _tracks_for_target_lang(tracks, target_lang)
    if not pool_src:
        return None
    with_url = [t for t in pool_src if t.get("hasUrl")]
    pool = with_url or pool_src
    best = max(pool, key=_score_language_track)
    return str(best.get("formatId") or "") or None


def _lang_display_name(target_lang: str) -> str:
    code = _normalize_lang_code(target_lang)
    return _LANG_DISPLAY.get(code, code or "指定言語")


def _no_language_track_error(target_lang: str, found_langs: list[str] | None = None) -> str:
    name = _lang_display_name(target_lang)
    msg = (
        f"この動画には{name}の音声トラックが見つかりませんでした。\n"
        f"YouTube Studio の「言語」で{name}の音声トラックを追加・公開してから再度お試しください。"
        f"\n他言語の音声への切り替えは行いません。"
    )
    langs = [x for x in (found_langs or []) if x]
    if langs:
        msg += f"\n（yt-dlp が見つけた言語: {', '.join(langs)}）"
    else:
        msg += (
            "\n（注意: プレイヤーでは見えても、yt-dlp のプレイヤークライアントによっては"
            "言語トラック一覧が取れないことがあります。cookies / web_safari 設定を確認してください。）"
        )
    return msg


def _no_dub_track_error(target_lang: str, found_langs: list[str] | None = None) -> str:
    name = _lang_display_name(target_lang)
    msg = (
        f"この動画には{name}の吹替（非オリジナル）音声トラックが見つかりませんでした。\n"
        f"見つかったのは原盤言語トラックのみです。"
        f" YouTube Studio で{name}の AI 吹替／追加音声トラックを公開してから再度お試しください。"
        f"\n他言語の吹替への切り替えは行いません。"
    )
    langs = [x for x in (found_langs or []) if x]
    if langs:
        msg += f"\n（yt-dlp が見つけた言語: {', '.join(langs)}）"
    return msg


def _language_download_failed_error(
    target_lang: str,
    *,
    format_ids: list[str] | None = None,
    found_langs: list[str] | None = None,
    detail: str | None = None,
) -> str:
    name = _lang_display_name(target_lang)
    msg = (
        f"{name}の音声トラックは検出されましたが取得できませんでした。\n"
        f"他言語の音声への切り替えは行いません。"
    )
    ids = [x for x in (format_ids or []) if x]
    if ids:
        msg += f"\n（試した format: {', '.join(ids[:12])}）"
    langs = [x for x in (found_langs or []) if x]
    if langs:
        msg += f"\n（yt-dlp が見つけた言語: {', '.join(langs)}）"
    if detail:
        msg += f"\n詳細: {detail}"
    return msg


def _wrong_language_track_error(
    target_lang: str,
    *,
    got_lang: str | None = None,
    format_id: str | None = None,
) -> str:
    name = _lang_display_name(target_lang)
    got = _lang_display_name(got_lang) if got_lang else "別言語"
    fid = f" / format {format_id}" if format_id else ""
    return (
        f"指定した{name}の音声ではなく、{got}の音声が返されました{fid}。\n"
        f"他言語へのフォールバックは無効です。{name}トラックを取得できる状態で再度お試しください。"
    )


def _is_original_language_track(track: dict) -> bool:
    note = str(track.get("formatNote") or "").lower()
    return "original" in note


def _track_xtags(track: dict) -> str:
    """Return googlevideo xtags query value when present (e.g. acont=dubbed-auto:lang=ja)."""
    du = str(track.get("downloadUrl") or "").strip()
    if not du.startswith("http"):
        return ""
    try:
        from urllib.parse import parse_qs, urlparse

        q = parse_qs(urlparse(du).query)
        vals = q.get("xtags") or q.get("xtag") or []
        return str(vals[0] if vals else "").lower()
    except Exception:
        return ""


def _track_xtags_lang(track: dict) -> str:
    xt = _track_xtags(track)
    if not xt:
        return ""
    # acont=dubbed-auto:lang=ja  or lang=ja:acont=...
    for part in xt.replace("%3a", ":").replace("%3A", ":").split(":"):
        part = part.strip()
        if part.startswith("lang="):
            return part.split("=", 1)[1].strip().lower()
    if "lang=" in xt:
        return xt.split("lang=", 1)[1].split(":")[0].strip().lower()
    return ""


def _track_confirms_target_lang(track: dict, target_lang: str) -> bool:
    """True only when all language signals agree with the target language."""
    return _track_matches_language(track, target_lang)


def _track_has_strong_lang_label(track: dict) -> bool:
    """True when format_note carries an explicit language mark ([ja], Japanese, …)."""
    note = str(track.get("formatNote") or "").lower()
    if re.search(r"\[[a-z]{2,3}(?:-[a-z0-9]+)?\]", note):
        return True
    for name in (
        "japanese",
        "日本語",
        "korean",
        "한국어",
        "english",
        "spanish",
        "chinese",
        "mandarin",
        "arabic",
        "french",
        "german",
        "hindi",
        "indonesian",
        "italian",
        "portuguese",
        "russian",
    ):
        if name in note:
            return True
    return False


def _assert_selected_format_is_target_lang(
    tracks: list[dict],
    selected_format_id: str | None,
    target_lang: str,
) -> str:
    """
    Ensure the downloaded format ID is exclusively catalogued as target_lang.
    Returns the normalized selected format id or raises WRONG_LANGUAGE_TRACK.
    """
    code = _normalize_lang_code(target_lang)
    fid = str(selected_format_id or "").strip()
    if not fid or fid.startswith("ba[") or "/" in fid:
        raise RuntimeError(
            "WRONG_LANGUAGE_TRACK: "
            + _wrong_language_track_error(target_lang, format_id=fid or "(selector)")
            + "\n（言語固定の format ID 以外での取得は許可していません）"
        )
    signals = _format_id_lang_signals(tracks, fid)
    if not signals:
        raise RuntimeError(
            "WRONG_LANGUAGE_TRACK: "
            + _wrong_language_track_error(target_lang, format_id=fid)
            + "\n（取得した format がプローブ一覧にありません）"
        )
    if signals != {code}:
        got = ",".join(sorted(s for s in signals if s != code)) or ",".join(sorted(signals))
        raise RuntimeError(
            "WRONG_LANGUAGE_TRACK: "
            + _wrong_language_track_error(target_lang, got_lang=got, format_id=fid)
            + f"\n（format {fid} の言語信号: {', '.join(sorted(signals))}）"
        )
    # Require at least one strongly labeled row for this format_id.
    same_id = [t for t in tracks if str(t.get("formatId") or "").strip() == fid]
    if not any(_track_has_strong_lang_label(t) for t in same_id):
        raise RuntimeError(
            "WRONG_LANGUAGE_TRACK: "
            + _wrong_language_track_error(target_lang, format_id=fid)
            + "\n（言語ラベルが弱いため確定できませんでした）"
        )
    return fid


def _prefer_dub_language_tracks(
    lang_tracks: list[dict],
    *,
    require_dubbed: bool,
    target_lang: str,
    found_langs: list[str] | None,
) -> list[dict]:
    """Prefer non-original (dubbed) tracks; optionally hard-fail if only original exists."""
    if not lang_tracks:
        return lang_tracks
    # Prefer URL-marked AI dubs, then notes without "original"
    dubbed_xtags = [t for t in lang_tracks if "dubbed" in _track_xtags(t)]
    if dubbed_xtags:
        return dubbed_xtags
    dubbed = [t for t in lang_tracks if not _is_original_language_track(t)]
    if dubbed:
        return dubbed
    if require_dubbed:
        raise RuntimeError(f"NO_LANGUAGE_TRACK: {_no_dub_track_error(target_lang, found_langs)}")
    return lang_tracks


def _score_language_track(track: dict) -> float:
    note = str(track.get("formatNote") or "").lower()
    xt = _track_xtags(track)
    score = 0.0
    if track.get("isAudioOnly"):
        score += 10.0
    if track.get("hasUrl"):
        score += 5.0
    if "dub" in note or "dubbed" in xt:
        score += 20.0
    if "original" in note or "acont=original" in xt:
        score -= 15.0
    score += float(track.get("abr") or 0) / 128.0
    return score


def probe_youtube_audio_tracks(
    url: str,
    *,
    target_lang: str | None = None,
) -> tuple[dict | None, list[dict], BaseException | None]:
    """
    Probe available audio tracks via yt-dlp across multiple player clients.

    Stops early once a client/IP combo exposes language-tagged tracks
    (and preferably the requested target_lang). Exhaustive probing is too slow
    for interactive extract requests.
    """
    clear_download_proxies()
    last_err: BaseException | None = None
    best_info: dict | None = None
    merged: list[dict] = []
    want = _normalize_lang_code(target_lang)
    # Language-dub listing is often more reliable without cookies on tv_downgraded.
    # Prefer no-cookie first; stale cookies frequently cause bot challenges on download.
    if _resolve_yt_cookiefile():
        cookie_modes = (False, True) if want else (True, False)
    else:
        cookie_modes = (False,)

    # Try IPv6 first: dubbed-track googlevideo URLs minted on dual-stack Macs
    # are often IPv6-bound and 403 when force_ipv4 remaps the download.
    ip_modes: list[tuple[bool | None, bool | None, str]] = [
        (False, True, "ipv6"),
        (False, False, "auto"),
        (True, False, "ipv4"),
    ]

    for use_cookies in cookie_modes:
        for clients in _language_probe_client_attempts(use_cookies=use_cookies):
            for force_v4, force_v6, ip_label in ip_modes:
                try:
                    opts = _base_ydl_opts(
                        skip_download=True,
                        use_cookies=use_cookies,
                        player_clients=clients,
                        force_ipv4=force_v4,
                        force_ipv6=force_v6,
                        # Weak clients may only expose thumbnails; don't raise
                        # "Requested format is not available" during probe.
                        ignore_no_formats_error=True,
                        format="ba/bestaudio/best/worst",
                    )
                    if any(c in ("web_safari", "tv_downgraded", "web") for c in clients):
                        ya = dict(opts.get("extractor_args", {}).get("youtube", {}))
                        ya["player_skip"] = []
                        opts["extractor_args"] = {"youtube": ya}
                    with yt_dlp.YoutubeDL(opts) as ydl:
                        info = ydl.extract_info(url, download=False)
                    if not info:
                        continue
                    if best_info is None:
                        best_info = info
                    tracks = _audio_tracks_from_info(info)
                    for t in tracks:
                        t["sourceClient"] = ",".join(clients)
                        t["sourceIpFamily"] = ip_label
                        t["sourceUseCookies"] = bool(use_cookies)
                    langs = sorted({str(t.get("language") or "") for t in tracks if t.get("language")})
                    logger.info(
                        "track probe clients=%s cookies=%s ip=%s formats=%d langs=%s",
                        clients,
                        use_cookies,
                        ip_label,
                        len(tracks),
                        langs[:12],
                    )
                    merged = _merge_audio_tracks(merged, tracks)

                    has_langs = any(t.get("language") for t in tracks)
                    # Only early-stop on a STRONG target match (note/[lang] evidence).
                    # Weak language=ja tagging on Korean 140-9 caused wrong downloads
                    # when we stopped probing before a correctly labeled client appeared.
                    has_target_strong = bool(
                        want
                        and any(
                            _track_matches_language(t, want) and _track_has_strong_lang_label(t)
                            for t in merged
                        )
                    )
                    # When multiple 140-* dubs exist, wait until we know ≥2 languages
                    # so a single mis-tagged row cannot win alone.
                    family_langs = {
                        s
                        for t in merged
                        if str(t.get("formatId") or "").startswith("140")
                        for s in _track_lang_signals(t)
                    }
                    multi_dub_ok = (not want) or len(family_langs) >= 2 or not any(
                        str(t.get("formatId") or "").startswith("140") for t in merged
                    )
                    if has_target_strong and multi_dub_ok:
                        return best_info, merged, None
                    if has_langs and len(langs) >= 2 and not want:
                        return best_info, merged, None
                    if has_langs and not want:
                        return best_info, merged, None
                    # Found langs but not a strong target — keep probing other clients.
                    if has_langs:
                        break  # move to next client; don't thrash IP families
                except Exception as exc:
                    last_err = exc
                    if _is_format_or_challenge_error(exc):
                        logger.warning(
                            "track probe failed (%s) clients=%s cookies=%s ip=%s",
                            exc,
                            clients,
                            use_cookies,
                            ip_label,
                        )
                        continue
                    raise

    if best_info is not None:
        return best_info, merged, None
    return None, [], last_err


def probe_youtube_audio_tracks_for_lang(
    url: str, target_lang: str
) -> tuple[dict | None, list[dict], BaseException | None, list[str]]:
    """
    Probe and prefer client that exposes the requested language.
    Returns (info, tracks, err, languages_found).
    """
    info, tracks, err = probe_youtube_audio_tracks(url, target_lang=target_lang)
    langs = sorted({str(t.get("language") or "") for t in tracks if t.get("language")})
    if target_lang and tracks and not any(_track_matches_language(t, target_lang) for t in tracks):
        logger.warning(
            "targetLang=%s not in probed langs=%s (tracks=%d)",
            target_lang,
            langs,
            len(tracks),
        )
    return info, tracks, err, langs


def _download_ip_kwargs(ip_family: str | None) -> dict:
    fam = (ip_family or "auto").lower()
    if fam == "ipv6":
        return {"force_ipv4": False, "force_ipv6": True}
    if fam == "ipv4":
        return {"force_ipv4": True, "force_ipv6": False}
    return {"force_ipv4": False, "force_ipv6": False}


def _download_direct_media_url(
    media_url: str,
    out_dir: str,
    *,
    ext_hint: str | None = None,
    http_headers: dict | None = None,
) -> str:
    """
    Download a googlevideo / CDN URL minted by probe without re-hitting YouTube
    player APIs (avoids a second extract that often triggers bot challenges).
    """
    clear_download_proxies()
    ext = (ext_hint or "webm").lstrip(".") or "webm"
    raw_path = os.path.join(out_dir, f"direct.{ext}")
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
        ),
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Origin": "https://www.youtube.com",
        "Referer": "https://www.youtube.com/",
    }
    if http_headers:
        for k, v in http_headers.items():
            if v:
                headers[str(k)] = str(v)
    req = urllib.request.Request(media_url, headers=headers, method="GET")
    with urllib.request.urlopen(req, timeout=300) as resp:
        with open(raw_path, "wb") as fh:
            while True:
                chunk = resp.read(1024 * 256)
                if not chunk:
                    break
                fh.write(chunk)
    if not os.path.isfile(raw_path) or os.path.getsize(raw_path) < 256:
        raise RuntimeError("direct URL download produced empty file")

    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return raw_path
    mp3_path = os.path.join(out_dir, "out.mp3")
    cmd = [
        ffmpeg,
        "-y",
        "-i",
        raw_path,
        "-vn",
        "-acodec",
        "libmp3lame",
        "-b:a",
        "128k",
        mp3_path,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0 or not os.path.isfile(mp3_path):
        logger.warning("ffmpeg remux failed; returning raw direct download: %s", proc.stderr[-400:])
        return raw_path
    try:
        os.remove(raw_path)
    except OSError:
        pass
    return mp3_path


def download_youtube_audio_by_language(
    url: str,
    out_dir: str,
    target_lang: str,
    *,
    require_dubbed: bool = False,
) -> tuple[str, float, float, str | None]:
    """
    Download language-specific audio track.
    Returns (path, audio_duration_sec, video_duration_sec, selected_format_id).
    Raises RuntimeError with user-facing message on failure.

    Never falls back to a different language. If the target language track cannot
    be downloaded, raises NO_LANGUAGE_TRACK / FETCH_FAILED / WRONG_LANGUAGE_TRACK.
    """
    info, tracks, probe_err, found_langs = probe_youtube_audio_tracks_for_lang(url, target_lang)
    expected = max(0.0, float((info or {}).get("duration") or 0))
    if probe_err and not tracks:
        detail = _friendly_yt_extract_error(str(probe_err).strip() or probe_err.__class__.__name__)
        raise RuntimeError(f"FETCH_FAILED: {detail}")

    # Exclusive format_id match across all probe clients (rejects mis-tagged rows
    # when another client correctly labels the same format_id as a different lang).
    lang_tracks = _tracks_for_target_lang(tracks, target_lang)
    # Prefer rows with explicit note/[lang] evidence.
    strong = [t for t in lang_tracks if _track_has_strong_lang_label(t)]
    if strong:
        lang_tracks = strong
    if not lang_tracks:
        raise RuntimeError(
            f"NO_LANGUAGE_TRACK: {_no_language_track_error(target_lang, found_langs)}"
            + "\n（確定できる対象言語 format がありません。他言語への切り替えは行いません。）"
        )

    lang_tracks = _prefer_dub_language_tracks(
        lang_tracks,
        require_dubbed=require_dubbed,
        target_lang=target_lang,
        found_langs=found_langs,
    )

    # Prefer higher ABR + hasUrl, then score; keep source metadata for download.
    lang_tracks = sorted(lang_tracks, key=_score_language_track, reverse=True)
    fmt_id = str(lang_tracks[0].get("formatId") or "") or None
    preferred_clients = [
        c.strip()
        for c in str(lang_tracks[0].get("sourceClient") or "tv_downgraded").split(",")
        if c.strip()
    ] or ["tv_downgraded"]
    preferred_ip = str(lang_tracks[0].get("sourceIpFamily") or "ipv6")
    preferred_cookies = bool(lang_tracks[0].get("sourceUseCookies"))

    # ONLY exact confirmed format IDs — never bare "140" or ba[language^=…]
    # (those can resolve to a different dubbed language).
    format_attempts: list[str] = []
    for t in lang_tracks:
        fid = str(t.get("formatId") or "").strip()
        if fid and fid not in format_attempts:
            format_attempts.append(fid)
    if not format_attempts:
        raise RuntimeError(f"NO_LANGUAGE_TRACK: {_no_language_track_error(target_lang, found_langs)}")

    client_attempts: list[list[str]] = [preferred_clients]
    if preferred_clients != ["tv_downgraded"]:
        client_attempts.append(["tv_downgraded"])

    # Stick to probe IP first; only one alternate (IPv4 after IPv6 often 403s dubbed CDN).
    ip_attempts = [preferred_ip]
    if preferred_ip != "auto":
        ip_attempts.append("auto")

    # CRITICAL: download with the same cookie mode that exposed the language track.
    cookie_modes: list[bool] = [preferred_cookies]
    alt = not preferred_cookies
    if alt is True and not _resolve_yt_cookiefile():
        alt = False
    if alt != preferred_cookies and alt not in cookie_modes:
        cookie_modes.append(alt)
    if preferred_cookies is False and True not in cookie_modes and _resolve_yt_cookiefile():
        cookie_modes.append(True)

    path = ""
    last_err: BaseException | None = None
    success_ctx: tuple[bool, list[str] | None, str] = (
        bool(cookie_modes[0]),
        preferred_clients,
        preferred_ip,
    )
    selected_attempt: str | None = None

    # Prefer probe-minted googlevideo URL — skips a second player extract.
    for t in lang_tracks:
        if not _track_confirms_target_lang(t, target_lang):
            continue
        xt_lang = _track_xtags_lang(t)
        if xt_lang and _normalize_lang_code(xt_lang) != _normalize_lang_code(target_lang):
            logger.warning(
                "skip track format=%s — xtags lang=%s != target=%s",
                t.get("formatId"),
                xt_lang,
                target_lang,
            )
            continue
        direct = str(t.get("downloadUrl") or "").strip()
        if not direct.startswith("http"):
            continue
        try:
            _clear_out_files(out_dir)
            path = _download_direct_media_url(
                direct,
                out_dir,
                ext_hint=str(t.get("ext") or "webm"),
                http_headers=t.get("httpHeaders") if isinstance(t.get("httpHeaders"), dict) else None,
            )
            selected_attempt = str(t.get("formatId") or "") or None
            success_ctx = (preferred_cookies, preferred_clients, preferred_ip)
            logger.warning(
                "language audio direct URL succeeded lang=%s format=%s xtags_lang=%s size=%s",
                target_lang,
                selected_attempt,
                _track_xtags_lang(t) or "?",
                os.path.getsize(path),
            )
            break
        except Exception as exc:
            last_err = exc
            logger.warning(
                "language direct URL failed format=%s (%s) — trying next / yt-dlp",
                t.get("formatId"),
                exc,
            )
            path = ""

    for use_cookies in cookie_modes:
        if path:
            break
        drop_this_cookie_mode = False
        for clients in client_attempts:
            for ip_label in ip_attempts:
                ip_kw = _download_ip_kwargs(ip_label)
                for fmt in format_attempts:
                    try:
                        out_tmpl = os.path.join(out_dir, "out.%(ext)s")
                        clear_download_proxies()
                        _clear_out_files(out_dir)
                        ydl_opts = _base_ydl_opts(
                            use_cookies=use_cookies,
                            player_clients=clients,
                            force_ipv4=ip_kw["force_ipv4"],
                            force_ipv6=ip_kw["force_ipv6"],
                            format=fmt,
                            outtmpl=out_tmpl,
                            no_warnings=False,
                            socket_timeout=300,
                            nopart=True,
                            retries=2,
                            fragment_retries=3,
                        )
                        if shutil.which("ffmpeg"):
                            ydl_opts["postprocessors"] = [
                                {
                                    "key": "FFmpegExtractAudio",
                                    "preferredcodec": "mp3",
                                    "preferredquality": "128",
                                }
                            ]
                        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                            ydl.download([url])
                        files = glob.glob(os.path.join(out_dir, "out.*"))
                        if not files:
                            raise RuntimeError("yt-dlp produced no output file")
                        path = files[0]
                        last_err = None
                        success_ctx = (use_cookies, clients, ip_label)
                        selected_attempt = fmt
                        logger.warning(
                            "language audio download succeeded lang=%s format=%s clients=%s ip=%s cookies=%s",
                            target_lang,
                            fmt,
                            clients,
                            ip_label,
                            use_cookies,
                        )
                        break
                    except Exception as exc:
                        last_err = exc
                        msg = str(exc)
                        is_bot = "Sign in to confirm" in msg or "not a bot" in msg.lower()
                        if is_bot:
                            logger.warning(
                                "YouTube bot check cookies=%s — switching cookie mode / aborting",
                                use_cookies,
                            )
                            drop_this_cookie_mode = True
                            break
                        if _is_format_or_challenge_error(exc):
                            logger.warning(
                                "language download retry (%s) format=%s clients=%s ip=%s cookies=%s",
                                exc,
                                fmt,
                                clients,
                                ip_label,
                                use_cookies,
                            )
                            continue
                        raise
                if path or drop_this_cookie_mode:
                    break
            if path or drop_this_cookie_mode:
                break
        if path:
            break

    if not path:
        detail = _friendly_yt_extract_error(
            str(last_err).strip() if last_err else "yt-dlp produced no output file"
        )
        raise RuntimeError(
            "NO_LANGUAGE_TRACK: "
            + _language_download_failed_error(
                target_lang,
                format_ids=format_attempts,
                found_langs=found_langs,
                detail=detail,
            )
        )

    selected = _assert_selected_format_is_target_lang(tracks, selected_attempt or fmt_id, target_lang)

    actual = probe_media_duration_sec(path)
    if _is_audio_truncated(actual, expected):
        retry_fmt = selected
        out_tmpl = os.path.join(out_dir, "out.%(ext)s")
        clear_download_proxies()
        _clear_out_files(out_dir)
        ip_kw = _download_ip_kwargs(success_ctx[2])
        ydl_opts = _base_ydl_opts(
            use_cookies=success_ctx[0],
            player_clients=success_ctx[1],
            force_ipv4=ip_kw["force_ipv4"],
            force_ipv6=ip_kw["force_ipv6"],
            format=retry_fmt,
            outtmpl=out_tmpl,
            no_warnings=False,
            socket_timeout=300,
            nopart=True,
            retries=5,
            fragment_retries=10,
        )
        if shutil.which("ffmpeg"):
            ydl_opts["postprocessors"] = [
                {
                    "key": "FFmpegExtractAudio",
                    "preferredcodec": "mp3",
                    "preferredquality": "128",
                }
            ]
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([url])
        files = glob.glob(os.path.join(out_dir, "out.*"))
        if not files:
            raise RuntimeError("yt-dlp produced no output file")
        path = files[0]
        actual = probe_media_duration_sec(path)
        selected = _assert_selected_format_is_target_lang(tracks, selected, target_lang)
    if _is_audio_truncated(actual, expected):
        raise RuntimeError(
            "YouTube 音声が動画より短く切れています"
            f"（取得 {actual:.0f}秒 / 動画 {expected:.0f}秒）。"
            " 音声ファイルを直接アップロードするか、再度お試しください。"
        )
    return path, actual, expected, selected


def _pick_downloadable_format_id(info: dict) -> str | None:
    """利用可能な形式一覧から実際に URL のある音声（なければ動画+音声）を選ぶ。"""
    formats = info.get("formats") or []

    def has_stream(fmt: dict) -> bool:
        return bool(fmt.get("url") or fmt.get("manifest_url"))

    audio_only = [
        f
        for f in formats
        if has_stream(f)
        and f.get("acodec") not in (None, "none")
        and f.get("vcodec") in (None, "none")
    ]
    if audio_only:
        best = max(audio_only, key=lambda f: float(f.get("abr") or 0))
        return str(best["format_id"])

    mux = [
        f
        for f in formats
        if has_stream(f)
        and f.get("acodec") not in (None, "none")
        and f.get("vcodec") not in (None, "none")
    ]
    if mux:
        best = min(mux, key=lambda f: (float(f.get("height") or 9999), -float(f.get("abr") or 0)))
        return str(best["format_id"])
    return None


def download_youtube_audio_probed(
    url: str,
    out_dir: str,
    *,
    use_cookies: bool = True,
    player_clients: list[str] | None = None,
) -> str:
    """形式セレクタ文字列が全部失敗したとき、一覧から format_id を直接選んで取得。"""
    clear_download_proxies()
    _clear_out_files(out_dir)
    opts = _base_ydl_opts(
        skip_download=True,
        use_cookies=use_cookies,
        player_clients=player_clients,
    )
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False)
    fmt_id = _pick_downloadable_format_id(info or {})
    if not fmt_id:
        raise RuntimeError("no downloadable audio format in yt-dlp probe")
    logger.warning(
        "audio download using probed format_id=%s clients=%s cookies=%s",
        fmt_id,
        player_clients,
        use_cookies,
    )
    return download_youtube_audio(
        url,
        out_dir,
        format_selector=fmt_id,
        use_cookies=use_cookies,
        player_clients=player_clients,
    )


def _is_format_or_challenge_error(exc: BaseException) -> bool:
    msg = str(exc).lower()
    return any(
        token in msg
        for token in (
            "no video formats found",
            "requested format is not available",
            "invalid format specification",
            "unexpected (",
            "http error 403",
            "forbidden",
            "sign in to confirm",
            "not a bot",
            "challenge solving failed",
            "only images are available",
        )
    )


def download_youtube_audio_full_length(url: str, out_dir: str) -> tuple[str, float, float]:
    """
    動画メタの長さと照合し、途中切断されていれば低ビットレート形式で再取得する。
    Returns (path, audio_duration_sec, video_duration_sec).
    """
    expected = youtube_video_duration_sec(url)
    format_attempts = [
        _AUDIO_FORMAT,
        _AUDIO_FORMAT_FALLBACK,
        _AUDIO_FORMAT_ANY,
        _AUDIO_FORMAT_MUX,
        _AUDIO_FORMAT_BEST,
        _AUDIO_FORMAT_LAST_RESORT,
    ]

    path = ""
    last_err: BaseException | None = None
    success_ctx: tuple[bool, list[str] | None] = (True, None)
    cookie_modes = (True, False) if _resolve_yt_cookiefile() else (False,)
    for use_cookies in cookie_modes:
        for clients in _player_client_attempts(use_cookies=use_cookies):
            for idx, fmt in enumerate(format_attempts):
                try:
                    path = download_youtube_audio(
                        url,
                        out_dir,
                        format_selector=fmt,
                        use_cookies=use_cookies,
                        player_clients=clients,
                    )
                    last_err = None
                    success_ctx = (use_cookies, clients)
                    if idx > 0 or clients != _player_client_attempts(use_cookies=use_cookies)[0]:
                        logger.warning(
                            "audio download succeeded with cookies=%s clients=%s format=%s",
                            use_cookies,
                            clients,
                            fmt,
                        )
                    break
                except Exception as exc:
                    last_err = exc
                    if _is_format_or_challenge_error(exc) and idx < len(format_attempts) - 1:
                        logger.warning(
                            "audio download failed (%s) — retry format %s (clients=%s cookies=%s)",
                            exc,
                            format_attempts[idx + 1],
                            clients,
                            use_cookies,
                        )
                        continue
                    if _is_format_or_challenge_error(exc):
                        logger.warning(
                            "audio download failed (%s) — try next client/cookie mode",
                            exc,
                        )
                        break
                    raise
            if path:
                break
            try:
                path = download_youtube_audio_probed(
                    url,
                    out_dir,
                    use_cookies=use_cookies,
                    player_clients=clients,
                )
                last_err = None
                success_ctx = (use_cookies, clients)
                break
            except Exception as exc:
                last_err = exc
                if _is_format_or_challenge_error(exc):
                    logger.warning(
                        "probed audio download failed (%s) — try next client/cookie mode",
                        exc,
                    )
                    continue
                raise
        if path:
            break

    if not path:
        raise last_err or RuntimeError("yt-dlp produced no output file")

    actual = probe_media_duration_sec(path)
    if _is_audio_truncated(actual, expected):
        logger.warning(
            "audio truncated (%.1fs / video %.1fs) — retry format %s",
            actual,
            expected,
            _AUDIO_FORMAT_FALLBACK,
        )
        path = download_youtube_audio(
            url,
            out_dir,
            format_selector=_AUDIO_FORMAT_FALLBACK,
            use_cookies=success_ctx[0],
            player_clients=success_ctx[1],
        )
        actual = probe_media_duration_sec(path)
    if _is_audio_truncated(actual, expected):
        raise RuntimeError(
            "YouTube 音声が動画より短く切れています"
            f"（取得 {actual:.0f}秒 / 動画 {expected:.0f}秒）。"
            " 音声ファイルを直接アップロードするか、"
            " WAVRICK_VOCAL_SEPARATION=0 で ./scripts/start-audio-proxy.sh を再起動して再試行してください。"
        )
    return path, actual, expected


def read_audio_file(path: str) -> tuple[bytes, str]:
    with open(path, "rb") as fh:
        data = fh.read()
    return data, _guess_mimetype(path)


def supabase_storage_public_url(storage_path: str) -> str:
    base = os.environ.get("SUPABASE_URL", "").rstrip("/")
    object_path = storage_path.lstrip("/")
    return f"{base}/storage/v1/object/public/customer-uploads/{object_path}"


def upload_to_supabase_storage(local_path: str, storage_path: str, content_type: str) -> str:
    """Railway 上で音声を Supabase Storage に直接保存（Edge Function のメモリ節約）。"""
    base = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    if not base or not key:
        raise RuntimeError(
            "delivery=storage には Railway の環境変数 SUPABASE_URL と "
            "SUPABASE_SERVICE_ROLE_KEY が必要です。"
        )
    object_path = storage_path.lstrip("/")
    url = f"{base}/storage/v1/object/customer-uploads/{object_path}"
    with open(local_path, "rb") as fh:
        payload = fh.read()
    req = urllib.request.Request(
        url,
        data=payload,
        method="POST",
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": content_type or "audio/mpeg",
            "x-upsert": "true",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            if resp.status not in (200, 201):
                body = resp.read(500)
                raise RuntimeError(f"Supabase storage upload HTTP {resp.status}: {body!r}")
    except urllib.error.HTTPError as e:
        body = e.read(500)
        raise RuntimeError(f"Supabase storage upload HTTP {e.code}: {body!r}") from e
    return supabase_storage_public_url(object_path)


@app.route("/probe-tracks", methods=["OPTIONS"])
def probe_tracks_options():
    return Response("", status=204)


@app.post("/probe-tracks")
def probe_tracks():
    secret = os.environ.get("PROXY_SECRET", "").strip()
    if secret:
        auth = request.headers.get("Authorization", "")
        if auth != f"Bearer {secret}":
            abort(401)

    allowed, retry_after = check_video_meta_limit()
    if not allowed:
        return (
            jsonify({"ok": False, "error": "リクエスト制限に達しました。しばらくして再試行してください。"}),
            429,
            {"Retry-After": str(retry_after)},
        )

    payload = request.get_json(silent=True) or {}
    url = (payload.get("videoUrl") or payload.get("url") or "").strip()
    target_lang = _normalize_lang_code(payload.get("targetLang") or payload.get("language") or "")
    if not url or not host_allowed(url):
        abort(400)

    try:
        info, tracks, probe_err = probe_youtube_audio_tracks(url)
    except Exception as exc:
        logger.exception("probe-tracks failed for %s", url)
        detail = _friendly_yt_extract_error(str(exc).strip() or exc.__class__.__name__)
        return jsonify({"ok": False, "errorCode": "FETCH_FAILED", "error": detail}), 502

    if probe_err and not tracks:
        detail = _friendly_yt_extract_error(str(probe_err).strip() or probe_err.__class__.__name__)
        return jsonify({"ok": False, "errorCode": "FETCH_FAILED", "error": detail}), 502

    langs = sorted({str(t.get("language") or "") for t in tracks if t.get("language")})
    matched = [t for t in tracks if _track_matches_language(t, target_lang)] if target_lang else []
    selected_format_id = _select_language_format_id(tracks, target_lang) if target_lang else None

    resp = {
        "ok": True,
        "videoId": str((info or {}).get("id") or ""),
        "durationSec": max(0.0, float((info or {}).get("duration") or 0)),
        "tracks": tracks,
        "languages": langs,
        "targetLang": target_lang or None,
        "matchedCount": len(matched),
        "selectedFormatId": selected_format_id,
    }
    if target_lang and not matched:
        resp["errorCode"] = "NO_LANGUAGE_TRACK"
        resp["error"] = _no_language_track_error(target_lang, langs)
    return jsonify(resp)


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

    allowed, retry_after = check_extract_limit()
    if not allowed:
        return (
            jsonify({"ok": False, "error": "リクエスト制限に達しました。しばらくして再試行してください。"}),
            429,
            {"Retry-After": str(retry_after)},
        )

    payload = request.get_json(silent=True) or {}
    url = (payload.get("videoUrl") or payload.get("url") or "").strip()
    if not url or not host_allowed(url):
        abort(400)

    target_lang = _normalize_lang_code(payload.get("targetLang") or payload.get("language") or "")
    require_dub_raw = payload.get("requireDubTrack", payload.get("requireDubbed", False))
    if isinstance(require_dub_raw, str):
        require_dubbed = require_dub_raw.strip().lower() not in ("0", "false", "no", "off", "")
    else:
        require_dubbed = bool(require_dub_raw)
    vocal_requested = payload.get("vocalSeparate", payload.get("vocalOnly", None))
    if vocal_requested is None:
        vocal_requested = not bool(target_lang)
    if isinstance(vocal_requested, str):
        vocal_requested = vocal_requested.strip().lower() not in ("0", "false", "no", "off")
    else:
        vocal_requested = bool(vocal_requested)

    out_dir = tempfile.mkdtemp(prefix="wavrick_yt_")
    separated = False
    audio_dur = 0.0
    video_dur = 0.0
    selected_format_id: str | None = None
    try:
        if target_lang:
            path, audio_dur, video_dur, selected_format_id = download_youtube_audio_by_language(
                url, out_dir, target_lang, require_dubbed=require_dubbed
            )
        else:
            path, audio_dur, video_dur = download_youtube_audio_full_length(url, out_dir)
        if vocal_requested and _VOCAL_SEPARATION:
            path, separated = apply_vocal_separation(path, out_dir)
            audio_dur = probe_media_duration_sec(path) or audio_dur
            if _is_audio_truncated(audio_dur, video_dur):
                logger.warning(
                    "vocals shorter than video (%.1fs / %.1fs) — retry without demucs",
                    audio_dur,
                    video_dur,
                )
                path, audio_dur, video_dur = download_youtube_audio_full_length(url, out_dir)
                separated = False
        mime = _guess_mimetype(path)
        file_size = os.path.getsize(path)
        audio_dur = probe_media_duration_sec(path) or audio_dur

        delivery = (payload.get("delivery") or "bytes").strip().lower()
        storage_path = (payload.get("storagePath") or "").strip()
        if delivery == "storage":
            if not storage_path:
                abort(400, description="storagePath is required when delivery=storage")
            if file_size > MAX_BYTES:
                abort(413)
            if file_size < 256:
                abort(502)
            try:
                public_url = upload_to_supabase_storage(path, storage_path, mime)
            except RuntimeError as exc:
                return jsonify({"ok": False, "error": str(exc)}), 502
            return jsonify(
                {
                    "ok": True,
                    "audioUrl": public_url,
                    "vocalSeparated": separated,
                    "audioDurationSec": audio_dur,
                    "videoDurationSec": video_dur,
                    "mime": mime,
                    "byteLength": file_size,
                    "targetLang": target_lang or None,
                    "selectedFormatId": selected_format_id,
                }
            )

        data, mime = read_audio_file(path)
    except Exception as exc:
        logger.exception("extract failed for %s", url)
        shutil.rmtree(out_dir, ignore_errors=True)
        detail = str(exc).strip() or exc.__class__.__name__
        if detail.startswith("NO_LANGUAGE_TRACK:"):
            return jsonify(
                {
                    "ok": False,
                    "errorCode": "NO_LANGUAGE_TRACK",
                    "error": detail.split(":", 1)[1].strip(),
                    "targetLang": target_lang or None,
                }
            ), 422
        if detail.startswith("WRONG_LANGUAGE_TRACK:"):
            return jsonify(
                {
                    "ok": False,
                    "errorCode": "WRONG_LANGUAGE_TRACK",
                    "error": detail.split(":", 1)[1].strip(),
                    "targetLang": target_lang or None,
                }
            ), 422
        if detail.startswith("FETCH_FAILED:"):
            return jsonify(
                {
                    "ok": False,
                    "errorCode": "FETCH_FAILED",
                    "error": detail.split(":", 1)[1].strip(),
                    "targetLang": target_lang or None,
                }
            ), 502
        friendly = _friendly_yt_extract_error(detail)
        return jsonify({"ok": False, "errorCode": "FETCH_FAILED", "error": friendly}), 502
    finally:
        shutil.rmtree(out_dir, ignore_errors=True)

    if len(data) > MAX_BYTES:
        abort(413)
    if len(data) < 256:
        abort(502)

    resp = Response(data, mimetype=mime)
    resp.headers["X-Wavrick-Vocal-Separated"] = "1" if separated else "0"
    resp.headers["X-Wavrick-Audio-Stem"] = "vocals" if separated else "mix"
    if target_lang:
        resp.headers["X-Wavrick-Target-Lang"] = target_lang
    if selected_format_id:
        resp.headers["X-Wavrick-Selected-Format"] = selected_format_id
    if audio_dur > 0:
        resp.headers["X-Wavrick-Audio-Duration-Sec"] = f"{audio_dur:.2f}"
    if video_dur > 0:
        resp.headers["X-Wavrick-Video-Duration-Sec"] = f"{video_dur:.2f}"
    return resp


@app.post("/video-meta")
def video_meta():
    secret = os.environ.get("PROXY_SECRET", "").strip()
    if secret:
        auth = request.headers.get("Authorization", "")
        if auth != f"Bearer {secret}":
            abort(401)

    allowed, retry_after = check_video_meta_limit()
    if not allowed:
        return (
            jsonify({"ok": False, "error": "リクエスト制限に達しました。しばらくして再試行してください。"}),
            429,
            {"Retry-After": str(retry_after)},
        )

    payload = request.get_json(silent=True) or {}
    url = (payload.get("videoUrl") or payload.get("url") or "").strip()
    if not url or not host_allowed(url):
        abort(400)

    clear_download_proxies()
    try:
        with yt_dlp.YoutubeDL(_base_ydl_opts(skip_download=True)) as ydl:
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
            "durationSec": max(0.0, float(info.get("duration") or 0)),
        }
    )


@app.get("/health")
def health():
    cookie_path = _resolve_yt_cookiefile()
    return jsonify(
        {
            "ok": True,
            "service": "youtube-audio-proxy",
            "vocalSeparationEnabled": _VOCAL_SEPARATION,
            "vocalSeparationReady": demucs_available(),
            "demucsModel": _DEMUCS_MODEL,
            "ffmpeg": find_ffmpeg(),
            "maxBytes": MAX_BYTES,
            "downloadMaxFilesizeOnFetch": False,
            "minDurationRatio": _MIN_DURATION_RATIO,
            "rateLimit": rate_limit_config(),
            "youtubeCookiesLoaded": bool(cookie_path),
            "remoteComponents": _remote_components(),
            "ytDlpVersion": yt_dlp.version.__version__,
            "nodePath": shutil.which("node"),
            "denoPath": shutil.which("deno"),
            "extractBuild": _EXTRACT_BUILD,
            "features": ["language_tracks", "probe-tracks", "vocal_separation"],
        }
    )


if __name__ == "__main__":
    clear_download_proxies()
    port = int(os.environ.get("PORT", "8080"))
    app.run(host="0.0.0.0", port=port)
