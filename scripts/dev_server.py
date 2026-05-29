#!/usr/bin/env python3
"""静的ファイルを UTF-8 charset 付きで配信 + ローカル音声プロキシ中継（CORS 回避）"""
from __future__ import annotations

import http.server
import json
import mimetypes
import os
import re
import sys
import uuid
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPTS = os.path.join(ROOT, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

AUDIO_PROXY = os.environ.get("WAVRICK_AUDIO_PROXY", "http://127.0.0.1:5055")

try:
    from local_media_pipeline import apply_local_secrets, handle_media_pipeline

    apply_local_secrets()
except ImportError:
    handle_media_pipeline = None  # type: ignore

PROXY_SECRET = os.environ.get("PROXY_SECRET", "wavrick-local-dev-secret")
UPLOAD_DIR = os.path.join(ROOT, ".local", "customer-uploads")
MAX_UPLOAD_BYTES = 24 * 1024 * 1024


def _parse_multipart_field(body: bytes, content_type: str, field_name: str):
    """multipart/form-data から1フィールドを取り出す（Python 3.13+ で cgi 廃止のため自前）"""
    m = re.search(r'boundary=(?:"([^"]+)"|([^\s;]+))', content_type, re.I)
    if not m:
        return None
    boundary = (m.group(1) or m.group(2)).encode("ascii")
    for part in body.split(b"--" + boundary):
        if not part or part in (b"--", b"--\r\n"):
            continue
        chunk = part.lstrip(b"\r\n")
        if chunk.endswith(b"\r\n"):
            chunk = chunk[:-2]
        header_end = chunk.find(b"\r\n\r\n")
        if header_end < 0:
            continue
        headers_raw = chunk[:header_end].decode("utf-8", errors="replace")
        if f'name="{field_name}"' not in headers_raw and f"name='{field_name}'" not in headers_raw:
            continue
        content = chunk[header_end + 4 :]
        if content.endswith(b"\r\n"):
            content = content[:-2]
        fname_m = re.search(r'filename="([^"]*)"', headers_raw)
        filename = fname_m.group(1) if fname_m else "upload.bin"
        return content, filename
    return None


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

    def do_GET(self) -> None:
        if self.path == "/api/media-pipeline/health":
            self._media_pipeline_health()
            return
        if self.path == "/api/youtube-audio/health":
            self._proxy_health()
            return
        if self.path.startswith("/api/customer-uploads/files/"):
            self._serve_customer_upload()
            return
        super().do_GET()

    def do_POST(self) -> None:
        if self.path == "/api/youtube-audio/extract":
            self._proxy_extract()
            return
        if self.path == "/api/youtube-video-meta":
            self._proxy_video_meta()
            return
        if self.path == "/api/customer-audio/upload":
            self._upload_customer_audio()
            return
        if self.path == "/api/media-pipeline":
            self._local_media_pipeline()
            return
        self.send_error(404)

    def do_OPTIONS(self) -> None:
        if self.path.startswith("/api/"):
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
            self.end_headers()
            return
        super().do_OPTIONS()

    def _local_media_pipeline(self) -> None:
        if handle_media_pipeline is None:
            self._json_response(500, {"ok": False, "error": "local_media_pipeline を読み込めません。"})
            return
        length = int(self.headers.get("Content-Length", "0") or "0")
        raw = self.rfile.read(length) if length else b""
        try:
            body = json.loads(raw.decode("utf-8") if raw else "{}")
        except json.JSONDecodeError:
            self._json_response(400, {"ok": False, "error": "Invalid JSON"})
            return
        if not isinstance(body, dict):
            self._json_response(400, {"ok": False, "error": "JSON body が不正です。"})
            return
        try:
            result, status = handle_media_pipeline(body)
            self._json_response(status, result)
        except Exception as e:
            self._json_response(500, {"ok": False, "error": str(e)})

    def _json_response(self, status: int, body: dict) -> None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _media_pipeline_health(self) -> None:
        build = None
        try:
            from local_media_pipeline import WAVRICK_TRANSCRIBE_BUILD

            build = WAVRICK_TRANSCRIBE_BUILD
        except Exception:
            pass
        self._json_response(
            200,
            {
                "ok": True,
                "transcribeBuild": build,
                "marker": f"[Wavrick-{build}]" if build is not None else None,
            },
        )

    def _proxy_health(self) -> None:
        try:
            with urllib.request.urlopen(f"{AUDIO_PROXY}/health", timeout=5) as resp:
                body = resp.read()
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(body)
        except urllib.error.URLError:
            self.send_response(502)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(
                json.dumps(
                    {
                        "ok": False,
                        "error": "音声プロキシ (5055) に接続できません。./scripts/start-audio-proxy.sh を起動してください。",
                    }
                ).encode("utf-8")
            )

    def _proxy_extract(self) -> None:
        length = int(self.headers.get("Content-Length", "0") or "0")
        raw = self.rfile.read(length) if length else b""
        try:
            payload = json.loads(raw.decode("utf-8") if raw else "{}")
        except json.JSONDecodeError:
            self.send_error(400, "Invalid JSON")
            return

        video_url = (payload.get("videoUrl") or payload.get("url") or "").strip()
        if not video_url:
            self.send_error(400, "videoUrl required")
            return

        req = urllib.request.Request(
            f"{AUDIO_PROXY}/extract",
            data=json.dumps({"videoUrl": video_url}).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {PROXY_SECRET}",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=600) as resp:
                body = resp.read()
                ctype = resp.headers.get("Content-Type", "application/octet-stream")
                vocal_hdr = resp.headers.get("X-Wavrick-Vocal-Separated")
                stem_hdr = resp.headers.get("X-Wavrick-Audio-Stem")
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            if vocal_hdr:
                self.send_header("X-Wavrick-Vocal-Separated", vocal_hdr)
            if stem_hdr:
                self.send_header("X-Wavrick-Audio-Stem", stem_hdr)
            self.end_headers()
            self.wfile.write(body)
        except urllib.error.HTTPError as err:
            detail = err.read().decode("utf-8", errors="replace")[:500]
            self.send_response(err.code)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write(
                detail.encode("utf-8")
                or f"プロキシエラー ({err.code})".encode("utf-8")
            )
        except urllib.error.URLError as err:
            self.send_response(502)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            msg = (
                "Mac の音声プロキシ (5055) に接続できません。"
                " ./scripts/start-audio-proxy.sh を別ターミナルで起動してください。"
            )
            self.wfile.write(msg.encode("utf-8"))

    def _proxy_video_meta(self) -> None:
        length = int(self.headers.get("Content-Length", "0") or "0")
        raw = self.rfile.read(length) if length else b""
        req = urllib.request.Request(
            f"{AUDIO_PROXY.rstrip('/')}/video-meta",
            data=raw,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {PROXY_SECRET}",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                body = resp.read()
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except urllib.error.HTTPError as err:
            detail = err.read()
            self.send_response(err.code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(detail)
        except urllib.error.URLError:
            self._json_response(
                502,
                {
                    "ok": False,
                    "error": "音声プロキシ (5055) に接続できません。./scripts/start-audio-proxy.sh を起動してください。",
                },
            )

    def _upload_customer_audio(self) -> None:
        os.makedirs(UPLOAD_DIR, exist_ok=True)
        ctype = self.headers.get("Content-Type", "")
        if "multipart/form-data" not in ctype:
            self._json_response(400, {"ok": False, "error": "multipart/form-data が必要です。"})
            return
        length = int(self.headers.get("Content-Length", "0") or "0")
        raw_body = self.rfile.read(length) if length else b""
        parsed = _parse_multipart_field(raw_body, ctype, "audio")
        if not parsed:
            self._json_response(400, {"ok": False, "error": "audio フィールドがありません。"})
            return
        data, orig = parsed
        if len(data) > MAX_UPLOAD_BYTES:
            self._json_response(413, {"ok": False, "error": "ファイルが大きすぎます。"})
            return
        safe = re.sub(r"[^\w.-]+", "_", orig)[:120] or "upload.bin"
        token = uuid.uuid4().hex
        rel = f"{token}_{safe}"
        path = os.path.join(UPLOAD_DIR, rel)
        with open(path, "wb") as fh:
            fh.write(data)
        host = self.headers.get("Host", "127.0.0.1:8889")
        url = f"http://{host}/api/customer-uploads/files/{rel}"
        self._json_response(
            200,
            {
                "ok": True,
                "url": url,
                "storagePath": rel,
                "fileName": orig,
                "byteLength": len(data),
            },
        )

    def _serve_customer_upload(self) -> None:
        rel = self.path.split("/api/customer-uploads/files/", 1)[-1]
        if not rel or ".." in rel or rel.startswith("/"):
            self.send_error(403)
            return
        path = os.path.join(UPLOAD_DIR, rel)
        if not os.path.isfile(path):
            self.send_error(404)
            return
        mime, _ = mimetypes.guess_type(path)
        if not mime:
            mime = "application/octet-stream"
        with open(path, "rb") as fh:
            body = fh.read()
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8889
    os.chdir(ROOT)
    server = http.server.ThreadingHTTPServer(("0.0.0.0", port), UTF8Handler)
    print(f"WAVRICK → http://127.0.0.1:{port}/  (UTF-8 charset 付き)")
    print(f"音声中継 → http://127.0.0.1:{port}/api/youtube-audio/extract → {AUDIO_PROXY}")
    print(
        f"AI台本（ローカル）→ http://127.0.0.1:{port}/api/media-pipeline "
        f"（要 5055 音声 + 8081 WhisperX + XAI）"
    )
    print("Ctrl+C で停止")
    server.serve_forever()
