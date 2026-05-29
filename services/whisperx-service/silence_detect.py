"""ffmpeg silencedetect で無音区間を検出（単語 align が詰める長い間を補う）"""

from __future__ import annotations

import re
import shutil
import subprocess
from typing import Any

_SILENCE_START = re.compile(r"silence_start:\s*([0-9.]+)")
_SILENCE_END = re.compile(r"silence_end:\s*([0-9.]+)\s*\|\s*silence_duration:\s*([0-9.]+)")


def _parse_ffmpeg_silence(stderr: str, min_duration_sec: float) -> list[dict[str, float]]:
    gaps: list[dict[str, float]] = []
    pending_start: float | None = None
    for line in stderr.splitlines():
        m_start = _SILENCE_START.search(line)
        if m_start:
            pending_start = float(m_start.group(1))
            continue
        m_end = _SILENCE_END.search(line)
        if m_end and pending_start is not None:
            end = float(m_end.group(1))
            dur = float(m_end.group(2))
            if dur >= min_duration_sec - 0.01:
                gaps.append({"start": pending_start, "end": end, "duration": dur})
            pending_start = None
    return gaps


def _run_silencedetect(audio_path: str, af_filter: str) -> str:
    if not shutil.which("ffmpeg"):
        return ""
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-nostats",
        "-i",
        audio_path,
        "-af",
        af_filter,
        "-f",
        "null",
        "-",
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=600, check=False)
    except (subprocess.SubprocessError, OSError):
        return ""
    return proc.stderr or ""


def _merge_gaps(gaps: list[dict[str, float]]) -> list[dict[str, float]]:
    if not gaps:
        return []
    rows = sorted(gaps, key=lambda x: x["start"])
    merged: list[dict[str, float]] = []
    cur = dict(rows[0])
    for nxt in rows[1:]:
        if nxt["start"] <= cur["end"] + 0.15:
            cur["end"] = max(cur["end"], nxt["end"])
            cur["duration"] = cur["end"] - cur["start"]
        else:
            merged.append(cur)
            cur = dict(nxt)
    merged.append(cur)
    return merged


def detect_silence_gaps(
    audio_path: str,
    *,
    min_duration_sec: float = 2.0,
    noise_db: int = -35,
    af_prefix: str = "",
) -> list[dict[str, float]]:
    """
    Returns silence intervals [{start, end, duration}, ...] where duration >= min_duration_sec.
    """
    af = f"{af_prefix}silencedetect=noise={noise_db}dB:d={min_duration_sec}"
    stderr = _run_silencedetect(audio_path, af)
    if not stderr:
        return []
    gaps = _parse_ffmpeg_silence(stderr, min_duration_sec)
    gaps.sort(key=lambda x: x["start"])
    return gaps


def detect_silence_gaps_robust(audio_path: str) -> list[dict[str, float]]:
    """
    複数閾値 + ハイパスで検出しマージ（BGM ありの台詞間無音向け）。
    """
    if not shutil.which("ffmpeg"):
        return []

    collected: list[dict[str, float]] = []
    configs: list[tuple[int, float, str]] = [
        (-26, 1.2, "highpass=f=200,"),
        (-28, 1.2, "highpass=f=200,"),
        (-30, 1.5, ""),
        (-32, 1.8, ""),
        (-35, 2.0, ""),
    ]
    for noise_db, min_d, prefix in configs:
        collected.extend(
            detect_silence_gaps(
                audio_path,
                min_duration_sec=min_d,
                noise_db=noise_db,
                af_prefix=prefix,
            )
        )

    merged = _merge_gaps(collected)
    out = [g for g in merged if (g.get("duration") or 0) >= 1.2 - 0.01]
    if out:
        return out
    return detect_silence_from_waveform(audio_path)


def detect_silence_from_waveform(
    audio_path: str, *, min_duration_sec: float = 1.5
) -> list[dict[str, float]]:
    """WhisperX と同じ波形から RMS で無音区間を推定（ffmpeg が0件のとき）。"""
    try:
        import numpy as np
        import whisperx
    except ImportError:
        return []

    try:
        audio = whisperx.load_audio(audio_path)
    except Exception:
        return []

    if audio is None or len(audio) < 1600:
        return []

    sr = 16000
    frame = int(0.02 * sr)
    hop = int(0.01 * sr)
    rms_vals: list[float] = []
    for i in range(0, len(audio) - frame, hop):
        chunk = audio[i : i + frame]
        rms_vals.append(float(np.sqrt(np.mean(chunk * chunk))))

    if not rms_vals:
        return []

    floor = float(np.percentile(rms_vals, 12))
    peak = float(np.percentile(rms_vals, 92))
    threshold = max(0.0035, floor + (peak - floor) * 0.12)

    gaps: list[dict[str, float]] = []
    silent = False
    start_t = 0.0
    run = 0

    for idx, val in enumerate(rms_vals):
        t = idx * hop / sr
        if val < threshold:
            if not silent:
                silent = True
                start_t = t
            run += 1
        elif silent:
            end_t = t
            dur = end_t - start_t
            if dur >= min_duration_sec - 0.01:
                gaps.append({"start": start_t, "end": end_t, "duration": dur})
            silent = False
            run = 0

    if silent:
        end_t = len(audio) / sr
        dur = end_t - start_t
        if dur >= min_duration_sec - 0.01:
            gaps.append({"start": start_t, "end": end_t, "duration": dur})

    return _merge_gaps(gaps)
