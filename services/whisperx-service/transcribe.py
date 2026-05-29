"""WhisperX: transcribe + word-level alignment."""

from __future__ import annotations

import logging
import os
import threading
from typing import Any

logger = logging.getLogger("wavrick.whisperx")

_MODEL_LOCK = threading.Lock()
_model_bundle: dict[str, Any] | None = None


def _env(name: str, default: str) -> str:
    return (os.environ.get(name) or default).strip()


def _device() -> str:
    d = _env("WHISPERX_DEVICE", "cpu").lower()
    if d == "cuda":
        try:
            import torch

            if not torch.cuda.is_available():
                logger.warning("WHISPERX_DEVICE=cuda but CUDA unavailable; using cpu")
                return "cpu"
        except ImportError:
            return "cpu"
    return "cpu"


def _compute_type(device: str) -> str:
    explicit = _env("WHISPERX_COMPUTE_TYPE", "")
    if explicit:
        return explicit
    return "float16" if device == "cuda" else "int8"


def _get_model_bundle() -> dict[str, Any]:
    global _model_bundle
    if _model_bundle is not None:
        return _model_bundle

    with _MODEL_LOCK:
        if _model_bundle is not None:
            return _model_bundle

        import whisperx

        model_size = _env("WHISPERX_MODEL", "large-v3")
        device = _device()
        compute_type = _compute_type(device)
        logger.info(
            "Loading WhisperX model=%s device=%s compute_type=%s",
            model_size,
            device,
            compute_type,
        )
        model = whisperx.load_model(model_size, device, compute_type=compute_type)
        _model_bundle = {
            "model": model,
            "device": device,
            "model_size": model_size,
            "align_models": {},
        }
        return _model_bundle


def _get_align_model(language_code: str, device: str) -> tuple[Any, Any]:
    import whisperx

    bundle = _get_model_bundle()
    lang = (language_code or "en").lower().split("-")[0]
    cache = bundle["align_models"]
    if lang in cache:
        return cache[lang]

    align_model, metadata = whisperx.load_align_model(language_code=lang, device=device)
    cache[lang] = (align_model, metadata)
    return align_model, metadata


def _normalize_word(row: dict[str, Any]) -> dict[str, Any] | None:
    raw = row.get("word")
    if raw is None:
        return None
    text = str(raw).strip()
    if not text:
        return None
    start = row.get("start")
    end = row.get("end")
    if start is None or end is None:
        return None
    try:
        s = float(start)
        e = float(end)
    except (TypeError, ValueError):
        return None
    if e < s:
        e = s + 0.01
    return {"word": text, "start": s, "end": e}


def _extract_words(aligned: dict[str, Any]) -> list[dict[str, Any]]:
    words: list[dict[str, Any]] = []
    for seg in aligned.get("segments") or []:
        if not isinstance(seg, dict):
            continue
        for w in seg.get("words") or []:
            if not isinstance(w, dict):
                continue
            norm = _normalize_word(w)
            if norm:
                words.append(norm)
    words.sort(key=lambda x: (x["start"], x["end"]))
    return words


def _normalize_segments(aligned: dict[str, Any]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for seg in aligned.get("segments") or []:
        if not isinstance(seg, dict):
            continue
        text = str(seg.get("text") or "").strip()
        if not text:
            continue
        try:
            start = float(seg.get("start") or 0)
            end = float(seg.get("end") or 0)
        except (TypeError, ValueError):
            continue
        if end <= start:
            end = start + 0.35
        row: dict[str, Any] = {"start": start, "end": end, "text": text}
        seg_words = []
        for w in seg.get("words") or []:
            if isinstance(w, dict):
                norm = _normalize_word(w)
                if norm:
                    seg_words.append(norm)
        if seg_words:
            row["words"] = seg_words
        out.append(row)
    out.sort(key=lambda x: (x["start"], x["end"]))
    return out


def transcribe_aligned(audio_path: str, *, batch_size: int | None = None) -> dict[str, Any]:
    """
    Run WhisperX transcribe + align on a local audio file path.

    Returns JSON-serializable dict with words[], segments[], duration, language.
    """
    import whisperx

    bundle = _get_model_bundle()
    model = bundle["model"]
    device = bundle["device"]
    bs = batch_size if batch_size is not None else int(_env("WHISPERX_BATCH_SIZE", "16"))

    audio = whisperx.load_audio(audio_path)
    duration = float(len(audio)) / 16000.0 if len(audio) else 0.0

    result = model.transcribe(audio, batch_size=bs)
    language = str(result.get("language") or "en")
    segments_in = result.get("segments") or []
    rough_segments: list[dict[str, Any]] = []
    for seg in segments_in:
        if not isinstance(seg, dict):
            continue
        text = str(seg.get("text") or "").strip()
        if not text:
            continue
        try:
            start = float(seg.get("start") or 0)
            end = float(seg.get("end") or 0)
        except (TypeError, ValueError):
            continue
        if end <= start:
            end = start + 0.35
        rough_segments.append({"start": start, "end": end, "text": text})
    rough_segments.sort(key=lambda x: (x["start"], x["end"]))

    align_model, metadata = _get_align_model(language, device)
    aligned = whisperx.align(
        segments_in,
        align_model,
        metadata,
        audio,
        device,
        return_char_alignments=False,
    )

    words = _extract_words(aligned)
    segments = _normalize_segments(aligned)

    if not duration and segments:
        duration = max(s["end"] for s in segments)
    if not duration and words:
        duration = max(w["end"] for w in words)

    silence_gaps: list[dict[str, float]] = []
    try:
        from silence_detect import detect_silence_gaps, detect_silence_gaps_robust

        min_d = float(_env("WHISPERX_SILENCE_MIN_SEC", "1.5"))
        noise = int(_env("WHISPERX_SILENCE_NOISE_DB", "-30"))
        from silence_detect import detect_silence_from_waveform

        silence_gaps = detect_silence_gaps_robust(audio_path)
        if not silence_gaps:
            silence_gaps = detect_silence_gaps(
                audio_path, min_duration_sec=min_d, noise_db=noise
            )
        if not silence_gaps:
            silence_gaps = detect_silence_from_waveform(audio_path, min_duration_sec=1.5)
        logger.info(
            "silence_gaps count=%s rough_segments=%s duration=%.2f",
            len(silence_gaps),
            len(rough_segments),
            duration,
        )
    except Exception as e:
        logger.warning("silence_detect failed: %s", e)

    return {
        "source": "whisperx",
        "model": bundle["model_size"],
        "device": device,
        "language": language,
        "duration": duration,
        "words": words,
        "segments": segments,
        "roughSegments": rough_segments,
        "silenceGaps": silence_gaps,
    }
