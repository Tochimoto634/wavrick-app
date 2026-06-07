#!/usr/bin/env bash
# YouTube cookies を Railway の WAVRICK_YT_COOKIES_B64 用に出力する
# Railway の変数上限は 32768 文字 → YouTube / Google 関連だけに絞る
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${ROOT}/.local/youtube-cookies.txt"
FILTERED="${ROOT}/.local/youtube-cookies-filtered.txt"
B64_OUT="${ROOT}/.local/youtube-cookies.b64.txt"
RAILWAY_MAX=32768

mkdir -p "${ROOT}/.local"

filter_youtube_cookies() {
  python3 - "$1" "$2" <<'PY'
import sys
from pathlib import Path

src, dst = Path(sys.argv[1]), Path(sys.argv[2])
keep_suffixes = (
    ".youtube.com", "youtube.com",
    ".google.com", "google.com",
    ".google.co.jp", "google.co.jp",
)
lines = src.read_text(encoding="utf-8", errors="replace").splitlines()
header = [l for l in lines if l.startswith("#")]
body = [l for l in lines if l.strip() and not l.startswith("#")]
filtered = []
for line in body:
    domain = line.split("\t", 1)[0].strip().lower()
    if any(domain == s or domain.endswith(s) for s in keep_suffixes):
        filtered.append(line)
out_lines = header[:2] if header else ["# Netscape HTTP Cookie File", "# filtered for YouTube"]
out_lines.extend(filtered)
dst.write_text("\n".join(out_lines) + "\n", encoding="utf-8")
print(len(body), len(filtered), dst.stat().st_size)
PY
}

encode_existing() {
  local src="${1:-${FILTERED}}"
  if [[ ! -s "${src}" ]]; then
    src="${OUT}"
  fi
  if [[ ! -s "${src}" ]]; then
    echo "cookies ファイルがありません: ${FILTERED} または ${OUT}"
    exit 1
  fi
  if [[ "${src}" == "${OUT}" && "${src}" != "${FILTERED}" ]]; then
    filter_youtube_cookies "${OUT}" "${FILTERED}" >/dev/null
    src="${FILTERED}"
  fi
  base64 < "${src}" | tr -d '\n' > "${B64_OUT}"
  local b64_len
  b64_len="$(wc -c < "${B64_OUT}" | tr -d ' ')"
  if (( b64_len > RAILWAY_MAX )); then
    echo "ERROR: base64 が ${b64_len} 文字で Railway の上限 ${RAILWAY_MAX} を超えています。"
    echo "Chrome の他サイト cookies が多すぎる可能性があります。拡張機能で youtube.com のみエクスポートしてください。"
    exit 1
  fi
  echo ""
  echo "できました:"
  echo "  絞り込み後 cookies: ${FILTERED}"
  echo "  base64 (${b64_len} 文字): ${B64_OUT}"
  print_railway_hint
}

print_railway_hint() {
  echo ""
  echo "Railway → youtube-audio-proxy → Variables:"
  echo "  名前: WAVRICK_YT_COOKIES_B64"
  echo "  値:   ${B64_OUT} を開いて中身をすべてコピー（約 $(wc -c < "${B64_OUT}" | tr -d ' ') 文字）"
  echo ""
  echo "追加後 Redeploy。期限切れしたらこのスクリプトを再実行。"
}

echo "=== YouTube cookies エクスポート（Railway 用）==="
echo ""

if [[ "${1:-}" == "--encode-only" ]]; then
  if [[ -s "${OUT}" ]]; then
    filter_youtube_cookies "${OUT}" "${FILTERED}" >/dev/null
  fi
  encode_existing "${FILTERED}"
  exit 0
fi

if [[ -s "${FILTERED}" && "${1:-}" != "--force" ]]; then
  echo "既に ${FILTERED} があります。base64 だけ再作成します。"
  encode_existing "${FILTERED}"
  exit 0
fi

if ! command -v yt-dlp >/dev/null 2>&1; then
  echo "yt-dlp がありません。brew install yt-dlp"
  exit 1
fi

echo "ブラウザから cookies を取得し、YouTube 用だけに絞り込みます..."
echo ""

TEST_URL="https://www.youtube.com/watch?v=dQw4w9WgXcQ"
BROWSERS=(chrome chromium brave edge firefox safari)
PICKED=""

for browser in "${BROWSERS[@]}"; do
  echo "試行: ${browser} ..."
  rm -f "${OUT}"
  yt-dlp \
    --cookies-from-browser "${browser}" \
    --cookies "${OUT}" \
    --skip-download \
    -o /dev/null \
    "${TEST_URL}" >/dev/null 2>&1 || true

  if [[ -s "${OUT}" ]]; then
    PICKED="${browser}"
    read -r _total _filtered _bytes < <(filter_youtube_cookies "${OUT}" "${FILTERED}")
    echo "  → OK（全 ${_total} 件 → YouTube/Google ${_filtered} 件、${_bytes} bytes）"
    break
  fi
  echo "  → cookies ファイルが作れませんでした"
done

if [[ -z "${PICKED}" ]]; then
  echo ""
  echo "自動取得に失敗しました。"
  echo "  1. Chrome を Cmd+Q で終了して再実行"
  echo "  2. または拡張「Get cookies.txt LOCALLY」で youtube.com のみ Export →"
  echo "     ${OUT} に保存 → $0 --encode-only"
  exit 1
fi

encode_existing "${FILTERED}"
