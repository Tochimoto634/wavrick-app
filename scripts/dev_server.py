#!/usr/bin/env python3
"""静的ファイルを UTF-8 charset 付きで配信（日本語の文字化け防止）"""
from __future__ import annotations

import http.server
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class UTF8Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def guess_type(self, path: str) -> str:
        ctype = super().guess_type(path)
        base = ctype.split(";", 1)[0].strip().lower()
        if base.startswith("text/") or base in (
            "application/javascript",
            "application/json",
            "image/svg+xml",
        ):
            if "charset=" not in ctype.lower():
                return f"{ctype}; charset=utf-8"
        return ctype


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8889
    os.chdir(ROOT)
    server = http.server.ThreadingHTTPServer(("0.0.0.0", port), UTF8Handler)
    print(f"WAVRICK → http://127.0.0.1:{port}/  (UTF-8 charset 付き)")
    print("Ctrl+C で停止")
    server.serve_forever()
