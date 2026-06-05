"""In-process sliding-window rate limiter for Flask routes (SEC-5)."""

from __future__ import annotations

import os
import time
from collections import defaultdict
from threading import Lock
from typing import DefaultDict, List, Tuple

from flask import request


def _positive_int(name: str, default: int) -> int:
    try:
        v = int(os.environ.get(name, str(default)).strip())
        return v if v > 0 else default
    except (TypeError, ValueError):
        return default


class SlidingWindowLimiter:
    def __init__(self) -> None:
        self._hits: DefaultDict[str, List[float]] = defaultdict(list)
        self._lock = Lock()

    def allow(self, key: str, limit: int, window_sec: int) -> Tuple[bool, int]:
        now = time.time()
        limit = max(1, int(limit))
        window_sec = max(1, int(window_sec))
        with self._lock:
            hits = self._hits[key]
            cutoff = now - window_sec
            hits[:] = [t for t in hits if t > cutoff]
            if len(hits) >= limit:
                retry = max(1, int(window_sec - (now - hits[0]) + 1))
                return False, retry
            hits.append(now)
            return True, 0


_limiter = SlidingWindowLimiter()


def client_ip() -> str:
    forwarded = (request.headers.get("X-Forwarded-For") or "").split(",")[0].strip()
    if forwarded:
        return forwarded[:64]
    for header in ("CF-Connecting-IP", "X-Real-IP"):
        v = (request.headers.get(header) or "").strip()
        if v:
            return v[:64]
    return (request.remote_addr or "unknown")[:64]


def check_extract_limit() -> Tuple[bool, int]:
    key = f"extract:{client_ip()}"
    limit = _positive_int("WAVRICK_RL_EXTRACT_PER_MIN", 6)
    return _limiter.allow(key, limit, 60)


def check_video_meta_limit() -> Tuple[bool, int]:
    key = f"video-meta:{client_ip()}"
    limit = _positive_int("WAVRICK_RL_VIDEO_META_PER_MIN", 30)
    return _limiter.allow(key, limit, 60)


def rate_limit_config() -> dict:
    return {
        "extractPerMin": _positive_int("WAVRICK_RL_EXTRACT_PER_MIN", 6),
        "videoMetaPerMin": _positive_int("WAVRICK_RL_VIDEO_META_PER_MIN", 30),
    }
