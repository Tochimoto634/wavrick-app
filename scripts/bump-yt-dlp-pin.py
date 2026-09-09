#!/usr/bin/env python3
"""
services/youtube-audio-proxy/requirements-railway.txt の yt-dlp ピンを
PyPI の最新 nightly (.dev0) に更新する。

YouTube は extractor を頻繁に壊すので鮮度が要る一方、ピンを外すとビルドが
再現しなくなる。週次でこのスクリプトを走らせてピンだけ上げるのが折衷案。

  python3 scripts/bump-yt-dlp-pin.py           # 更新して差分を書き込む
  python3 scripts/bump-yt-dlp-pin.py --check   # 更新が要るかだけ見る（CI 用）

終了コード: 0 = 最新（変更なし）, 10 = 更新した / 更新が必要, 1 = エラー
"""

from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys
import urllib.request

PYPI_URL = "https://pypi.org/pypi/yt-dlp/json"
REQ_PATH = pathlib.Path(__file__).resolve().parents[1] / (
    "services/youtube-audio-proxy/requirements-railway.txt"
)
PIN_RE = re.compile(r"^yt-dlp==(?P<version>[^\s#]+)\s*$", re.MULTILINE)


def latest_nightly() -> str:
    with urllib.request.urlopen(PYPI_URL, timeout=30) as resp:
        data = json.load(resp)
    newest_ts = ""
    newest_ver = ""
    for version, files in (data.get("releases") or {}).items():
        if ".dev" not in version or not files:
            continue
        # 版番号の文字列比較は 8.4 > 8.30 になるのでアップロード時刻で選ぶ
        ts = max(str(f.get("upload_time_iso_8601") or "") for f in files)
        if ts > newest_ts:
            newest_ts, newest_ver = ts, version
    if not newest_ver:
        raise RuntimeError("PyPI に yt-dlp の nightly が見つかりません")
    return newest_ver


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="書き換えずに判定だけ行う")
    args = parser.parse_args()

    text = REQ_PATH.read_text(encoding="utf-8")
    match = PIN_RE.search(text)
    if not match:
        print(f"yt-dlp== のピンが {REQ_PATH} に見つかりません", file=sys.stderr)
        return 1

    current = match.group("version")
    latest = latest_nightly()

    if current == latest:
        print(f"yt-dlp {current} は最新です")
        return 0

    print(f"yt-dlp {current} -> {latest}")
    if args.check:
        return 10

    REQ_PATH.write_text(PIN_RE.sub(f"yt-dlp=={latest}", text, count=1), encoding="utf-8")
    print(f"{REQ_PATH} を更新しました")
    return 10


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001
        print(f"エラー: {exc}", file=sys.stderr)
        sys.exit(1)
