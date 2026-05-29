/** SubRip (SRT) — Whisper セグメントからのタイムコード生成（Deno / Edge） */

import type { WhisperSeg } from "./whisper-timeline-rules.ts";
import { buildTimelineCuesFromWhisperSegments } from "./whisper-timeline-rules.ts";

export {
  SILENCE_GAP_LINE_MIN_SEC,
  SILENCE_GAP_BLOCK_MIN_SEC,
  INVALID_SEGMENT_END_FALLBACK_SEC,
  buildBracketTimelineFromWhisperSegments,
  buildFlatBracketTimelineFromWhisperSegments,
  buildTimelineCuesFromWhisperSegments,
  NEW_BLOCK_MARKER,
} from "./whisper-timeline-rules.ts";

const SRT_CUE_TIME_RE =
  /^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{3})/;

function srtTimestampToSec(h: string, m: string, s: string, ms: string): number {
  return (
    Number(h) * 3600 +
    Number(m) * 60 +
    Number(s) +
    Number(ms) / 1000
  );
}

/** OpenAI Whisper `response_format: srt` の本文をパースしてセグメント化する */
export function parseSrtToWhisperSegments(srt: string): WhisperSeg[] {
  const normalized = String(srt || "").replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];

  const blocks = normalized.split(/\n\n+/);
  const out: WhisperSeg[] = [];

  for (const block of blocks) {
    const lines = block.split("\n").map((l) => l.trimEnd());
    if (lines.length < 2) continue;
    let idx = 0;
    if (/^\d+$/.test(lines[0].trim())) idx = 1;

    const timeLine = (lines[idx] || "").trim();
    const m = timeLine.match(SRT_CUE_TIME_RE);
    if (!m) continue;

    const start = srtTimestampToSec(m[1], m[2], m[3], m[4]);
    const end = srtTimestampToSec(m[5], m[6], m[7], m[8]);
    const text = lines
      .slice(idx + 1)
      .join("\n")
      .trim();
    if (!text) continue;
    if (!(end > start)) continue;
    out.push({ start, end, text });
  }

  out.sort((a, b) => a.start - b.start || a.end - b.end);
  return out;
}

export function formatSrtTimestamp(seconds: number): string {
  const s = Math.max(0, Number(seconds) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const whole = Math.floor(sec);
  const ms = Math.min(999, Math.round((sec - whole) * 1000));
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(whole).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

export function buildSrtFromWhisperSegments(
  whisperSegments: WhisperSeg[],
  durationSec = 0
): string {
  const cueParts = buildTimelineCuesFromWhisperSegments(
    whisperSegments,
    durationSec
  );
  if (!cueParts.length) return "";

  const blocks: string[] = [];
  let openBlock: string[] = [];
  let idx = 0;

  for (const cue of cueParts) {
    if (cue.blockBreak && openBlock.length) {
      blocks.push(openBlock.join("\n\n"));
      openBlock = [];
      idx = 0;
    }
    idx++;
    const start = formatSrtTimestamp(cue.startSec);
    const end = formatSrtTimestamp(
      cue.endSec > cue.startSec ? cue.endSec : cue.startSec + 0.35
    );
    openBlock.push(`${idx}\n${start} --> ${end}\n${cue.text}`);
  }
  if (openBlock.length) blocks.push(openBlock.join("\n\n"));

  return blocks.join("\n\n\n").trim();
}
