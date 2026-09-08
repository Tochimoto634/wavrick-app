"""
Strict YouTube audio-track language resolution.

Policy (ADR / targetLang extract):
- Accept a format_id ONLY when strong evidence (format_note [lang], language name,
  or googlevideo xtags lang=) uniquely identifies the target language.
- Never trust the bare yt-dlp `language` field alone (clients mis-tag default dubs).
- Never fall back to another language. If the target cannot be proven, callers must error.

Test mode may call resolve_target_tracks_weak_fallback() when strong proof is missing.
"""

from __future__ import annotations

import re
from typing import Any
from urllib.parse import parse_qs, urlparse

_LANG_NAME_TO_CODE: tuple[tuple[str, str], ...] = (
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
    ("hebrew", "iw"),
    ("bangla", "bn"),
    ("bengali", "bn"),
    ("dutch", "nl"),
    ("punjabi", "pa"),
    ("polish", "pl"),
    ("tamil", "ta"),
    ("telugu", "te"),
    ("ukrainian", "uk"),
    ("malayalam", "ml"),
)


def normalize_lang_code(raw: str | None) -> str:
    return (raw or "").strip().lower().split("-")[0].split("_")[0]


def _valid_lang_code(raw: str | None) -> str:
    code = normalize_lang_code(raw)
    if code and re.fullmatch(r"[a-z]{2,3}", code):
        return code
    return ""


def xtags_from_url(url: str | None) -> str:
    du = str(url or "").strip()
    if not du.startswith("http"):
        return ""
    try:
        q = parse_qs(urlparse(du).query)
        vals = q.get("xtags") or q.get("xtag") or []
        return str(vals[0] if vals else "").lower()
    except Exception:
        return ""


def xtags_lang(url_or_xtags: str | None) -> str:
    xt = str(url_or_xtags or "").lower()
    if "acont=" in xt or "lang=" in xt:
        pass
    elif xt.startswith("http"):
        xt = xtags_from_url(xt)
    if not xt:
        return ""
    for part in xt.replace("%3a", ":").replace("%3A", ":").split(":"):
        part = part.strip()
        if part.startswith("lang="):
            return _valid_lang_code(part.split("=", 1)[1])
    if "lang=" in xt:
        return _valid_lang_code(xt.split("lang=", 1)[1].split(":")[0])
    return ""


def strong_lang_signals(track: dict[str, Any]) -> set[str]:
    """
    Language codes backed by explicit human/CDN evidence.
    Does NOT include bare `language` field.
    """
    signals: set[str] = set()
    note = str(track.get("formatNote") or track.get("format_note") or "").lower()
    fmt_str = str(track.get("format") or track.get("formatStr") or "").lower()
    blob = f"{note} {fmt_str}"
    for m in re.finditer(r"\[([a-z]{2,3}(?:-[a-z0-9]+)?)\]", blob):
        code = _valid_lang_code(m.group(1))
        if code:
            signals.add(code)
    for name, code in _LANG_NAME_TO_CODE:
        if name in note or name in fmt_str:
            signals.add(code)
    xt_lang = xtags_lang(
        str(track.get("downloadUrl") or track.get("xtags") or "")
    ) or xtags_lang(str(track.get("xtags") or ""))
    if track.get("xtags"):
        xt_lang = xt_lang or xtags_lang(str(track.get("xtags")))
    if not xt_lang:
        xt_lang = xtags_lang(str(track.get("downloadUrl") or ""))
    if xt_lang:
        signals.add(xt_lang)
    signals.discard("")
    return signals


def weak_lang_signal(track: dict[str, Any]) -> str:
    """Bare yt-dlp language field (untrusted alone)."""
    return _valid_lang_code(str(track.get("language") or ""))


def format_id_strong_signals(tracks: list[dict[str, Any]], format_id: str) -> set[str]:
    fid = str(format_id or "").strip()
    out: set[str] = set()
    if not fid:
        return out
    for t in tracks:
        if str(t.get("formatId") or t.get("format_id") or "").strip() != fid:
            continue
        out |= strong_lang_signals(t)
    return out


def format_id_weak_signals(tracks: list[dict[str, Any]], format_id: str) -> set[str]:
    fid = str(format_id or "").strip()
    out: set[str] = set()
    if not fid:
        return out
    for t in tracks:
        if str(t.get("formatId") or t.get("format_id") or "").strip() != fid:
            continue
        w = weak_lang_signal(t)
        if w:
            out.add(w)
    return out


def format_id_is_exclusive_target(
    tracks: list[dict[str, Any]], format_id: str, target_lang: str
) -> bool:
    code = normalize_lang_code(target_lang)
    if not code:
        return False
    strong = format_id_strong_signals(tracks, format_id)
    if not strong:
        return False
    if strong != {code}:
        return False
    weak = format_id_weak_signals(tracks, format_id)
    if weak and any(w != code for w in weak):
        return False
    return True


def exclusive_target_format_ids(
    tracks: list[dict[str, Any]], target_lang: str
) -> list[str]:
    code = normalize_lang_code(target_lang)
    if not code:
        return []
    fids: list[str] = []
    seen: set[str] = set()
    for t in tracks:
        fid = str(t.get("formatId") or t.get("format_id") or "").strip()
        if not fid or fid in seen:
            continue
        if format_id_is_exclusive_target(tracks, fid, code):
            seen.add(fid)
            fids.append(fid)
    return fids


