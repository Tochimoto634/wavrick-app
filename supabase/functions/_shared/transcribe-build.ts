/** 文字起こしパイプラインのビルド番号（末尾マーカーで稼働確認） */

export const WAVRICK_TRANSCRIBE_BUILD = 8;

export function transcribeBuildMarker(): string {
  return `[Wavrick-${WAVRICK_TRANSCRIBE_BUILD}]`;
}

export function appendTranscribeBuildMarker(text: string): string {
  const marker = transcribeBuildMarker();
  const t = String(text || "").trim();
  if (!t) return marker;
  if (t.includes(marker)) return t;
  return `${t}\n${marker}`;
}

export function stripTranscribeBuildMarker(text: string): string {
  return String(text || "")
    .replace(/\n?\[Wavrick-\d+\]\s*$/i, "")
    .trim();
}
