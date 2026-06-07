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

# 返却する音声の上限（Whisper 投入用 MP3 想定）。192kbps なら約 40 分弱まで。
MAX_BYTES = int(os.environ.get("WAVRICK_MAX_AUDIO_BYTES", str(48 * 1024 * 1024)))

# 高ビットレート単体ストリームは途中で切れることがあるため abr 上限付きで「動画全长」を優先
_AUDIO_FORMAT = (
    "bestaudio[ext=m4a][acodec^=mp4a][abr<=192]/"
    "bestaudio[abr<=192]/"
    "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best"
)
_AUDIO_FORMAT_FALLBACK = "bestaudio[abr<=128]/bestaudio"
_AUDIO_FORMAT_LAST_RESORT = "bestaudio/best"
_AUDIO_FORMAT_ANY = "ba/b/w"
_AUDIO_FORMAT_MUX = "b/w"
_AUDIO_FORMAT_BEST = "best"
# health の extractBuild と揃える（Railway で新コードが載ったか確認用）
_EXTRACT_BUILD = 2
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
    """ファイルパス / 環境変数テキスト / Base64 から yt-dlp 用 cookies.txt を用意。"""
    global _COOKIE_CACHE_PATH

    path = os.environ.get("WAVRICK_YT_COOKIES", "").strip()
    if path and os.path.isfile(path):
        return path
    if _COOKIE_CACHE_PATH and os.path.isfile(_COOKIE_CACHE_PATH):
        return _COOKIE_CACHE_PATH

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
            "YouTube がボット判定しています（Railway の IP がブロックされています）。"
            " 対処: ①依頼フォームで音声ファイルを直接アップロード ② Railway に YouTube ログイン済み cookies を設定"
            "（WAVRICK_YT_COOKIES_B64・YouTube 用に絞り込み済み）。./scripts/export-youtube-cookies-for-railway.sh を参照。"
        )
    if "403" in detail or "Forbidden" in detail:
        return (
            "YouTube から音声を取得できませんでした（403）。"
            " しばらくして再試行するか、音声ファイルを直接アップロードしてください。"
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
    """Railway + Cookie では tv DRM / SABR で bestaudio が空になることがある。"""
    raw = os.environ.get("WAVRICK_YT_PLAYER_CLIENT", "").strip()
    primary = _normalize_player_clients(
        [c.strip() for c in raw.split(",") if c.strip()],
        use_cookies=use_cookies,
    )
    if use_cookies and _resolve_yt_cookiefile():
        defaults: list[list[str]] = [
            ["web", "tv", "tv_embedded"],
            ["tv", "tv_embedded", "web"],
            ["web"],
            ["mweb", "web"],
            ["ios", "web"],
        ]
    else:
        defaults = [
            ["android", "web"],
            ["tv", "tv_embedded", "android", "web"],
            ["web"],
            ["ios", "web"],
            ["mweb", "web"],
        ]
    if primary:
        return [primary] + [d for d in defaults if d != primary]
    return defaults


def _youtube_extractor_args(player_clients: list[str] | None = None) -> dict:
    clients = player_clients or _player_client_attempts(use_cookies=True)[0]
    return {
        "youtube": {
            "player_client": clients,
            "player_skip": ["webpage"],
            "player_js_version": ["actual"],
        }
    }


def _base_ydl_opts(*, use_cookies: bool = True, player_clients: list[str] | None = None, **extra) -> dict:
    opts: dict = {
        "quiet": True,
        "noplaylist": True,
        "proxy": _yt_proxy(),
        "force_ipv4": True,
        "extractor_args": _youtube_extractor_args(player_clients),
    }
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
                "preferredquality": "192",
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

    vocal_requested = payload.get("vocalSeparate", payload.get("vocalOnly", True))
    if isinstance(vocal_requested, str):
        vocal_requested = vocal_requested.strip().lower() not in ("0", "false", "no", "off")
    else:
        vocal_requested = bool(vocal_requested)

    out_dir = tempfile.mkdtemp(prefix="wavrick_yt_")
    separated = False
    audio_dur = 0.0
    video_dur = 0.0
    try:
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
                }
            )

        data, mime = read_audio_file(path)
    except Exception as exc:
        logger.exception("extract failed for %s", url)
        shutil.rmtree(out_dir, ignore_errors=True)
        detail = _friendly_yt_extract_error(str(exc).strip() or exc.__class__.__name__)
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
        }
    )


if __name__ == "__main__":
    clear_download_proxies()
    port = int(os.environ.get("PORT", "8080"))
    app.run(host="0.0.0.0", port=port)