def pick_best_track_for_format(
    tracks: list[dict[str, Any]], format_id: str
) -> dict[str, Any] | None:
    fid = str(format_id or "").strip()
    group = [
        t
        for t in tracks
        if str(t.get("formatId") or t.get("format_id") or "").strip() == fid
    ]
    if not group:
        return None

    def score(t: dict[str, Any]) -> float:
        note = str(t.get("formatNote") or "").lower()
        xt = xtags_from_url(str(t.get("downloadUrl") or ""))
        s = 0.0
        if t.get("isAudioOnly"):
            s += 10.0
        if t.get("hasUrl"):
            s += 5.0
        if strong_lang_signals(t):
            s += 30.0
        if "dub" in note or "dubbed" in xt:
            s += 20.0
        if "original" in note or "acont=original" in xt:
            s -= 15.0
        s += float(t.get("abr") or 0) / 128.0
        return s

    return max(group, key=score)


def resolve_target_tracks(
    tracks: list[dict[str, Any]],
    target_lang: str,
    *,
    require_dubbed: bool = False,
) -> list[dict[str, Any]]:
    code = normalize_lang_code(target_lang)
    fids = exclusive_target_format_ids(tracks, code)
    resolved: list[dict[str, Any]] = []
    for fid in fids:
        t = pick_best_track_for_format(tracks, fid)
        if not t:
            continue
        if require_dubbed:
            note = str(t.get("formatNote") or "").lower()
            xt = xtags_from_url(str(t.get("downloadUrl") or ""))
            if "original" in note or "acont=original" in xt:
                continue
        resolved.append(t)

    if require_dubbed and not resolved:
        return []

    def score(t: dict[str, Any]) -> float:
        note = str(t.get("formatNote") or "").lower()
        xt = xtags_from_url(str(t.get("downloadUrl") or ""))
        s = 0.0
        if t.get("hasUrl"):
            s += 5.0
        if "dub" in note or "dubbed" in xt:
            s += 20.0
        if "original" in note or "acont=original" in xt:
            s -= 15.0
        s += float(t.get("abr") or 0) / 128.0
        return s

    resolved.sort(key=score, reverse=True)
    return resolved


def resolve_target_tracks_weak_fallback(
    tracks: list[dict[str, Any]],
    target_lang: str,
    *,
    require_dubbed: bool = False,
) -> list[dict[str, Any]]:
    """
    Test / last resort when yt-dlp omits note/[lang]/xtags but sets language=ja etc.
    Requires at least two audio-capable formats when require_dubbed (original + dub).
    """
    code = normalize_lang_code(target_lang)
    if not code:
        return []
    audio = [t for t in tracks if t.get("isAudioOnly") or t.get("hasUrl")]
    if require_dubbed and len(audio) < 2:
        return []

    candidates: list[dict[str, Any]] = []
    seen_fid: set[str] = set()
    for t in audio:
        if weak_lang_signal(t) != code:
            continue
        note = str(t.get("formatNote") or "").lower()
        xt = xtags_from_url(str(t.get("downloadUrl") or ""))
        if require_dubbed and ("original" in note or "acont=original" in xt):
            continue
        fid = str(t.get("formatId") or "").strip()
        if fid and fid in seen_fid:
            continue
        if fid:
            seen_fid.add(fid)
        candidates.append(t)

    def score(t: dict[str, Any]) -> float:
        note = str(t.get("formatNote") or "").lower()
        xt = xtags_from_url(str(t.get("downloadUrl") or ""))
        s = 0.0
        if t.get("hasUrl"):
            s += 5.0
        if "dub" in note or "dubbed" in xt:
            s += 25.0
        if "original" in note or "acont=original" in xt:
            s -= 20.0
        s += float(t.get("abr") or 0) / 128.0
        return s

    candidates.sort(key=score, reverse=True)
    return candidates


def probe_track_debug_lines(tracks: list[dict[str, Any]], limit: int = 10) -> list[str]:
    lines: list[str] = []
    for t in (tracks or [])[:limit]:
        fid = str(t.get("formatId") or "?")
        note = str(t.get("formatNote") or "")[:72]
        weak = weak_lang_signal(t) or "-"
        strong = ",".join(sorted(strong_lang_signals(t))) or "-"
        xt = xtags_lang(str(t.get("downloadUrl") or t.get("xtags") or "")) or "-"
        client = str(t.get("sourceClient") or "")
        lines.append(
            f"format={fid} weak={weak} strong={strong} xtags={xt} "
            f"note={note!r} cookies={t.get('sourceUseCookies')} client={client}"
        )
    return lines


def catalog_strong_langs(tracks: list[dict[str, Any]]) -> list[str]:
    langs: set[str] = set()
    for t in tracks:
        langs |= strong_lang_signals(t)
    return sorted(langs)


def assert_selected_format(
    tracks: list[dict[str, Any]],
    selected_format_id: str | None,
    target_lang: str,
) -> str:
    code = normalize_lang_code(target_lang)
    fid = str(selected_format_id or "").strip()
    if not fid or fid.startswith("ba[") or "/" in fid or fid == "140":
        raise ValueError(
            f"selected format is not a locked language format id: {fid!r}"
        )
    if not format_id_is_exclusive_target(tracks, fid, code):
        strong = sorted(format_id_strong_signals(tracks, fid))
        weak = sorted(format_id_weak_signals(tracks, fid))
        raise ValueError(
            f"format {fid} is not exclusively {code} "
            f"(strong={strong or '-'}, weak={weak or '-'})"
        )
    return fid
