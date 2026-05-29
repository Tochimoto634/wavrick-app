/** Whisper セグメント → 2秒/10秒ルール（Deno） */

export type WhisperSeg = { start: number; end: number; text: string };

export const SILENCE_GAP_LINE_MIN_SEC = 2.0;
export const SILENCE_GAP_BLOCK_MIN_SEC = 10.0;
export const INVALID_SEGMENT_END_FALLBACK_SEC = 0.35;
export const NEW_BLOCK_MARKER = "[NEW_BLOCK]";

export function formatBracketTimecode(seconds: number): string {
  const s = Math.max(0, Number(seconds) || 0);
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  const whole = Math.floor(sec);
  const cs = Math.round((sec - whole) * 100);
  return `${String(m).padStart(2, "0")}:${String(whole).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function normalizeWhisperSegments(segments: WhisperSeg[]): WhisperSeg[] {
  const out: WhisperSeg[] = [];
  for (const row of segments || []) {
    const text = String(row.text || "").trim();
    if (!text) continue;
    const start = Math.max(0, Number(row.start) || 0);
    let end = Math.max(0, Number(row.end) || 0);
    if (!(end > start)) end = start + INVALID_SEGMENT_END_FALLBACK_SEC;
    out.push({ start, end, text });
  }
  out.sort((a, b) => a.start - b.start || a.end - b.end);
  return out;
}

export type TimelineCue = {
  startSec: number;
  endSec: number;
  text: string;
  blockBreak?: boolean;
};

/**
 * gap = next.start - batch.endSec
 * &lt;2s 合体 / 2–10s 改行 / ≥10s 次ブロック（blockBreak）
 */
export function buildTimelineCuesFromWhisperSegments(
  whisperSegments: WhisperSeg[],
  durationSec = 0
): TimelineCue[] {
  const rows = normalizeWhisperSegments(whisperSegments);
  if (!rows.length) return [];

  const maxT = durationSec > 0 ? durationSec : 0;
  const filtered =
    maxT > 0
      ? rows
          .filter((s) => s.start < maxT - 0.01)
          .map((s) => {
            const start = Math.max(0, Math.min(s.start, maxT));
            const safeEnd =
              s.end > start
                ? Math.min(s.end, maxT)
                : Math.min(maxT, start + INVALID_SEGMENT_END_FALLBACK_SEC);
            const end = safeEnd > start ? safeEnd : start + 0.01;
            return { start, end, text: s.text };
          })
      : rows;

  if (!filtered.length) return [];

  const cues: TimelineCue[] = [];
  let batch = {
    startSec: filtered[0].start,
    endSec: filtered[0].end,
    texts: [filtered[0].text]
  };
  let pendingBlockBreak = false;

  const flush = () => {
    const text = batch.texts.join(" ").trim();
    if (!text) return;
    let startSec = batch.startSec;
    let endSec = batch.endSec;
    if (endSec <= startSec) {
      endSec = startSec + INVALID_SEGMENT_END_FALLBACK_SEC;
    }
    cues.push({ startSec, endSec, text, blockBreak: pendingBlockBreak });
    pendingBlockBreak = false;
  };

  for (let i = 1; i < filtered.length; i++) {
    const next = filtered[i];
    const gap = next.start - batch.endSec;

    if (gap >= SILENCE_GAP_BLOCK_MIN_SEC) {
      flush();
      pendingBlockBreak = true;
      batch = { startSec: next.start, endSec: next.end, texts: [next.text] };
      continue;
    }

    if (gap >= SILENCE_GAP_LINE_MIN_SEC) {
      flush();
      batch = { startSec: next.start, endSec: next.end, texts: [next.text] };
      continue;
    }

    batch.texts.push(next.text);
    batch.endSec = Math.max(batch.endSec, next.end);
  }
  flush();

  return cues;
}

export function buildBracketTimelineFromWhisperSegments(
  whisperSegments: WhisperSeg[],
  durationSec = 0
): string {
  const cues = buildTimelineCuesFromWhisperSegments(whisperSegments, durationSec);
  const lines: string[] = [];
  for (const cue of cues) {
    if (cue.blockBreak) lines.push(NEW_BLOCK_MARKER);
    const end =
      cue.endSec > cue.startSec
        ? cue.endSec
        : cue.startSec + INVALID_SEGMENT_END_FALLBACK_SEC;
    lines.push(
      `[${formatBracketTimecode(cue.startSec)} - ${formatBracketTimecode(end)}] ${cue.text}`
    );
  }
  return lines.join("\n").trim();
}

/**
 * セグメントを無音マージせず 1 区間 1 行のブラケットタイムラインにする（Whisper SRT 由来の区間をそのまま Grok に渡す用）
 */
export function buildFlatBracketTimelineFromWhisperSegments(
  whisperSegments: WhisperSeg[],
  durationSec = 0
): string {
  const rows = normalizeWhisperSegments(whisperSegments);
  if (!rows.length) return "";

  const maxT = durationSec > 0 ? durationSec : 0;
  const filtered =
    maxT > 0
      ? rows
          .filter((s) => s.start < maxT - 0.01)
          .map((s) => {
            const start = Math.max(0, Math.min(s.start, maxT));
            const safeEnd =
              s.end > start
                ? Math.min(s.end, maxT)
                : Math.min(maxT, start + INVALID_SEGMENT_END_FALLBACK_SEC);
            const end = safeEnd > start ? safeEnd : start + 0.01;
            return { start, end, text: s.text };
          })
      : rows;

  const lines: string[] = [];
  for (const row of filtered) {
    const end =
      row.end > row.start ? row.end : row.start + INVALID_SEGMENT_END_FALLBACK_SEC;
    lines.push(
      `[${formatBracketTimecode(row.start)} - ${formatBracketTimecode(end)}] ${row.text}`
    );
  }
  return lines.join("\n").trim();
}
