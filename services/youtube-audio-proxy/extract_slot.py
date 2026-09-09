"""Extract concurrency gate.

Sync gunicorn (workers=1) used to queue HTTP requests until Edge aborted
with "Signal timed out". Acquire must fail fast so /extract returns 503 BUSY
and /health stays responsive under gthread.
"""

from __future__ import annotations

import os
import threading


def busy_wait_sec(env: dict | None = None) -> float:
    src = env if env is not None else os.environ
    raw = str(src.get("WAVRICK_YT_BUSY_WAIT_SEC", "2") or "2").strip()
    try:
        v = float(raw)
    except (TypeError, ValueError):
        return 2.0
    return max(0.1, min(v, 15.0))


def ydl_socket_timeout(env: dict | None = None) -> int:
    """yt-dlp / urllib socket timeout. Must stay below gunicorn timeout (240s)."""
    src = env if env is not None else os.environ
    raw = str(src.get("WAVRICK_YT_SOCKET_TIMEOUT", "90") or "90").strip()
    try:
        v = int(raw)
    except (TypeError, ValueError):
        return 90
    return max(15, min(v, 180))


class ExtractGate:
    def __init__(self, max_concurrent: int):
        n = max(1, int(max_concurrent))
        self.max_concurrent = n
        self._sem = threading.Semaphore(n)
        self._lock = threading.Lock()
        self._inflight = 0

    @property
    def inflight(self) -> int:
        with self._lock:
            return self._inflight

    def acquire(self, wait_sec: float | None = None) -> bool:
        timeout = busy_wait_sec() if wait_sec is None else max(0.1, float(wait_sec))
        if not self._sem.acquire(timeout=timeout):
            return False
        with self._lock:
            self._inflight += 1
        return True

    def release(self) -> None:
        with self._lock:
            self._inflight = max(0, self._inflight - 1)
        self._sem.release()
