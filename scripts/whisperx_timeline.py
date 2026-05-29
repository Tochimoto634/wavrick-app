"""WhisperX words → 2s/10s timeline (two-pass; sync with whisperx-timeline-rules.ts)."""
from __future__ import annotations

import re
from typing import Any

SILENCE_GAP_LINE_MIN_SEC = 2.0
SILENCE_GAP_BLOCK_MIN_SEC = 10.0
SILENCE_END_LOCK_SEC = 2.0
INVALID_SEGMENT_END_FALLBACK_SEC = 0.35
NEW_BLOCK_MARKER = "[NEW_BLOCK]"

def _has_cjk_char(s: str) -> bool:
    return any((0x3040 <= ord(ch) <= 0x30FF) or (0x3400 <= ord(ch) <= 0x9FFF) for ch in s)

def _join_word_texts(parts: list[str]) -> str:
    rows = [str(x or "").strip() for x in parts if str(x or "").strip()]
    if not rows:
        return ""
    mostly_single = sum(1 for r in rows if len(r) <= 1) / len(rows) > 0.7
    cjk_heavy = sum(1 for r in rows if _has_cjk_char(r)) / len(rows) > 0.5
    if mostly_single and cjk_heavy:
        return "".join(rows).strip()
    return " ".join(rows).strip()


