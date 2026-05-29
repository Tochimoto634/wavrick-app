"""ローカル開発用 media-pipeline（トンネル不要）。WhisperX + Grok。"""
from __future__ import annotations

import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

MAX_WHISPER_BYTES = 24 * 1024 * 1024
GROK_MODEL = os.environ.get("GROK_MODEL", "grok-4.3")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SECRETS_ENV_PATH = os.path.join(ROOT, ".local", "secrets.env")
AUDIO_PROXY = os.environ.get("WAVRICK_AUDIO_PROXY", "http://127.0.0.1:5055")
WHISPERX_URL = os.environ.get("WHISPERX_SERVICE_URL", "http://127.0.0.1:8081").rstrip("/")
WAVRICK_TRANSCRIBE_BUILD = 8


def transcribe_build_marker() -> str:
    return f"[Wavrick-{WAVRICK_TRANSCRIBE_BUILD}]"


def append_transcribe_build_marker(text: str) -> str:
    marker = transcribe_build_marker()
    t = (text or "").strip()
    if not t:
        return marker
    if marker in t:
        return t
    return f"{t}\n{marker}"


def _parse_secrets_file() -> dict[str, str]:
    out: dict[str, str] = {}
    if not os.path.isfile(SECRETS_ENV_PATH):
        return out
    with open(SECRETS_ENV_PATH, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            val = v.strip().strip('"').strip("'")
            if val:
                out[k.strip()] = val
    return out


def is_placeholder_api_key(key: str, kind: str) -> bool:
    k = (key or "").strip()
    if not k or "..." in k:
        return True
    placeholders = {
        "openai": {"sk-...", "sk-proj-..."},
        "xai": {"xai-..."},
    }
    if k.lower() in placeholders.get(kind, set()):
        return True
    if kind == "openai":
        return not k.startswith("sk-") or len(k) < 40
    if kind == "xai":
        return not k.startswith("xai-") or len(k) < 20
    return False


def load_dev_api_keys() -> dict[str, str]:
    out = _parse_secrets_file()
    for key in (
        "OPENAI_API_KEY",
        "XAI_API_KEY",
        "PROXY_SECRET",
        "YOUTUBE_AUDIO_PROXY_SECRET",
        "WHISPERX_SERVICE_URL",
        "WHISPERX_SERVICE_SECRET",
    ):
        if not out.get(key) and os.environ.get(key):
            out[key] = os.environ[key]
    if not out.get("PROXY_SECRET") and out.get("YOUTUBE_AUDIO_PROXY_SECRET"):
        out["PROXY_SECRET"] = out["YOUTUBE_AUDIO_PROXY_SECRET"]
    return out


def validate_openai_key_or_raise(keys: dict[str, str]) -> str:
    api_key = keys.get("OPENAI_API_KEY", "")
    if not api_key:
        raise RuntimeError(
            "OPENAI_API_KEY がありません。.local/secrets.env を作成し、"
            "scripts/secrets.env.example の sk-... を本物のキーに置き換えてください。"
        )
    if is_placeholder_api_key(api_key, "openai"):
        raise RuntimeError(
            "OPENAI_API_KEY がサンプルのままです（sk-...）。"
            " https://platform.openai.com/api-keys で新しいキーを作成し、"
            ".local/secrets.env の OPENAI_API_KEY= の右に貼り付けて保存してください。"
        )
    return api_key


def apply_local_secrets() -> None:
    """`.local/secrets.env` を os.environ に反映（既存の環境変数は上書きしない）"""
    for k, v in load_dev_api_keys().items():
        if v and not os.environ.get(k):
            os.environ[k] = v


def get_proxy_secret() -> str:
    keys = load_dev_api_keys()
    return (
        keys.get("PROXY_SECRET")
        or keys.get("YOUTUBE_AUDIO_PROXY_SECRET")
        or os.environ.get("PROXY_SECRET")
        or "wavrick-local-dev-secret"
    )


def format_http_error(e: urllib.error.HTTPError, *, context: str) -> str:
    host = ""
    try:
        host = (e.url or "").lower()
    except Exception:
        pass
    if e.code == 401:
        if "openai.com" in host:
            return (
                "OpenAI API キーが無効です（401）。.local/secrets.env の OPENAI_API_KEY を確認し、"
                "sk- で始まる有効なキーか、請求・権限が有効かを OpenAI ダッシュボードで確認してください。"
            )
        if "x.ai" in host:
            return (
                "xAI API キーが無効です（401）。.local/secrets.env の XAI_API_KEY を確認してください。"
            )
        if context == "proxy":
            return (
                "音声プロキシ (5055) の認証に失敗しました（401）。"
                " プロキシを ./scripts/start-audio-proxy.sh で再起動するか、"
                ".local/secrets.env の PROXY_SECRET を wavrick-local-dev-secret に合わせてください。"
            )
    if context == "proxy" and e.code == 502:
        try:
            body = e.read().decode("utf-8", errors="replace")[:800]
            if body:
                try:
                    parsed = json.loads(body)
                    err_msg = parsed.get("error") if isinstance(parsed, dict) else None
                    if err_msg:
                        return str(err_msg)
                except json.JSONDecodeError:
                    pass
                if "YouTube" in body or "403" in body or "yt-dlp" in body.lower():
                    return body[:500]
        except Exception:
            pass
        return (
            "YouTube から音声を取得できませんでした（プロキシ 502）。"
            " ターミナルで ./scripts/ensure-audio-proxy.sh を実行してプロキシを再起動し、"
            " まだ失敗する場合は「音声ファイル」モードでアップロードしてください。"
        )
    return f"{context}: HTTP {e.code} {e.reason or 'Error'}"


apply_local_secrets()


def extract_youtube_video_id(raw: str) -> str | None:
    raw = (raw or "").strip()
    if not raw:
        return None
    if not raw.startswith("http"):
        raw = f"https://{raw}"
    try:
        from urllib.parse import parse_qs, urlparse

        u = urlparse(raw)
        host = (u.hostname or "").replace("www.", "").lower()
        if host == "youtu.be":
            vid = u.path.lstrip("/").split("/")[0]
            return vid if re.fullmatch(r"[\w-]{11}", vid) else None
        if host in ("youtube.com", "m.youtube.com", "music.youtube.com", "youtube-nocookie.com"):
            if u.path == "/watch":
                v = (parse_qs(u.query).get("v") or [""])[0]
                return v if re.fullmatch(r"[\w-]{11}", v) else None
            for pat in (r"^/shorts/([\w-]{11})", r"^/embed/([\w-]{11})", r"^/live/([\w-]{11})"):
                m = re.match(pat, u.path)
                if m:
                    return m.group(1)
    except Exception:
        return None
    return None


def fetch_audio_from_http_url(audio_url: str) -> bytes:
    parsed = urllib.parse.urlparse(audio_url)
    host = (parsed.hostname or "").lower()
    if parsed.scheme not in ("http", "https"):
        raise RuntimeError("audioUrl は http(s) である必要があります。")
    if host not in ("127.0.0.1", "localhost") and parsed.scheme != "https":
        raise RuntimeError("ローカル開発以外の http audioUrl は許可されていません。")
    req = urllib.request.Request(audio_url, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=600) as resp:
            body = resp.read()
    except urllib.error.HTTPError as e:
        raise RuntimeError(format_http_error(e, context="audioUrl")) from e
    except urllib.error.URLError as e:
        raise RuntimeError(f"audioUrl の取得に失敗しました: {e}") from e
    if len(body) > MAX_WHISPER_BYTES:
        raise RuntimeError(f"音声が大きすぎます（{len(body)} bytes）。")
    if len(body) < 256:
        raise RuntimeError("音声データが短すぎるか空です。")
    return body


def fetch_audio_from_local_proxy(video_url: str) -> bytes:
    secret = get_proxy_secret()
    payload = json.dumps({"videoUrl": video_url}).encode("utf-8")
    req = urllib.request.Request(
        f"{AUDIO_PROXY.rstrip('/')}/extract",
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {secret}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=600) as resp:
            body = resp.read()
    except urllib.error.HTTPError as e:
        raise RuntimeError(format_http_error(e, context="proxy")) from e
    except urllib.error.URLError as e:
        raise RuntimeError(
            "Mac の音声プロキシ (5055) に接続できません。"
            " 別ターミナルで ./scripts/start-audio-proxy.sh を実行してください（トンネルは不要）。"
        ) from e
    if len(body) > MAX_WHISPER_BYTES:
        raise RuntimeError(f"音声が大きすぎます（{len(body)} bytes）。")
    if len(body) < 256:
        raise RuntimeError("音声データが短すぎるか空です。")
    return body


def get_whisperx_secret(keys: dict[str, str]) -> str:
    return (
        keys.get("WHISPERX_SERVICE_SECRET")
        or keys.get("PROXY_SECRET")
        or os.environ.get("WHISPERX_SERVICE_SECRET")
        or os.environ.get("PROXY_SECRET")
        or "wavrick-local-dev-secret"
    )


def transcribe_whisperx(audio: bytes, filename: str, keys: dict[str, str]) -> dict[str, Any]:
    from whisperx_timeline import (
        build_bracket_timeline_from_whisperx,
        build_timeline_cues_from_whisperx,
        timeline_cues_to_legacy_segments,
    )

    base = (
        keys.get("WHISPERX_SERVICE_URL")
        or os.environ.get("WHISPERX_SERVICE_URL")
        or WHISPERX_URL
    ).rstrip("/")
    secret = get_whisperx_secret(keys)
    boundary = f"wavrick-{int(time.time() * 1000)}"
    parts: list[bytes] = [
        f"--{boundary}\r\n".encode()
        + f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'.encode()
        + b"Content-Type: application/octet-stream\r\n\r\n",
        audio,
        b"\r\n",
        f"--{boundary}--\r\n".encode(),
    ]
    body = b"".join(parts)
    headers = {
        "Content-Type": f"multipart/form-data; boundary={boundary}",
    }
    if secret:
        headers["Authorization"] = f"Bearer {secret}"

    req = urllib.request.Request(
        f"{base}/transcribe",
        data=body,
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=3600) as resp:
            wx = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")[:500]
        raise RuntimeError(
            f"WhisperX ({base}) が失敗しました ({e.code}): {detail}. "
            "./scripts/start-whisperx.sh が動いているか確認してください。"
        ) from e
    except urllib.error.URLError as e:
        raise RuntimeError(
            f"WhisperX ({base}) に接続できません: {e}. ./scripts/start-whisperx.sh を起動してください。"
        ) from e

    words = wx.get("words") if isinstance(wx, dict) else []
    duration = float(wx.get("duration") or 0) if isinstance(wx, dict) else 0.0
    wx_segments = wx.get("segments") if isinstance(wx, dict) else []
    if not isinstance(wx_segments, list):
        wx_segments = []
    silence_gaps = wx.get("silenceGaps") if isinstance(wx, dict) else []
    if not isinstance(silence_gaps, list):
        silence_gaps = []
    rough_segments = wx.get("roughSegments") if isinstance(wx, dict) else []
    if not isinstance(rough_segments, list):
        rough_segments = []
    cues = build_timeline_cues_from_whisperx(
        words, wx_segments, duration, silence_gaps, rough_segments
    )
    segments = timeline_cues_to_legacy_segments(cues)
    timeline = build_bracket_timeline_from_whisperx(
        words, wx_segments, duration, silence_gaps, rough_segments
    )
    text = " ".join(s.get("text", "") for s in segments).strip()
    if not text and isinstance(wx, dict):
        segs = wx.get("segments") or []
        if isinstance(segs, list):
            text = " ".join(
                str(s.get("text") or "").strip()
                for s in segs
                if isinstance(s, dict) and str(s.get("text") or "").strip()
            ).strip()
    if not text:
        raise RuntimeError("WhisperX の結果が空でした。")
    if duration <= 0 and segments:
        duration = max(float(s["end"]) for s in segments)

    raw: dict[str, Any] = {
        "source": "whisperx",
        "model": wx.get("model") if isinstance(wx, dict) else None,
        "language": wx.get("language") if isinstance(wx, dict) else None,
        "duration": duration,
        "text": text,
        "words": words,
        "segments": wx.get("segments") if isinstance(wx, dict) else [],
        "timelineSegments": segments,
        "whisperTimeline": timeline,
    }
    wx_build = wx.get("build") if isinstance(wx, dict) else None
    return {
        "text": text,
        "raw": raw,
        "timeline": timeline,
        "segments": segments,
        "whisperx_build": wx_build,
        "silence_gap_count": len(silence_gaps),
        "rough_segment_count": len(rough_segments),
    }


GROK_TRANSLATE_LINES_SYSTEM = """あなたはプロの吹替台本ライターです。
入力は WhisperX で確定したタイムコード付き書き起こしです。
【厳守】
- 出力にタイムコード [mm:ss.xx] を一切含めない
- 入力の行数と順序を変えない（統合・分割・入れ替え禁止）
- 各行のセリフ本文だけを自然な日本語吹替にする
- 意味不明な行は空文字 "" にする"""

BRACKET_LINE_RE = re.compile(
    r"^\[(\d{1,2}):(\d{2})\.(\d{2})\s*-\s*(\d{1,2}):(\d{2})\.(\d{2})\]\s*(.*)$"
)
BRACKET_LINE_RE_FLEX = re.compile(
    r"^\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\s*(?:-\s*(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?)?\]\s*(.*)$"
)


def strip_whisper_timeline_marker(raw: str) -> str:
    return re.sub(r"\n?\[Wavrick-\d+\]\s*$", "", (raw or "").strip(), flags=re.I).strip()


def _parse_bracket_part(min_s: str, sec: str, frac: str | None) -> float:
    s = float(sec or 0)
    f = float(frac) if frac not in (None, "") else 0.0
    digits = len(str(frac or ""))
    if digits <= 2:
        sub = f / 100
    elif digits == 3:
        sub = f / 1000
    elif digits > 0:
        sub = f / (10**digits)
    else:
        sub = 0.0
    return float(min_s or 0) * 60 + s + sub


def parse_bracket_timeline_text(raw: str) -> list[dict[str, Any]]:
    t = strip_whisper_timeline_marker(raw)
    rows: list[dict[str, Any]] = []
    for line in t.splitlines():
        trimmed = line.strip()
        if not trimmed or trimmed == "[NEW_BLOCK]":
            continue
        m = BRACKET_LINE_RE.match(trimmed)
        if m:
            start_sec = _parse_bracket_part(m.group(1), m.group(2), m.group(3))
            end_sec = _parse_bracket_part(m.group(4), m.group(5), m.group(6))
            text = (m.group(7) or "").strip()
        else:
            m = BRACKET_LINE_RE_FLEX.match(trimmed)
            if not m:
                continue
            start_sec = _parse_bracket_part(m.group(1), m.group(2), m.group(3))
            if m.group(4) is not None:
                end_sec = _parse_bracket_part(m.group(4), m.group(5), m.group(6))
            else:
                end_sec = start_sec + 0.35
            text = (m.group(7) or "").strip()
        if not (end_sec > start_sec):
            end_sec = start_sec + 0.35
        if not text:
            continue
        rows.append({"startSec": start_sec, "endSec": end_sec, "text": text})
    return rows


def format_bracket_timeline_row(row: dict[str, Any]) -> str:
    from whisperx_timeline import format_bracket_timecode

    start = float(row["startSec"])
    end = float(row["endSec"])
    if not (end > start):
        end = start + 0.35
    return (
        f"[{format_bracket_timecode(start)} - {format_bracket_timecode(end)}] "
        f"{row['text']}"
    )


def merge_translations_into_whisper_timeline(
    whisper_timeline: str, translations: list[str]
) -> str:
    canon = parse_bracket_timeline_text(whisper_timeline)
    if not canon:
        return strip_whisper_timeline_marker(whisper_timeline)
    out = []
    for i, row in enumerate(canon):
        t = str(translations[i] if i < len(translations) else "").strip()
        out.append({**row, "text": t or row["text"]})
    return "\n".join(format_bracket_timeline_row(r) for r in out)


def normalize_whisper_segs_for_grok(raw: Any) -> list[dict[str, float | str]]:
    if not isinstance(raw, list):
        return []
    out: list[dict[str, float | str]] = []
    for row in raw:
        if not isinstance(row, dict):
            continue
        text = str(row.get("text") or "").strip()
        if not text:
            continue
        start = max(0.0, float(row.get("start") or 0))
        end = max(0.0, float(row.get("end") or 0))
        if not (end > start):
            end = start + 0.35
        out.append({"start": start, "end": end, "text": text})
    out.sort(key=lambda s: (float(s["start"]), float(s["end"])))
    return out


def segments_to_bracket_timeline(segments: list[dict], duration_sec: float = 0.0) -> str:
    from whisperx_timeline import format_bracket_timecode

    lines: list[str] = []
    for s in segments:
        text = str(s.get("text") or "").strip()
        if not text:
            continue
        start = float(s.get("start") or 0)
        end = float(s.get("end") or 0)
        if not (end > start):
            end = start + 0.35
        lines.append(
            f"[{format_bracket_timecode(start)} - {format_bracket_timecode(end)}] {text}"
        )
    return "\n".join(lines).strip()


def speaker_assignments_to_plain_text(speakers: list[dict]) -> str:
    parts = ["【話者と元セリフの割当】"]
    for s in speakers:
        sid = s["id"]
        label = s.get("label") or f"話者{sid}"
        parts.append("")
        parts.append(f"話者{sid}（{label}）:")
        for line in s.get("lines") or []:
            t = str(line or "").strip()
            if t:
                parts.append(f"- {t}")
    return "\n".join(parts).strip()


def _normalize_for_match(t: str) -> str:
    return re.sub(r"[\s、。，,.!?！？「」『』\"']", "", t or "").lower()


def build_scripts_by_speaker_from_whisper_timeline(
    whisper_timeline: str,
    speakers: list[dict],
    translated_lines: list[str] | None = None,
) -> dict[str, str]:
    canon = parse_bracket_timeline_text(whisper_timeline)
    out: dict[str, str] = {}
    if not canon:
        return out
    translations = (
        [str(x or "").strip() for x in translated_lines]
        if isinstance(translated_lines, list) and len(translated_lines) == len(canon)
        else [str(row.get("text") or "") for row in canon]
    )
    for s in speakers:
        key = str(s["id"])
        blob = _normalize_for_match("".join(str(x) for x in (s.get("lines") or [])))
        rows: list[dict[str, Any]] = []
        for i, row in enumerate(canon):
            ct = _normalize_for_match(str(row.get("text") or ""))
            if not ct:
                continue
            matched = (
                blob.find(ct) >= 0
                or ct.find(blob[: min(48, len(blob))]) >= 0
                or (len(ct) >= 8 and blob.find(ct[:24]) >= 0)
            )
            if not matched:
                continue
            dub = translations[i].strip() if i < len(translations) else ""
            rows.append({**row, "text": dub or row.get("text") or ""})
        out[key] = (
            "\n".join(format_bracket_timeline_row(r) for r in rows) if rows else ""
        )
    return out


def translate_whisper_timeline_with_grok(
    whisper_timeline: str, api_key: str, extra_hint: str = ""
) -> dict[str, Any]:
    user_text = "\n".join(
        x
        for x in [
            "【WhisperX タイムコード付き書き起こし（行数・順序厳守）】",
            "各行のセリフを日本語吹替にしてください。タイムコードは出力しないでください。",
            "",
            whisper_timeline,
            extra_hint,
        ]
        if x is not None
    )
    system = "\n".join(
        [
            GROK_TRANSLATE_LINES_SYSTEM,
            "",
            "次の JSON のみを返してください:",
            '{"translation":"参考訳（短くてよい）","lines":["1行目の吹替のみ","2行目…"]}',
            "応答は有効な JSON のみ（説明文・コードフェンス禁止）。",
            "lines は入力と同じ行数の配列。各要素は吹替セリフ本文のみ（タイムコード [ ] を含めない）。",
            "行の追加・削除・順序変更は禁止。",
        ]
    )
    content = grok_chat(api_key, system, user_text)
    cleaned = re.sub(r"^```json\s*", "", content, flags=re.I)
    cleaned = re.sub(r"```\s*$", "", cleaned).strip()
    parsed = json.loads(cleaned)
    lines = parsed.get("lines")
    if not isinstance(lines, list):
        lines = []
    lines = [str(x or "").strip() for x in lines]
    script = merge_translations_into_whisper_timeline(whisper_timeline, lines)
    translation = (
        parsed.get("translation") if isinstance(parsed.get("translation"), str) else ""
    )
    return {"translation": translation, "lines": lines, "script": script}


def grok_chat(api_key: str, system: str, user: str) -> str:
    payload = json.dumps(
        {
            "model": GROK_MODEL,
            "temperature": 0.35,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        "https://api.x.ai/v1/chat/completions",
        data=payload,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            raw = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise RuntimeError(format_http_error(e, context="xai")) from e
    content = raw.get("choices", [{}])[0].get("message", {}).get("content")
    if not isinstance(content, str):
        raise RuntimeError("Grok の応答形式が不正です。")
    return content


def script_by_speakers(
    speakers: list[dict],
    tone: str,
    api_key: str,
    whisper_segments: list[dict],
    whisper_timeline: str = "",
    duration_sec: float = 0.0,
) -> dict[str, Any]:
    if not whisper_segments:
        raise RuntimeError("whisperSegments が空です。")
    timeline = strip_whisper_timeline_marker(whisper_timeline)
    if not timeline:
        timeline = segments_to_bracket_timeline(whisper_segments, duration_sec)
    if not timeline:
        raise RuntimeError("Whisper タイムラインがありません。")

    tone_hint = tone.strip()
    speaker_plain = speaker_assignments_to_plain_text(speakers)
    extra = "\n".join(x for x in [speaker_plain, f"希望トーン: {tone_hint}" if tone_hint else ""] if x)

    result = translate_whisper_timeline_with_grok(timeline, api_key, extra)
    merged_script = str(result.get("script") or "").strip()
    if not merged_script:
        raise RuntimeError("吹替台本の組み立てに失敗しました。")

    scripts_by_speaker = build_scripts_by_speaker_from_whisper_timeline(
        timeline, speakers, result.get("lines")
    )
    if len(speakers) == 1:
        key = str(speakers[0]["id"])
        if not str(scripts_by_speaker.get(key) or "").strip():
            scripts_by_speaker = {key: merged_script}

    if not any(str(scripts_by_speaker.get(k) or "").strip() for k in scripts_by_speaker):
        raise RuntimeError("話者別台本の組み立てに失敗しました。")

    return {
        "scriptsBySpeaker": scripts_by_speaker,
        "referenceTranslation": result.get("translation") or "",
        "whisperTimeline": timeline,
    }


def normalize_speakers(body: dict) -> list[dict]:
    raw = body.get("speakers")
    if not isinstance(raw, list):
        return []
    out = []
    for s in raw:
        if not isinstance(s, dict):
            continue
        sid = s.get("id")
        try:
            sid = int(sid)
        except (TypeError, ValueError):
            continue
        if sid < 1:
            continue
        lines = s.get("lines")
        if not isinstance(lines, list):
            continue
        lines = [str(x).strip() for x in lines if str(x).strip()]
        if not lines:
            continue
        label = str(s.get("label") or "").strip() or f"話者{sid}"
        out.append({"id": sid, "label": label, "lines": lines})
    out.sort(key=lambda x: x["id"])
    return out


def handle_media_pipeline(body: dict) -> tuple[dict, int]:
    apply_local_secrets()
    started = time.time()
    keys = load_dev_api_keys()
    mode = body.get("mode") or "full"
    if mode not in ("transcribe", "script", "full"):
        mode = "full"

    if mode == "script":
        xai = keys.get("XAI_API_KEY", "")
        if not xai:
            return {
                "ok": False,
                "error": "XAI_API_KEY がありません。.local/secrets.env に設定するか環境変数を export してください。",
            }, 500
        speakers = normalize_speakers(body)
        if not speakers:
            return {"ok": False, "error": "speakers に、話者 id と lines（1行以上）が必要です。"}, 400
        whisper_segments = normalize_whisper_segs_for_grok(body.get("whisperSegments"))
        if not whisper_segments:
            return {
                "ok": False,
                "error": "whisperSegments が必要です。先に文字起こし（WhisperX）を実行してください。",
            }, 400
        try:
            duration_sec = 0.0
            try:
                duration_sec = float(body.get("whisperDurationSec") or 0)
            except (TypeError, ValueError):
                duration_sec = 0.0
            if duration_sec <= 0 and whisper_segments:
                duration_sec = max(float(s["end"]) for s in whisper_segments)
            whisper_timeline = str(body.get("whisperTimeline") or "").strip()
            grok = script_by_speakers(
                speakers,
                str(body.get("tone") or ""),
                xai,
                whisper_segments,
                whisper_timeline,
                duration_sec,
            )
            combined = "\n\n".join(
                f"【{s['label']}】\n{grok['scriptsBySpeaker'].get(str(s['id']), grok['scriptsBySpeaker'].get(s['id'], ''))}".strip()
                for s in speakers
            )
            return {
                "ok": True,
                "mode": "script",
                "scriptsBySpeaker": grok["scriptsBySpeaker"],
                "referenceTranslation": grok["referenceTranslation"],
                "script": combined,
                "whisperTimeline": grok.get("whisperTimeline") or whisper_timeline,
                "timecodedByWhisper": True,
                "durationMs": int((time.time() - started) * 1000),
            }, 200
        except Exception as e:
            return {"ok": False, "error": str(e)}, 422

    video_url = str(body.get("videoUrl") or "").strip()
    audio_url = str(body.get("audioUrl") or "").strip()
    if not video_url and not audio_url:
        return {"ok": False, "error": "videoUrl または audioUrl が必要です。"}, 400
    if video_url and not extract_youtube_video_id(video_url):
        return {"ok": False, "error": "YouTube の動画URLとして解釈できませんでした。"}, 400

    try:
        if audio_url:
            audio = fetch_audio_from_http_url(audio_url)
            filename = "upload.wav"
        else:
            audio = fetch_audio_from_local_proxy(video_url)
            filename = "audio.m4a"
        whisper = transcribe_whisperx(audio, filename, keys)
        raw = whisper["raw"]
        lang = raw.get("language") if isinstance(raw, dict) else None
        if not isinstance(lang, str):
            lang = None
        duration_ms = int((time.time() - started) * 1000)
        if mode == "transcribe":
            segments = list(whisper.get("segments") or [])
            if not segments and isinstance(raw, dict) and isinstance(raw.get("timelineSegments"), list):
                segments = raw["timelineSegments"]
            audio_duration = 0.0
            if isinstance(raw, dict):
                try:
                    audio_duration = float(raw.get("duration") or 0)
                except (TypeError, ValueError):
                    audio_duration = 0.0
            seg_max = max((s["end"] for s in segments), default=0.0)
            if audio_duration <= 0:
                audio_duration = seg_max
            if audio_duration > 0:
                segments = [
                    {
                        "start": min(float(s["start"]), max(audio_duration - 0.05, 0)),
                        "end": min(
                            max(float(s["end"]), float(s["start"]) + 0.05),
                            audio_duration,
                        ),
                        "text": s["text"],
                    }
                    for s in segments
                    if float(s["start"]) < audio_duration - 0.02
                ]
            timeline_plain = whisper.get("timeline") or (
                raw.get("whisperTimeline") if isinstance(raw, dict) else ""
            ) or ""
            return {
                "ok": True,
                "mode": "transcribe",
                "whisperTranscript": append_transcribe_build_marker(whisper["text"]),
                "whisperLanguage": lang,
                "whisperSegments": segments,
                "whisperDurationSec": audio_duration,
                "whisperTimeline": append_transcribe_build_marker(timeline_plain),
                "whisperSource": "whisperx",
                "transcribeBuild": WAVRICK_TRANSCRIBE_BUILD,
                "whisperxBuild": whisper.get("whisperx_build"),
                "silenceGapCount": whisper.get("silence_gap_count", 0),
                "roughSegmentCount": whisper.get("rough_segment_count", 0),
                "timelineLineCount": len(segments),
                "audioDurationSec": audio_duration,
                "durationMs": duration_ms,
            }, 200
        xai = keys.get("XAI_API_KEY", "")
        if not xai:
            return {"ok": False, "error": "full モードには XAI_API_KEY も必要です。"}, 500
        # full mode (unused by current UI but kept for parity)
        system = (
            "あなたはプロの映像翻訳・吹替台本ライターです。"
            '次のJSONだけを返してください: {"translation":"…","script":"…"}'
        )
        content = grok_chat(xai, system, whisper["text"])
        cleaned = re.sub(r"^```json\s*", "", content, flags=re.I)
        cleaned = re.sub(r"```\s*$", "", cleaned).strip()
        parsed = json.loads(cleaned)
        return {
            "ok": True,
            "mode": "full",
            "whisperTranscript": whisper["text"],
            "translation": parsed.get("translation", ""),
            "script": parsed.get("script", ""),
            "durationMs": duration_ms,
        }, 200
    except Exception as e:
        return {"ok": False, "error": str(e)}, 422
