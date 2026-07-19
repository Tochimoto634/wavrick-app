#!/usr/bin/env python3
"""Unit tests for strict YouTube dub language resolution."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "services" / "youtube-audio-proxy"))

from lang_tracks import (  # noqa: E402
    assert_selected_format,
    exclusive_target_format_ids,
    format_id_is_exclusive_target,
    resolve_target_tracks,
    strong_lang_signals,
)


def test_rejects_mistagged_korean_as_japanese():
    tracks = [
        {
            "formatId": "140-9",
            "language": "ja",  # buggy client
            "formatNote": "medium, m4a_dash",
            "hasUrl": True,
            "isAudioOnly": True,
            "abr": 129,
        },
        {
            "formatId": "140-9",
            "language": "ko",
            "formatNote": "[ko] Korean, medium, m4a_dash",
            "hasUrl": True,
            "isAudioOnly": True,
            "abr": 129,
        },
        {
            "formatId": "140-19",
            "language": "ja",
            "formatNote": "[ja] Japanese (default), medium, m4a_dash",
            "hasUrl": True,
            "isAudioOnly": True,
            "abr": 129,
        },
        {
            "formatId": "140-20",
            "language": "en-US",
            "formatNote": "[en-US] English (US) original, medium, m4a_dash",
            "hasUrl": True,
            "isAudioOnly": True,
            "abr": 129,
        },
    ]
    assert format_id_is_exclusive_target(tracks, "140-9", "ja") is False
    assert format_id_is_exclusive_target(tracks, "140-19", "ja") is True
    fids = exclusive_target_format_ids(tracks, "ja")
    assert "140-9" not in fids
    assert "140-19" in fids
    resolved = resolve_target_tracks(tracks, "ja", require_dubbed=True)
    assert [t["formatId"] for t in resolved] == ["140-19"]
    assert assert_selected_format(tracks, "140-19", "ja") == "140-19"
    try:
        assert_selected_format(tracks, "140-9", "ja")
        raise AssertionError("140-9 must be rejected for ja")
    except ValueError:
        pass


def test_weak_language_alone_is_not_enough():
    tracks = [
        {
            "formatId": "140-9",
            "language": "ja",
            "formatNote": "medium",
            "hasUrl": True,
            "isAudioOnly": True,
            "abr": 129,
        }
    ]
    assert strong_lang_signals(tracks[0]) == set()
    assert exclusive_target_format_ids(tracks, "ja") == []
    assert resolve_target_tracks(tracks, "ja") == []


def test_xtags_lang_counts_as_strong():
    tracks = [
        {
            "formatId": "251-19",
            "language": "",
            "formatNote": "medium",
            "downloadUrl": "https://googlevideo.com/videoplayback?xtags=acont%3Ddubbed-auto%3Alang%3Dja",
            "hasUrl": True,
            "isAudioOnly": True,
            "abr": 116,
        }
    ]
    assert format_id_is_exclusive_target(tracks, "251-19", "ja") is True


if __name__ == "__main__":
    test_rejects_mistagged_korean_as_japanese()
    test_weak_language_alone_is_not_enough()
    test_xtags_lang_counts_as_strong()
    print("test-youtube-lang-tracks: ok")