def format_bracket_timecode(seconds: float) -> str:
    s = max(0.0, float(seconds) or 0.0)
    m = int(s // 60)
    sec = s - m * 60
    whole = int(sec)
    cs = round((sec - whole) * 100)
    return f"{m:02d}:{whole:02d}.{cs:02d}"


def _safe_end(start: float, end: float) -> float:
    start = max(0.0, float(start) or 0.0)
    end = max(0.0, float(end) or 0.0)
    if not end > start:
        end = start + INVALID_SEGMENT_END_FALLBACK_SEC
    return end


def normalize_align_words(raw: Any) -> list[dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    out: list[dict[str, Any]] = []
    for row in raw:
        if not isinstance(row, dict):
            continue
        word = str(row.get("word") or "").strip()
        if not word:
            continue
        start = max(0.0, float(row.get("start") or 0))
        end = max(0.0, float(row.get("end") or 0))
        if not end > start:
            end = start + INVALID_SEGMENT_END_FALLBACK_SEC
        out.append({"word": word, "start": start, "end": end})
    out.sort(key=lambda x: (x["start"], x["end"]))
    return out


def _normalize_segments(segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for row in segments or []:
        if not isinstance(row, dict):
            continue
        text = str(row.get("text") or "").strip()
        if not text:
            continue
        start = max(0.0, float(row.get("start") or 0))
        end = max(0.0, float(row.get("end") or 0))
        if not end > start:
            end = start + INVALID_SEGMENT_END_FALLBACK_SEC
        out.append({"start": start, "end": end, "text": text})
    out.sort(key=lambda x: (x["start"], x["end"]))
    return out


def _normalize_silence_gaps(silence_gaps: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for sg in silence_gaps or []:
        if not isinstance(sg, dict):
            continue
        start = max(0.0, float(sg.get("start") or 0))
        end = max(0.0, float(sg.get("end") or 0))
        dur = float(sg.get("duration") or 0) or max(0.0, end - start)
        if dur <= 0:
            continue
        out.append({"start": start, "end": end, "duration": dur})
    out.sort(key=lambda x: x["start"])
    return out


def _silence_between_words(t0: float, t1: float, silence_gaps: list[dict[str, Any]]) -> bool:
    if t1 - t0 >= SILENCE_END_LOCK_SEC - 0.01:
        return False
    for sg in _normalize_silence_gaps(silence_gaps):
        dur = sg["duration"]
        if dur < SILENCE_END_LOCK_SEC - 0.01:
            continue
        if sg["start"] >= t0 + 0.05 and sg["end"] <= t1 - 0.05:
            return True
    return False


def _segment_rows_for_breaks(
    aligned: list[dict[str, Any]], rough: list[dict[str, Any]] | None = None
) -> list[dict[str, Any]]:
    rough_rows = _normalize_segments(rough or [])
    if len(rough_rows) >= 2:
        return rough_rows
    return _normalize_segments(aligned)


def _word_index_after_silence(
    words: list[dict[str, Any]], sg: dict[str, Any], duration_sec: float
) -> int:
    wi = next((i for i, w in enumerate(words) if w["start"] >= sg["end"] - 0.08), -1)
    if wi > 0:
        return wi
    dur = duration_sec if duration_sec > 0 else (words[-1]["end"] if words else 0.0)
    if dur > 0 and len(words) >= 2:
        ratio = max(0.0, min(1.0, sg["end"] / dur))
        return min(len(words) - 1, max(1, round(ratio * len(words))))
    last_before = -1
    for i, w in enumerate(words):
        if w["end"] <= sg["start"] + 0.2:
            last_before = i
    if last_before >= 0 and last_before + 1 < len(words):
        return last_before + 1
    return -1


def _split_token_at_demo_ima(token: str) -> tuple[str, str] | None:
    t = re.sub(r"\s+", "", str(token or ""))
    last: re.Match[str] | None = None
    for m in re.finditer(r"((?:けれど)?でも)(今)", t):
        last = m
    if not last:
        return None
    cut = last.start() + len(last.group(1))
    left, right = t[:cut], t[cut:]
    if not left or not right:
        return None
    return left, right


def _pick_silence_gap_near_phrase_split(
    token_start: float, token_end: float, silence_gaps: list[dict[str, Any]]
) -> dict[str, Any] | None:
    target = token_start + (token_end - token_start) * 0.72
    best: dict[str, Any] | None = None
    best_dist = float("inf")
    for sg in _normalize_silence_gaps(silence_gaps):
        if sg["duration"] < SILENCE_END_LOCK_SEC - 0.01:
            continue
        center = (sg["start"] + sg["end"]) / 2
        d = abs(center - target)
        if d < best_dist:
            best_dist = d
            best = sg
    return best


def _expand_words_at_phrase_boundary(
    words: list[dict[str, Any]], silence_gaps: list[dict[str, Any]] | None = None
) -> list[dict[str, Any]]:
    gaps = silence_gaps or []
    out: list[dict[str, Any]] = []
    for w in words:
        split = _split_token_at_demo_ima(str(w.get("word") or ""))
        if split:
            left, right = split
            ws, we = float(w["start"]), float(w["end"])
            sg = _pick_silence_gap_near_phrase_split(ws, we, gaps)
            if (
                sg
                and sg["start"] > ws + 0.05
                and sg["end"] < we - 0.05
                and sg["end"] - sg["start"] >= SILENCE_GAP_LINE_MIN_SEC - 0.01
            ):
                out.append({"word": left, "start": ws, "end": sg["start"]})
                out.append({"word": right, "start": sg["end"], "end": we})
                continue
            t = re.sub(r"\s+", "", str(w.get("word") or ""))
            span = max(we - ws, 0.02)
            ratio = len(left) / max(len(t), 1)
            est = ws + span * ratio
            half = SILENCE_GAP_LINE_MIN_SEC / 2
            out.append({"word": left, "start": ws, "end": max(ws + 0.05, est - half)})
            out.append({"word": right, "start": min(we - 0.05, est + half), "end": we})
            continue
        out.append(w)
    return out


def _resolve_adjacent_cue_boundary(
    prev: dict[str, Any],
    nxt: dict[str, Any],
    silence_gaps: list[dict[str, Any]],
    rough_segments: list[dict[str, Any]] | None = None,
) -> tuple[float, float] | None:
    if nxt["startSec"] - prev["endSec"] >= SILENCE_GAP_LINE_MIN_SEC - 0.05:
        return None
    if _phrase_line_gap(prev, nxt) is None:
        return None
    for sg in _normalize_silence_gaps(silence_gaps):
        if sg["duration"] < SILENCE_GAP_LINE_MIN_SEC - 0.01:
            continue
        return sg["start"], sg["end"]
    rough = _normalize_segments(rough_segments or [])
    for si in range(1, len(rough)):
        rgap = rough[si]["start"] - rough[si - 1]["end"]
        if rgap < SILENCE_GAP_LINE_MIN_SEC - 0.01:
            continue
        return rough[si - 1]["end"], rough[si]["start"]
    mid = prev["endSec"]
    return mid, mid + SILENCE_GAP_LINE_MIN_SEC


def _apply_silence_boundaries_to_cues(
    cues: list[dict[str, Any]],
    silence_gaps: list[dict[str, Any]] | None = None,
    rough_segments: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    if len(cues) < 2:
        return cues
    out = [dict(c) for c in cues]
    for i in range(len(out) - 1):
        b = _resolve_adjacent_cue_boundary(out[i], out[i + 1], silence_gaps or [], rough_segments)
        if not b:
            continue
        prev_end, next_start = b
        out[i]["endSec"] = _safe_end(out[i]["startSec"], prev_end)
        out[i + 1]["startSec"] = max(next_start, out[i]["endSec"] + 0.01)
    return out


def _phrase_boundary_break_before_word(words: list[dict[str, Any]]) -> set[int]:
    breaks: set[int] = set()
    if len(words) < 2:
        return breaks
    for i in range(1, len(words)):
        left = "".join(w["word"] for w in words[max(0, i - 12) : i]).replace(" ", "")
        right = "".join(w["word"] for w in words[i : min(len(words), i + 6)]).replace(" ", "")
        if re.search(r"(?:けれど)?でも$", left) and right.startswith("今"):
            breaks.add(i)
    return breaks


def _phrase_line_gap(prev: dict[str, Any], nxt: dict[str, Any]) -> float | None:
    left = re.sub(r"\s+", "", prev.get("text") or "")
    right = re.sub(r"\s+", "", nxt.get("text") or "")
    if re.search(r"(?:けれど)?でも$", left) and right.startswith("今"):
        return SILENCE_GAP_LINE_MIN_SEC
    return None


def _forced_span_break_before_word(
    words: list[dict[str, Any]],
    segments: list[dict[str, Any]],
    silence_gaps: list[dict[str, Any]],
    rough_segments: list[dict[str, Any]] | None = None,
    duration_sec: float = 0.0,
) -> set[int]:
    breaks: set[int] = set()
    if len(words) < 2:
        return breaks
    seg_rows = _segment_rows_for_breaks(segments, rough_segments)
    for si in range(1, len(seg_rows)):
        gap = seg_rows[si]["start"] - seg_rows[si - 1]["end"]
        if gap < SILENCE_END_LOCK_SEC:
            continue
        wi = next((i for i, w in enumerate(words) if w["start"] >= seg_rows[si]["start"] - 0.05), -1)
        if wi > 0:
            breaks.add(wi)
    for sg in _normalize_silence_gaps(silence_gaps):
        if sg["duration"] < SILENCE_END_LOCK_SEC - 0.01:
            continue
        wi = _word_index_after_silence(words, sg, duration_sec)
        if wi > 0:
            breaks.add(wi)
    breaks |= _phrase_boundary_break_before_word(words)
    return breaks


def _span_gap_sec(
    prev: dict[str, Any],
    nxt: dict[str, Any],
    silence_gaps: list[dict[str, Any]],
    rough_segments: list[dict[str, Any]] | None = None,
) -> float:
    word_gap = nxt["startSec"] - prev["endSec"]
    if word_gap >= SILENCE_GAP_LINE_MIN_SEC - 0.01:
        return word_gap
    for sg in _normalize_silence_gaps(silence_gaps):
        dur = sg["duration"]
        if dur < SILENCE_GAP_LINE_MIN_SEC - 0.01:
            continue
        if nxt["startSec"] >= sg["end"] - 0.25 and prev["endSec"] <= sg["end"] + 0.5:
            return dur
    rough = _normalize_segments(rough_segments or [])
    for si in range(1, len(rough)):
        rgap = rough[si]["start"] - rough[si - 1]["end"]
        if rgap < SILENCE_GAP_LINE_MIN_SEC - 0.01:
            continue
        if prev["endSec"] >= rough[si - 1]["start"] - 0.2 and nxt["startSec"] <= rough[si]["end"] + 0.2:
            return rgap
    pg = _phrase_line_gap(prev, nxt)
    if pg is not None:
        return pg
    return word_gap


def build_speech_spans_from_align_words(
    words: list[dict[str, Any]],
    duration_sec: float = 0.0,
    segments: list[dict[str, Any]] | None = None,
    silence_gaps: list[dict[str, Any]] | None = None,
    rough_segments: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    rows = _expand_words_at_phrase_boundary(normalize_align_words(words), silence_gaps)
    max_t = float(duration_sec) if duration_sec and duration_sec > 0 else 0.0
    if max_t > 0:
        rows = [
            {
                "word": w["word"],
                "start": max(0.0, min(w["start"], max_t)),
                "end": _safe_end(w["start"], min(w["end"], max_t)),
            }
            for w in rows
            if w["start"] < max_t - 0.01
        ]
    if not rows:
        return []

    gaps = silence_gaps or []
    forced = _forced_span_break_before_word(
        rows, segments or [], gaps, rough_segments, max_t or duration_sec
    )
    spans: list[dict[str, Any]] = []
    batch_start = rows[0]["start"]
    batch_end = rows[0]["end"]
    batch_texts = [rows[0]["word"]]

    def flush() -> None:
        text = _join_word_texts(batch_texts)
        if not text:
            return
        spans.append(
            {
                "startSec": batch_start,
                "endSec": _safe_end(batch_start, batch_end),
                "text": text,
            }
        )

    for i, w in enumerate(rows[1:], start=1):
        gap = w["start"] - batch_end
        end_locked = (
            i in forced
            or gap >= SILENCE_END_LOCK_SEC
            or _silence_between_words(batch_end, w["start"], gaps)
        )
        if end_locked:
            flush()
            batch_start = w["start"]
            batch_end = w["end"]
            batch_texts = [w["word"]]
            continue
        batch_texts.append(w["word"])
        batch_end = max(batch_end, w["end"])
    flush()
    return spans


def build_timeline_cues_from_speech_spans(
    spans: list[dict[str, Any]],
    silence_gaps: list[dict[str, Any]] | None = None,
    rough_segments: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    if not spans:
        return []

    cues: list[dict[str, Any]] = []
    batch = {
        "startSec": spans[0]["startSec"],
        "endSec": spans[0]["endSec"],
        "texts": [spans[0]["text"]],
    }
    pending_block_break = False

    def flush() -> None:
        nonlocal pending_block_break
        text = _join_word_texts(batch["texts"])
        if not text:
            return
        cues.append(
            {
                "startSec": batch["startSec"],
                "endSec": _safe_end(batch["startSec"], batch["endSec"]),
                "text": text,
                "blockBreak": pending_block_break,
            }
        )
        pending_block_break = False

    gaps = silence_gaps or []
    rough = rough_segments or []
    for nxt in spans[1:]:
        gap = _span_gap_sec(
            {
                "startSec": batch["startSec"],
                "endSec": batch["endSec"],
                "text": _join_word_texts(batch["texts"]),
            },
            nxt,
            gaps,
            rough,
        )
        if gap >= SILENCE_GAP_BLOCK_MIN_SEC:
            flush()
            pending_block_break = True
            batch = {
                "startSec": nxt["startSec"],
                "endSec": nxt["endSec"],
                "texts": [nxt["text"]],
            }
            continue
        if gap >= SILENCE_GAP_LINE_MIN_SEC:
            flush()
            batch = {
                "startSec": nxt["startSec"],
                "endSec": nxt["endSec"],
                "texts": [nxt["text"]],
            }
            continue
        batch["texts"].append(nxt["text"])
        batch["endSec"] = max(batch["endSec"], nxt["endSec"])
    flush()
    return _apply_silence_boundaries_to_cues(cues, silence_gaps, rough_segments)


def build_timeline_cues_from_align_words(
    words: list[dict[str, Any]],
    duration_sec: float = 0.0,
    segments: list[dict[str, Any]] | None = None,
    silence_gaps: list[dict[str, Any]] | None = None,
    rough_segments: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    spans = build_speech_spans_from_align_words(
        words, duration_sec, segments, silence_gaps, rough_segments
    )
    if not spans:
        return []
    return build_timeline_cues_from_speech_spans(spans, silence_gaps, rough_segments)


def build_timeline_cues_from_whisperx(
    words: list[dict[str, Any]],
    segments: list[dict[str, Any]],
    duration_sec: float = 0.0,
    silence_gaps: list[dict[str, Any]] | None = None,
    rough_segments: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    rows = normalize_align_words(words)
    max_t = float(duration_sec) if duration_sec and duration_sec > 0 else 0.0
    if max_t > 0:
        rows = [
            {
                "word": w["word"],
                "start": max(0.0, min(w["start"], max_t)),
                "end": _safe_end(w["start"], min(w["end"], max_t)),
            }
            for w in rows
            if w["start"] < max_t - 0.01
        ]
    if rows:
        return build_timeline_cues_from_align_words(
            rows, duration_sec, segments, silence_gaps, rough_segments
        )
    seg_rows = _normalize_segments(segments)
    if not seg_rows:
        return []
    cues: list[dict[str, Any]] = []
    batch = {"startSec": seg_rows[0]["start"], "endSec": seg_rows[0]["end"], "texts": [seg_rows[0]["text"]]}
    pending_block = False

    def flush() -> None:
        nonlocal pending_block
        text = _join_word_texts(batch["texts"])
        if not text:
            return
        cues.append(
            {
                "startSec": batch["startSec"],
                "endSec": _safe_end(batch["startSec"], batch["endSec"]),
                "text": text,
                "blockBreak": pending_block,
            }
        )
        pending_block = False

    for nxt in seg_rows[1:]:
        gap = nxt["start"] - batch["endSec"]
        if gap >= SILENCE_GAP_BLOCK_MIN_SEC:
            flush()
            pending_block = True
            batch = {"startSec": nxt["start"], "endSec": nxt["end"], "texts": [nxt["text"]]}
            continue
        if gap >= SILENCE_GAP_LINE_MIN_SEC:
            flush()
            batch = {"startSec": nxt["start"], "endSec": nxt["end"], "texts": [nxt["text"]]}
            continue
        batch["texts"].append(nxt["text"])
        batch["endSec"] = max(batch["endSec"], nxt["end"])
    flush()
    return cues


def timeline_cues_to_legacy_segments(cues: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out = []
    for c in cues:
        row = {
            "start": c["startSec"],
            "end": c["endSec"],
            "text": c["text"],
        }
        if c.get("blockBreak"):
            row["blockBreak"] = True
        out.append(row)
    return out


def build_bracket_timeline_from_whisperx(
    words: list[dict[str, Any]],
    segments: list[dict[str, Any]],
    duration_sec: float = 0.0,
    silence_gaps: list[dict[str, Any]] | None = None,
    rough_segments: list[dict[str, Any]] | None = None,
) -> str:
    lines: list[str] = []
    for cue in build_timeline_cues_from_whisperx(
        words, segments, duration_sec, silence_gaps, rough_segments
    ):
        if cue.get("blockBreak"):
            lines.append(NEW_BLOCK_MARKER)
        end = _safe_end(cue["startSec"], cue["endSec"])
        lines.append(
            f"[{format_bracket_timecode(cue['startSec'])} - {format_bracket_timecode(end)}] {cue['text']}"
        )
    return "\n".join(lines).strip()


def build_bracket_timeline_from_align_words(
    words: list[dict[str, Any]], duration_sec: float = 0.0, segments: list[dict[str, Any]] | None = None
) -> str:
    lines: list[str] = []
    for cue in build_timeline_cues_from_align_words(words, duration_sec, segments):
        if cue.get("blockBreak"):
            lines.append(NEW_BLOCK_MARKER)
        end = _safe_end(cue["startSec"], cue["endSec"])
        lines.append(
            f"[{format_bracket_timecode(cue['startSec'])} - {format_bracket_timecode(end)}] {cue['text']}"
        )
    return "\n".join(lines).strip()
