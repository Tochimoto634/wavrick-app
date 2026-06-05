"""CORS origin resolution for youtube-audio-proxy."""

from __future__ import annotations

import os
import re

_LOCAL_ORIGIN_RE = re.compile(r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$", re.I)


def resolve_cors_origin(request_origin: str | None) -> str:
    raw = (os.environ.get("WAVRICK_CORS_ORIGIN") or "").strip()
    allowed = [s.strip() for s in raw.split(",") if s.strip()]
    origin = (request_origin or "").strip()

    if allowed:
        if "*" in allowed:
            return "*"
        if origin and origin in allowed:
            return origin
        return allowed[0]

    if origin and _LOCAL_ORIGIN_RE.match(origin):
        return origin

    return ""
