#!/usr/bin/env python3
"""Fast BUSY gate must not wait hundreds of seconds (Edge abort cause)."""

from __future__ import annotations

import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "services" / "youtube-audio-proxy"))

from extract_slot import ExtractGate, busy_wait_sec, ydl_socket_timeout  # noqa: E402


def assert_true(cond: bool, msg: str) -> None:
    if not cond:
        raise SystemExit(f"FAIL: {msg}")


assert_true(busy_wait_sec({"WAVRICK_YT_BUSY_WAIT_SEC": "2"}) == 2.0, "default 2s")
assert_true(busy_wait_sec({"WAVRICK_YT_BUSY_WAIT_SEC": "0"}) == 0.1, "floor")
assert_true(busy_wait_sec({"WAVRICK_YT_BUSY_WAIT_SEC": "99"}) == 15.0, "cap")
assert_true(busy_wait_sec({"WAVRICK_YT_BUSY_WAIT_SEC": "nope"}) == 2.0, "bad value")

assert_true(ydl_socket_timeout({"WAVRICK_YT_SOCKET_TIMEOUT": "90"}) == 90, "socket default")
assert_true(ydl_socket_timeout({"WAVRICK_YT_SOCKET_TIMEOUT": "5"}) == 15, "socket floor")
assert_true(ydl_socket_timeout({"WAVRICK_YT_SOCKET_TIMEOUT": "999"}) == 180, "socket cap")
assert_true(ydl_socket_timeout({}) == 90, "socket missing env")

gate = ExtractGate(1)
assert_true(gate.acquire(0.2) is True, "first acquire")
assert_true(gate.inflight == 1, "inflight")

t0 = time.monotonic()
assert_true(gate.acquire(0.35) is False, "second acquire must fail fast")
elapsed = time.monotonic() - t0
assert_true(0.25 <= elapsed <= 1.2, f"waited {elapsed:.2f}s, expected ~0.35s not 300s")

gate.release()
assert_true(gate.inflight == 0, "released")
assert_true(gate.acquire(0.2) is True, "acquire after release")
gate.release()

print("test-extract-slot.py: ok")
