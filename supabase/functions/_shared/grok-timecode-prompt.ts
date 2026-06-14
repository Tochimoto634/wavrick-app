import { buildFlatBracketTimelineFromWhisperSegments } from "./whisper-timeline-rules.ts";
import {
  buildBracketTimelineFromTimelineSegments,
  buildBracketTimelineFromWhisperSegments,
  formatBracketTimecode,
  LINE_GAP_MARKER,
  NEW_BLOCK_MARKER,
  type LegacyWhisperSegment,
  type WhisperSeg,
} from "./whisperx-timeline-rules.ts";

export type { WhisperSeg };

export { NEW_BLOCK_MARKER };

export type BracketTimelineRow = {
  startSec: number;
  endSec: number;
  text: string;
  /** この行の直前に [NEW_BLOCK] があった（＝新しい台本の先頭行） */
  blockBreak?: boolean;
};

const BRACKET_LINE_RE =
  /^\[(\d{1,2}):(\d{2})\.(\d{2})\s*-\s*(\d{1,2}):(\d{2})\.(\d{2})\]\s*(.*)$/;

const BRACKET_LINE_RE_FLEX =
  /^\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\s*(?:-\s*(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?)?\]\s*(.*)$/;

function parseBracketPart(min: string, sec: string, frac?: string): number {
  const s = Number(sec) || 0;
  const f = frac != null && frac !== "" ? Number(frac) : 0;
  const digits = String(frac || "").length;
  let sub = 0;
  if (digits <= 2) sub = f / 100;
  else if (digits === 3) sub = f / 1000;
  else if (digits > 0) sub = f / Math.pow(10, digits);
  return (Number(min) || 0) * 60 + s + sub;
}

export function stripWhisperTimelineMarker(raw: string): string {
  return String(raw || "")
    .replace(/\n?\[Wavrick-\d+\]\s*$/i, "")
    .trim();
}

export function parseBracketTimelineText(raw: string): BracketTimelineRow[] {
  const t = stripWhisperTimelineMarker(raw);
  const rows: BracketTimelineRow[] = [];
  // [NEW_BLOCK] 行は捨てず、直後のブラケット行を「新しい台本の先頭」として記録する。
  // 行数・index は変えないため Grok 本文との 1:1 対応は保たれる。
  let pendingBlockBreak = false;
  for (const line of t.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // "/"（2〜10秒区切り）は書き起こし表示専用。台本側では区切りを持たせない。
    if (trimmed === LINE_GAP_MARKER) continue;
    if (trimmed === NEW_BLOCK_MARKER) {
      pendingBlockBreak = true;
      continue;
    }
    let m = trimmed.match(BRACKET_LINE_RE);
    if (!m) m = trimmed.match(BRACKET_LINE_RE_FLEX);
    if (!m) continue;
    const startSec = parseBracketPart(m[1], m[2], m[3]);
    let endSec =
      m[4] != null ? parseBracketPart(m[4], m[5], m[6]) : startSec + 0.35;
    if (!(endSec > startSec)) endSec = startSec + 0.35;
    const text = String(m[7] || "").trim();
    if (!text) continue;
    rows.push({ startSec, endSec, text, ...(pendingBlockBreak ? { blockBreak: true } : {}) });
    pendingBlockBreak = false;
  }
  return rows;
}

export function formatBracketTimelineRow(row: BracketTimelineRow): string {
  const end = row.endSec > row.startSec ? row.endSec : row.startSec + 0.35;
  return `[${formatBracketTimecode(row.startSec)} - ${formatBracketTimecode(end)}] ${row.text}`;
}

/** ブラケット行配列をテキスト化（blockBreak の前に [NEW_BLOCK] を再出力） */
export function bracketRowsToTimelineText(rows: BracketTimelineRow[]): string {
  const lines: string[] = [];
  for (const row of rows) {
    if (row.blockBreak) lines.push(NEW_BLOCK_MARKER);
    lines.push(formatBracketTimelineRow(row));
  }
  return lines.join("\n");
}

export function mergeTranslationsIntoWhisperTimeline(
  whisperTimeline: string,
  translations: string[]
): string {
  const canon = parseBracketTimelineText(whisperTimeline);
  if (!canon.length) return stripWhisperTimelineMarker(whisperTimeline);
  const out = applyTranslationsToTimedCues(canon, translations);
  return bracketRowsToTimelineText(out);
}

/** タイムコード付きキューに翻訳を 1:1 で載せる（時刻は変更しない） */
export function applyTranslationsToTimedCues(
  cues: BracketTimelineRow[],
  translations: string[]
): BracketTimelineRow[] {
  if (!cues.length) return cues;
  return cues.map((row, i) => {
    const t = String(translations[i] ?? "").trim();
    return { ...row, text: t || row.text };
  });
}

export function extractDialogueTextsFromGrokScript(grokScript: string): string[] {
  const texts: string[] = [];
  for (const line of String(grokScript || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (
      !trimmed ||
      trimmed === NEW_BLOCK_MARKER ||
      trimmed === LINE_GAP_MARKER ||
      /^---\s*WAVRICK_CAST\s*---$/i.test(trimmed) ||
      trimmed === "---" ||
      /^【[^】]+】/.test(trimmed) ||
      /^[{\[]/.test(trimmed)
    ) {
      continue;
    }
    let m = trimmed.match(BRACKET_LINE_RE);
    if (!m) m = trimmed.match(BRACKET_LINE_RE_FLEX);
    if (m && m[7]) {
      texts.push(String(m[7]).trim());
      continue;
    }
    if (!/^\[/.test(trimmed)) texts.push(trimmed);
  }
  return texts.filter(Boolean);
}

/** Grok の時刻を捨て、WhisperX タイムラインの時刻をそのまま使う */
export function alignGrokScriptToWhisperTimeline(
  whisperTimeline: string,
  grokScript: string
): string {
  const canon = parseBracketTimelineText(whisperTimeline);
  if (!canon.length) return grokScript;
  const grokTexts = extractDialogueTextsFromGrokScript(grokScript);
  if (!grokTexts.length) return grokScript;
  if (grokTexts.length === canon.length) {
    return mergeTranslationsIntoWhisperTimeline(whisperTimeline, grokTexts);
  }
  const translations = canon.map((row, i) =>
    i < grokTexts.length ? grokTexts[i] : row.text
  );
  return mergeTranslationsIntoWhisperTimeline(whisperTimeline, translations);
}

function normalizeForMatch(t: string): string {
  return String(t || "")
    .replace(/[\s、。，,.!?！？「」『』"']/g, "")
    .toLowerCase();
}

export type AssignRangeInput = {
  start: number;
  end: number;
  speakerIndex: number;
  /** UI で割り当てたセリフ本文（オフセットずれ防止） */
  text?: string;
  /** フロントで Whisper から確定した発話開始（秒） */
  startSec?: number;
  /** フロントで Whisper から確定した発話終了（秒） */
  endSec?: number;
};

const SILENCE_GAP_LINE_SEC = 2.0;
const SILENCE_GAP_BLOCK_SEC = 10.0;

function compactNeedle(text: string): string {
  return String(text || "").replace(/\s+/g, "");
}

function compactJa(text: string): string {
  return String(text || "").replace(/[\s\u3000、。！？!?,.]/g, "");
}

function segEndSec(seg: WhisperSeg): number {
  return seg.end > seg.start ? seg.end : seg.start + 0.35;
}

function whisperTextOverlapScore(
  needleCompact: string,
  haystackCompact: string
): number {
  const n = String(needleCompact || "");
  const h = String(haystackCompact || "");
  if (!n || !h) return 0;
  if (h.includes(n)) return n.length / Math.max(h.length, 1);
  if (n.includes(h)) return (h.length / Math.max(n.length, 1)) * 0.95;
  const maxProbe = Math.min(n.length, 24);
  for (let len = maxProbe; len >= 4; len--) {
    const probe = n.slice(0, len);
    if (h.includes(probe)) return (len / n.length) * 0.9;
  }
  return 0;
}

type WhisperTextMatch = {
  fromIdx: number;
  toIdx: number;
  score: number;
  startSec: number;
  endSec: number;
};

/** 台詞テキストを Whisper セグメント列上で順番にマッチ */
function matchTextToWhisperSegments(
  text: string,
  segments: WhisperSeg[],
  fromSegIdx = 0
): WhisperTextMatch | null {
  const needle = compactJa(text);
  const list = normalizeWhisperSegmentsForAssign(segments);
  if (!needle || !list.length) return null;

  const maxLookahead = Math.min(
    list.length,
    Math.max(32, Math.ceil(needle.length / 6))
  );
  let best: WhisperTextMatch | null = null;
  const startAt = Math.max(0, Math.min(fromSegIdx, list.length - 1));

  for (let i = startAt; i < list.length; i++) {
    let compactJoined = "";
    for (let j = i; j < list.length && j < i + maxLookahead; j++) {
      compactJoined += compactJa(list[j].text);
      const score = whisperTextOverlapScore(needle, compactJoined);
      if (score <= 0) continue;

      const candidate: WhisperTextMatch = {
        fromIdx: i,
        toIdx: j,
        score,
        startSec: list[i].start,
        endSec: segEndSec(list[j]),
      };

      if (
        !best ||
        score > best.score + 0.03 ||
        (Math.abs(score - best.score) <= 0.03 &&
          candidate.toIdx - candidate.fromIdx <= best.toIdx - best.fromIdx)
      ) {
        best = candidate;
      }

      if (score >= 0.9 && compactJoined.includes(needle)) break;
    }
  }

  if (!best || best.score < 0.22) return null;
  return best;
}

/** 台詞テキストを Whisper ブラケットタイムライン行に順番にマッチ */
function matchTextToTimelineRows(
  text: string,
  rows: BracketTimelineRow[],
  fromRowIdx = 0
): WhisperTextMatch | null {
  const needle = compactJa(text);
  if (!needle || !rows.length) return null;

  const maxLookahead = Math.min(
    rows.length,
    Math.max(32, Math.ceil(needle.length / 6))
  );
  let best: WhisperTextMatch | null = null;
  const startAt = Math.max(0, Math.min(fromRowIdx, rows.length - 1));

  for (let i = startAt; i < rows.length; i++) {
    let compactJoined = "";
    for (let j = i; j < rows.length && j < i + maxLookahead; j++) {
      compactJoined += compactJa(rows[j].text);
      const score = whisperTextOverlapScore(needle, compactJoined);
      if (score <= 0) continue;

      const endSec =
        rows[j].endSec > rows[j].startSec
          ? rows[j].endSec
          : rows[j].startSec + 0.35;
      const candidate: WhisperTextMatch = {
        fromIdx: i,
        toIdx: j,
        score,
        startSec: rows[i].startSec,
        endSec,
      };

      if (
        !best ||
        score > best.score + 0.03 ||
        (Math.abs(score - best.score) <= 0.03 &&
          candidate.toIdx - candidate.fromIdx <= best.toIdx - best.fromIdx)
      ) {
        best = candidate;
      }

      if (score >= 0.9 && compactJoined.includes(needle)) break;
    }
  }

  if (!best || best.score < 0.22) return null;
  return best;
}

function isCompactAlignSkippable(ch: string): boolean {
  return /[\s\u3000、。！？!?,.]/.test(ch);
}

function mapPlainOffsetViaCompact(
  sourcePlain: string,
  targetPlain: string,
  sourceOffset: number
): number {
  const src = String(sourcePlain || "");
  const tgt = String(targetPlain || "");
  const o = Math.max(0, Math.min(sourceOffset, src.length));
  if (!tgt.length) return 0;
  if (src === tgt) return o;

  let compactGoal = 0;
  for (let i = 0; i < o; i++) {
    if (!isCompactAlignSkippable(src[i])) compactGoal++;
  }
  if (compactGoal <= 0) return 0;

  let compactSeen = 0;
  for (let j = 0; j < tgt.length; j++) {
    if (!isCompactAlignSkippable(tgt[j])) {
      compactSeen++;
      if (compactSeen > compactGoal) return j;
    }
  }
  return tgt.length;
}

type PreparedAssignRange = {
  range: AssignRangeInput;
  start: number;
  end: number;
  orderStart: number;
  speakerIndex: number;
  text: string;
};

function prepareAssignRangesForPipeline(
  assignRanges: AssignRangeInput[],
  transcriptPlain: string,
  segmentPlain: string,
  sliceText: (raw: string) => string
): PreparedAssignRange[] {
  return normalizeAssignRangeRows(assignRanges)
    .map(({ range, start, end, speakerIndex }) => {
      const fromTranscript = transcriptPlain.slice(start, end);
      const text = sliceText(String(range.text || "").trim() || fromTranscript);
      return {
        range,
        start: mapPlainOffsetViaCompact(transcriptPlain, segmentPlain, start),
        end: Math.max(
          mapPlainOffsetViaCompact(transcriptPlain, segmentPlain, end),
          mapPlainOffsetViaCompact(transcriptPlain, segmentPlain, start)
        ),
        orderStart: start,
        speakerIndex,
        text,
      };
    })
    .filter((r) => r.text && r.end >= r.start)
    .sort(
      (a, b) =>
        a.orderStart - b.orderStart ||
        a.start - b.start ||
        a.speakerIndex - b.speakerIndex
    );
}

function groupWhisperSegsByTimeGap(
  segs: WhisperSeg[],
  gapSec = SILENCE_GAP_LINE_SEC
): WhisperSeg[][] {
  if (!segs.length) return [];
  const groups: WhisperSeg[][] = [[segs[0]]];
  for (let i = 1; i < segs.length; i++) {
    const prev = groups[groups.length - 1];
    const gap = segs[i].start - segEndSec(prev[prev.length - 1]);
    if (gap >= gapSec - 0.05) groups.push([segs[i]]);
    else prev.push(segs[i]);
  }
  return groups;
}

function plainSliceForCompactSpan(
  text: string,
  compactStart: number,
  compactEnd: number
): string {
  const src = String(text || "");
  if (!src || compactEnd <= compactStart) return "";
  let cc = 0;
  let startPlain = 0;
  let endPlain = src.length;
  let started = false;
  for (let i = 0; i < src.length; i++) {
    if (/[\s\u3000、。！？!?,.]/.test(src[i])) continue;
    if (!started && cc >= compactStart) {
      startPlain = i;
      started = true;
    }
    if (started && cc >= compactEnd) {
      endPlain = i;
      break;
    }
    cc++;
  }
  return src.slice(startPlain, endPlain).trim();
}

function cuesFromAssignTextWithWhisperMatch(
  text: string,
  segments: WhisperSeg[],
  segCursor: number,
  timeAt: (offset: number) => number,
  plainStart: number,
  plainEnd: number
): { cues: BracketTimelineRow[]; nextSegCursor: number } {
  const trimmed = String(text || "").trim();
  if (!trimmed) return { cues: [], nextSegCursor: segCursor };

  const match = matchTextToWhisperSegments(trimmed, segments, segCursor);
  if (!match) {
    const t0 = timeAt(plainStart);
    const t1 = Math.max(timeAt(plainEnd), timeAt(Math.max(plainStart, plainEnd - 1)), t0 + 0.35);
    return {
      cues: [{ startSec: t0, endSec: t1, text: trimmed }],
      nextSegCursor: segCursor,
    };
  }

  const list = normalizeWhisperSegmentsForAssign(segments);
  const matchedSegs = list.slice(match.fromIdx, match.toIdx + 1);
  const groups = groupWhisperSegsByTimeGap(matchedSegs);
  if (groups.length >= 2) {
    const assignCompact = compactJa(trimmed);
    const pieces: BracketTimelineRow[] = [];
    let compactCursor = 0;
    for (const group of groups) {
      const groupCompact = compactJa(group.map((s) => s.text).join(""));
      if (!groupCompact.length) continue;
      const compactEnd = Math.min(
        assignCompact.length,
        compactCursor + groupCompact.length
      );
      const piece = plainSliceForCompactSpan(
        trimmed,
        compactCursor,
        compactEnd
      );
      compactCursor = compactEnd;
      if (!piece) continue;
      pieces.push({
        startSec: group[0].start,
        endSec: segEndSec(group[group.length - 1]),
        text: piece,
      });
    }
    if (pieces.length >= 2 && piecesCoverAssignText(pieces, trimmed)) {
      return { cues: pieces, nextSegCursor: match.toIdx + 1 };
    }
  }

  return {
    cues: [{ startSec: match.startSec, endSec: match.endSec, text: trimmed }],
    nextSegCursor: match.toIdx + 1,
  };
}

type AssignRangeCue = BracketTimelineRow & { speakerIndex: number };

function buildAssignRangeCuesInTranscriptOrder(
  plain: string,
  assignRanges: AssignRangeInput[],
  options: {
    whisperTimeline?: string;
    whisperSegments?: WhisperSeg[];
    durationSec?: number;
    timeAt?: (offset: number) => number;
    sliceText?: (raw: string) => string;
  } = {}
): AssignRangeCue[] {
  const transcriptPlain = String(plain || "");
  if (!transcriptPlain || !assignRanges.length) return [];

  const segments = normalizeWhisperSegmentsForAssign(options.whisperSegments);
  const segmentPlain = segments.map((s) => s.text).join("");
  const durationSec = Number(options.durationSec) || 0;
  const sliceText =
    typeof options.sliceText === "function"
      ? options.sliceText
      : cleanSpeakerPreviewSlice;
  const timingPlain = segmentPlain || transcriptPlain;
  const timeAt =
    typeof options.timeAt === "function"
      ? options.timeAt
      : defaultPlainTimeAt(timingPlain, segments, durationSec);

  const prepared = prepareAssignRangesForPipeline(
    assignRanges,
    transcriptPlain,
    timingPlain,
    sliceText
  );
  const timelineRows = options.whisperTimeline
    ? parseBracketTimelineText(options.whisperTimeline)
    : [];

  let rowCursor = 0;
  let segCursor = 0;
  const all: AssignRangeCue[] = [];

  for (let ri = 0; ri < prepared.length; ri++) {
    const { start, end, speakerIndex, text } = prepared[ri];
    if (!text) continue;

    let cues: BracketTimelineRow[] = [];

    if (timelineRows.length) {
      const tmatch = matchTextToTimelineRows(text, timelineRows, rowCursor);
      if (tmatch) {
        rowCursor = tmatch.toIdx + 1;
        segCursor = Math.max(segCursor, tmatch.toIdx + 1);
        cues = [{ startSec: tmatch.startSec, endSec: tmatch.endSec, text }];
      }
    }

    if (!cues.length) {
      const matched = cuesFromAssignTextWithWhisperMatch(
        text,
        segments,
        segCursor,
        timeAt,
        start,
        end
      );
      segCursor = matched.nextSegCursor;
      cues = matched.cues;
    }

    if (ri > 0 && cues.length && all.length) {
      const gap = cues[0].startSec - all[all.length - 1].endSec;
      if (gap >= SILENCE_GAP_BLOCK_SEC) cues[0].blockBreak = true;
    }
    for (const cue of cues) {
      all.push({ ...cue, speakerIndex });
    }
  }

  return all;
}

function normalizeWhisperSegmentsForAssign(raw: unknown): WhisperSeg[] {
  if (!Array.isArray(raw)) return [];
  const out: WhisperSeg[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const text = String((row as WhisperSeg).text || "").trim();
    if (!text) continue;
    const start = Math.max(0, Number((row as WhisperSeg).start) || 0);
    let end = Math.max(0, Number((row as WhisperSeg).end) || 0);
    if (!(end > start)) end = start + 0.35;
    out.push({ start, end, text });
  }
  return out;
}

function defaultPlainTimeAt(
  plain: string,
  segments: WhisperSeg[],
  durationSec: number
): (offset: number) => number {
  const total = Number(durationSec) > 0 ? Number(durationSec) : 1;
  const segJoined = segments.map((s) => s.text).join("");
  if (
    segments.length &&
    plain.length &&
    segJoined.length &&
    Math.abs(plain.length - segJoined.length) / Math.max(plain.length, 1) < 0.25
  ) {
    const bounds: {
      startChar: number;
      endChar: number;
      startSec: number;
      endSec: number;
    }[] = [];
    let cursor = 0;
    for (const seg of segments) {
      const len = seg.text.length;
      bounds.push({
        startChar: cursor,
        endChar: cursor + len,
        startSec: seg.start,
        endSec: seg.end
      });
      cursor += len;
    }
    return (offset) => {
      const o = Math.max(0, Math.min(offset, plain.length));
      const hit =
        bounds.find((b) => o >= b.startChar && o <= b.endChar) ||
        bounds[bounds.length - 1];
      if (!hit) return 0;
      const span = Math.max(1, hit.endChar - hit.startChar);
      return (
        hit.startSec +
        ((o - hit.startChar) / span) * (hit.endSec - hit.startSec)
      );
    };
  }
  return (offset) =>
    (Math.max(0, offset) / Math.max(plain.length, 1)) * total;
}

/** UI の cleanYtSpeakerPreviewSlice と同じ（話者別プレビュー表示と一致） */
export function cleanSpeakerPreviewSlice(text: string): string {
  let t = String(text || "");
  if (!t.trim()) return "";
  if (/---\s*WAVRICK_CAST\s*---/i.test(t)) return "";
  if (/^【[^】]*\/\s*声優:/.test(t)) return "";
  if (/^\{\s*"schemaVersion"/.test(t)) return "";
  t = t
    .replace(/---\s*WAVRICK_CAST\s*---[\s\S]*?---/gi, "")
    .replace(/^【[^】]*\/\s*声優:\s*[^】]*】\s*$/gim, "");
  return t.trim();
}

export function normalizePreviewTextForCompare(text: string): string {
  return String(text || "").replace(/\s/g, "");
}

export function collectSpeakerPreviewPartsFromRanges(
  plain: string,
  assignRanges: AssignRangeInput[],
  speakerIndex: number,
  sliceText: (raw: string) => string = cleanSpeakerPreviewSlice
): string[] {
  return assignRanges
    .filter((r) => Number(r.speakerIndex) === speakerIndex)
    .sort((a, b) => a.start - b.start)
    .map((r) => {
      const start = Math.max(0, Number(r.start) || 0);
      const end = Math.max(start, Number(r.end) || 0);
      return sliceText(plain.slice(start, end));
    })
    .filter(Boolean);
}

export function validateSpeakerPreviewScriptCoverage(
  previewParts: string[],
  cues: BracketTimelineRow[]
): {
  ok: boolean;
  reason?: string;
  expectedLen?: number;
  actualLen?: number;
  mismatchAt?: number;
} {
  const expected = normalizePreviewTextForCompare(previewParts.join(""));
  const actual = normalizePreviewTextForCompare(
    (cues || []).map((c) => c.text).join("")
  );
  if (!expected) return { ok: false, reason: "プレビューが空です" };
  if (expected === actual) {
    return { ok: true, expectedLen: expected.length, actualLen: actual.length };
  }
  let prefix = 0;
  while (
    prefix < expected.length &&
    prefix < actual.length &&
    expected[prefix] === actual[prefix]
  ) {
    prefix++;
  }
  return {
    ok: false,
    reason: "プレビューと台本キューの文字列が一致しません",
    expectedLen: expected.length,
    actualLen: actual.length,
    mismatchAt: prefix
  };
}

function buildSegmentCharBounds(
  plain: string,
  segments: WhisperSeg[]
): {
  startChar: number;
  endChar: number;
  startSec: number;
  endSec: number;
}[] | null {
  const segJoined = segments.map((s) => s.text).join("");
  if (
    !segments.length ||
    !plain.length ||
    !segJoined.length ||
    Math.abs(plain.length - segJoined.length) / Math.max(plain.length, 1) >= 0.25
  ) {
    return null;
  }
  const bounds: {
    startChar: number;
    endChar: number;
    startSec: number;
    endSec: number;
  }[] = [];
  let cursor = 0;
  for (const seg of segments) {
    const len = seg.text.length;
    bounds.push({
      startChar: cursor,
      endChar: cursor + len,
      startSec: seg.start,
      endSec: seg.end > seg.start ? seg.end : seg.start + 0.35
    });
    cursor += len;
  }
  return bounds;
}

function timingForCharSpan(
  timeAt: (offset: number) => number,
  startChar: number,
  endChar: number
): { startSec: number; endSec: number } {
  const cs = Math.max(0, startChar);
  const ce = Math.max(cs, endChar);
  const startSec = timeAt(cs);
  const endProbe = ce > cs ? Math.max(cs, ce - 1) : cs;
  let endSec = Math.max(timeAt(ce), timeAt(endProbe));
  if (endSec <= startSec) endSec = startSec + 0.35;
  return { startSec, endSec };
}

/** 重なるセグメントを発話ギャップ（2秒以上）でグループ化 */
function groupSegmentBoundsByTimeGap(
  bounds: {
    startChar: number;
    endChar: number;
    startSec: number;
    endSec: number;
  }[],
  gapSec = SILENCE_GAP_LINE_SEC
): {
  startChar: number;
  endChar: number;
  startSec: number;
  endSec: number;
}[][] {
  if (!bounds.length) return [];
  const groups: {
    startChar: number;
    endChar: number;
    startSec: number;
    endSec: number;
  }[][] = [];
  let cur: typeof bounds = [bounds[0]];

  for (let i = 1; i < bounds.length; i++) {
    const prev = cur[cur.length - 1];
    const next = bounds[i];
    const gap = next.startSec - prev.endSec;
    if (gap >= gapSec - 0.05) {
      groups.push(cur);
      cur = [next];
    } else {
      cur.push(next);
    }
  }
  if (cur.length) groups.push(cur);
  return groups;
}

function piecesCoverAssignText(
  pieces: BracketTimelineRow[],
  text: string
): boolean {
  const partsNorm = normalizePreviewTextForCompare(
    pieces.map((p) => p.text).join("")
  );
  const textNorm = normalizePreviewTextForCompare(text);
  if (!textNorm) return false;
  // 部分一致を許すと分割後テキスト欠落を見逃すため、完全一致のみ
  return partsNorm === textNorm;
}

/** 1 割り当て範囲 = プレビュー 1 パーツ（Whisper テキストマッチ優先・文字位置はフォールバック） */
function cuesFromAssignRangePreviewExact(
  range: { start: number; end: number },
  plain: string,
  timeAt: (offset: number) => number,
  segments: WhisperSeg[],
  sliceText: (raw: string) => string,
  segCursor = 0
): { cues: BracketTimelineRow[]; nextSegCursor: number } {
  const start = Math.max(0, Number(range.start) || 0);
  const end = Math.max(start, Number(range.end) || 0);
  const text = sliceText(plain.slice(start, end));
  if (!text) return { cues: [], nextSegCursor: segCursor };
  return cuesFromAssignTextWithWhisperMatch(
    text,
    segments,
    segCursor,
    timeAt,
    start,
    end
  );
}

/** 話者プレビュー（割り当て範囲）→ Whisper 時刻付きキュー（原語テキスト） */
export function buildTimedCuesBySpeakerFromAssignRanges(
  plain: string,
  assignRanges: AssignRangeInput[],
  speakerCount: number,
  options: {
    whisperTimeline?: string;
    whisperSegments?: WhisperSeg[];
    durationSec?: number;
    timeAt?: (offset: number) => number;
    sliceText?: (raw: string) => string;
  } = {}
): Record<string, BracketTimelineRow[]> {
  const ordered = buildAssignRangeCuesInTranscriptOrder(plain, assignRanges, options);
  const sliceText =
    typeof options.sliceText === "function"
      ? options.sliceText
      : cleanSpeakerPreviewSlice;
  const bySpeaker: Record<string, BracketTimelineRow[]> = {};

  for (const cue of ordered) {
    const key = String(cue.speakerIndex);
    if (!bySpeaker[key]) bySpeaker[key] = [];
    bySpeaker[key].push(cue);
  }

  const out: Record<string, BracketTimelineRow[]> = {};
  for (const [key, rows] of Object.entries(bySpeaker)) {
    const sorted = [...rows].sort(
      (a, b) => a.startSec - b.startSec || a.endSec - b.endSec
    );
    const speakerIndex = Number(key);
    const previewParts = assignRanges
      .filter((r) => Number(r.speakerIndex) === speakerIndex)
      .sort((a, b) => a.start - b.start)
      .map((r) =>
        sliceText(
          plain.slice(
            Math.max(0, Number(r.start) || 0),
            Math.max(0, Number(r.end) || 0)
          )
        )
      )
      .filter(Boolean);
    const check = validateSpeakerPreviewScriptCoverage(previewParts, sorted);
    if (!check.ok) {
      console.warn(
        `[wavrick] 話者${speakerIndex} プレビューと台本キューが一致しません`,
        check
      );
    }
    out[key] = sorted;
  }
  return out;
}

export type ChronologicalCue = BracketTimelineRow & {
  speakerIndex: number;
  speakerLabel?: string;
};

function findSpeakerForTimelineText(
  rowText: string,
  speakers: { id: number; label: string; lines: string[] }[]
): { id: number; label: string } | null {
  const ct = normalizeForMatch(rowText);
  if (!ct) return null;
  const sorted = [...speakers].sort((a, b) => a.id - b.id);
  for (const s of sorted) {
    const blob = normalizeForMatch(s.lines.join(""));
    if (!blob) continue;
    const matched =
      blob.includes(ct) ||
      ct.includes(blob.slice(0, Math.min(48, blob.length))) ||
      (ct.slice(0, 24).length >= 8 && blob.includes(ct.slice(0, 24)));
    if (matched) {
      return {
        id: s.id,
        label: (s.label && String(s.label).trim()) || `話者${s.id}`
      };
    }
  }
  return null;
}

/** 割り当て範囲から処理対象の話者 ID 一覧（1..N 連番前提をやめる） */
function resolveSpeakerIndicesFromAssignRanges(
  assignRanges: AssignRangeInput[],
  speakerCount = 0
): number[] {
  const fromRanges = [
    ...new Set(
      assignRanges
        .map((r) => Number(r.speakerIndex))
        .filter((n) => Number.isFinite(n) && n >= 1)
    ),
  ].sort((a, b) => a - b);
  if (fromRanges.length) return fromRanges;
  const n = Number(speakerCount) || 0;
  if (n > 0) return Array.from({ length: n }, (_, i) => i + 1);
  return [];
}

function normalizeAssignRangeRows(
  assignRanges: AssignRangeInput[]
): {
  range: AssignRangeInput;
  start: number;
  end: number;
  speakerIndex: number;
}[] {
  return [...assignRanges]
    .map((r) => ({
      range: r,
      start: Math.max(0, Number(r.start) || 0),
      end: Math.max(0, Number(r.end) || 0),
      speakerIndex: Number(r.speakerIndex) || 0,
    }))
    .filter((r) => r.end > r.start && r.speakerIndex >= 1)
    .sort(
      (a, b) =>
        a.start - b.start ||
        a.end - b.end ||
        a.speakerIndex - b.speakerIndex
    );
}
/** 全話者の割当範囲を文字起こし上の順序で 1 本の時系列キューに並べる */
export function buildChronologicalTimedCuesFromAssignRanges(
  plain: string,
  assignRanges: AssignRangeInput[],
  speakerCount: number,
  speakers: { id: number; label: string }[],
  options: {
    whisperTimeline?: string;
    whisperSegments?: WhisperSeg[];
    durationSec?: number;
    timeAt?: (offset: number) => number;
    sliceText?: (raw: string) => string;
  } = {}
): ChronologicalCue[] {
  const labelById = Object.fromEntries(
    speakers.map((s) => [
      s.id,
      (s.label && String(s.label).trim()) || `話者${s.id}`,
    ])
  );

  return buildAssignRangeCuesInTranscriptOrder(plain, assignRanges, options).map(
    (cue) => ({
      ...cue,
      speakerLabel: labelById[cue.speakerIndex] || `話者${cue.speakerIndex}`,
    })
  );
}

export function chronologicalCuesToScript(cues: ChronologicalCue[]): string {
  if (!cues.length) return "";
  const lines: string[] = [];
  for (let i = 0; i < cues.length; i++) {
    const row = cues[i];
    if (i > 0) {
      if (row.blockBreak) lines.push(NEW_BLOCK_MARKER);
      else {
        const gap = row.startSec - cues[i - 1].endSec;
        if (gap >= SILENCE_GAP_BLOCK_SEC) lines.push(NEW_BLOCK_MARKER);
        else if (gap >= SILENCE_GAP_LINE_SEC) lines.push(LINE_GAP_MARKER);
      }
    }
    const label = row.speakerLabel || `話者${row.speakerIndex}`;
    const end = row.endSec > row.startSec ? row.endSec : row.startSec + 0.35;
    lines.push(
      `[${formatBracketTimecode(row.startSec)} - ${formatBracketTimecode(end)}] (${label}) ${row.text}`
    );
  }
  return lines.join("\n");
}

export function scriptsBySpeakerFromChronologicalCues(
  cues: ChronologicalCue[]
): Record<string, string> {
  const bySpeaker: Record<string, ChronologicalCue[]> = {};
  for (const cue of cues) {
    const key = String(cue.speakerIndex);
    if (!bySpeaker[key]) bySpeaker[key] = [];
    bySpeaker[key].push(cue);
  }
  const out: Record<string, string> = {};
  for (const [key, rows] of Object.entries(bySpeaker)) {
    const sorted = [...rows].sort(
      (a, b) => a.startSec - b.startSec || a.endSec - b.endSec
    );
    out[key] = speakerScriptWithGapMarkers(sorted);
  }
  return out;
}

/** Whisper タイムライン行を時系列のまま話者ラベル付き台本にする */
export function buildChronologicalScriptFromWhisperTimeline(
  whisperTimeline: string,
  speakers: { id: number; label: string; lines: string[] }[],
  translatedLines?: string[]
): string {
  const canon = parseBracketTimelineText(whisperTimeline);
  if (!canon.length) return "";

  const translations =
    Array.isArray(translatedLines) && translatedLines.length === canon.length
      ? translatedLines.map((l) => String(l ?? "").trim())
      : canon.map((row) => row.text);

  const cues: ChronologicalCue[] = [];
  canon.forEach((row, i) => {
    const text = translations[i]?.trim() || row.text;
    const sp = findSpeakerForTimelineText(row.text, speakers);
    if (!sp) return;
    cues.push({
      ...row,
      text,
      speakerIndex: sp.id,
      speakerLabel: sp.label
    });
  });
  return chronologicalCuesToScript(cues);
}

export function timedCuesToSpeakerScript(cues: BracketTimelineRow[]): string {
  return speakerScriptWithGapMarkers(cues);
}

/** 話者割り当て範囲を上から順にそのまま台本化（欠落なし） */
export function buildScriptsBySpeakerFromAssignRanges(
  _whisperTimeline: string,
  plain: string,
  assignRanges: AssignRangeInput[],
  speakerCount: number,
  options: {
    whisperSegments?: WhisperSeg[];
    durationSec?: number;
    timeAt?: (offset: number) => number;
    sliceText?: (raw: string) => string;
    /** 話者プレビュー各行の日本語訳（キュー数と同じ長さ） */
    translatedLines?: string[];
  } = {}
): Record<string, string> {
  const cuesBySpeaker = buildTimedCuesBySpeakerFromAssignRanges(
    plain,
    assignRanges,
    speakerCount,
    options
  );
  const out: Record<string, string> = {};
  for (const [key, cues] of Object.entries(cuesBySpeaker)) {
    let rows = cues;
    const tr = options.translatedLines;
    if (Array.isArray(tr) && tr.length === cues.length) {
      rows = applyTranslationsToTimedCues(cues, tr);
    }
    out[key] = timedCuesToSpeakerScript(rows);
  }
  return out;
}

export function speakerScriptWithGapMarkers(rows: BracketTimelineRow[]): string {
  if (!rows.length) return "";
  const lines: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].blockBreak && i > 0) lines.push(NEW_BLOCK_MARKER);
    else if (i > 0) {
      const gap = rows[i].startSec - rows[i - 1].endSec;
      if (gap >= SILENCE_GAP_BLOCK_SEC) lines.push(NEW_BLOCK_MARKER);
      else if (gap >= SILENCE_GAP_LINE_SEC) lines.push(LINE_GAP_MARKER);
    }
    lines.push(formatBracketTimelineRow(rows[i]));
  }
  return lines.join("\n");
}

export function buildScriptsBySpeakerFromWhisperTimeline(
  whisperTimeline: string,
  speakers: { id: number; lines: string[] }[],
  translatedLines?: string[],
  assignOpts?: {
    plain?: string;
    ranges?: AssignRangeInput[];
    speakerCount?: number;
    whisperSegments?: WhisperSeg[];
    durationSec?: number;
    timeAt?: (offset: number) => number;
    translatedLines?: string[];
  } | null
): Record<string, string> {
  const count =
    Number(assignOpts?.speakerCount) ||
    Math.max(0, ...speakers.map((s) => s.id));
  if (assignOpts?.plain && assignOpts.ranges?.length && count > 0) {
    return buildScriptsBySpeakerFromAssignRanges(
      whisperTimeline,
      assignOpts.plain,
      assignOpts.ranges,
      count,
      {
        whisperSegments: assignOpts.whisperSegments,
        durationSec: assignOpts.durationSec,
        timeAt: assignOpts.timeAt,
        translatedLines: assignOpts.translatedLines
      }
    );
  }

  const canon = parseBracketTimelineText(whisperTimeline);
  const out: Record<string, string> = {};
  if (!canon.length) return out;

  const translations =
    Array.isArray(translatedLines) && translatedLines.length === canon.length
      ? translatedLines.map((l) => String(l ?? "").trim())
      : canon.map((row) => row.text);

  for (const s of speakers) {
    const key = String(s.id);
    const blob = normalizeForMatch(s.lines.join(""));
    const rows: BracketTimelineRow[] = [];
    canon.forEach((row, i) => {
      const ct = normalizeForMatch(row.text);
      if (!ct) return;
      const matched =
        blob.includes(ct) ||
        ct.includes(blob.slice(0, Math.min(48, blob.length))) ||
        (ct.slice(0, 24).length >= 8 && blob.includes(ct.slice(0, 24)));
      if (!matched) return;
      const dub = translations[i]?.trim();
      rows.push({ ...row, text: dub || row.text });
    });
    out[key] = speakerScriptWithGapMarkers(rows);
  }
  return out;
}

/** Grok には吹替文のみ返させる（タイムコードはサーバーで Whisper から付与） */
export const GROK_TRANSLATE_LINES_SYSTEM = `あなたはプロの映像翻訳・吹替台本ライターです。
入力は WhisperX で確定したタイムコード付き書き起こし（英語・韓国語・中国語など原語のことが多い）です。
【厳守】
- 出力にタイムコード [mm:ss.xx] を一切含めない
- 入力の行数と順序を変えない（統合・分割・入れ替え禁止）
- 話者ごとにまとめ直さない。動画の頭から末尾まで、入力と同じ時系列順のまま 1 行ずつ翻訳する
- lines の各要素は必ず日本語の吹替セリフのみ（です・ます調。希望トーンがあればそれに合わせる）
- 入力が外国語でも必ず日本語に翻訳・意訳して吹替する。原語のまま返すことは禁止（固有名詞・記号・効果音のみの行を除く）
- 意味不明な行は空文字 "" にする`;

/**
 * Whisper セグメントを無音マージせず 1 行 1 区間のブラケットタイムラインにする（Grok 投入用・Whisper SRT 区間に準拠）
 */
export function whisperSegmentsToFlatBracketTimelineText(
  segments: WhisperSeg[],
  durationSec = 0
): string {
  return buildFlatBracketTimelineFromWhisperSegments(segments, durationSec);
}

/**
 * Whisper → 2秒/10秒ルール適用済みブラケットタイムライン（レガシー・未使用に近いが export 維持）
 */
export function whisperSegmentsToBracketTimelineText(
  segments: WhisperSeg[],
  durationSec = 0
): string {
  const hasBlock = segments.some(
    (s) => (s as LegacyWhisperSegment).blockBreak === true
  );
  if (hasBlock) {
    return buildBracketTimelineFromTimelineSegments(segments as LegacyWhisperSegment[]);
  }
  return buildBracketTimelineFromWhisperSegments(segments, durationSec);
}

/**
 * Grok へ渡すタイムコード制御の system プロンプト
 * 入力は Whisper 由来の 1 行 1 区間のタイムライン。吹替のみ行い、時刻の変更はしない。
 */
export const GROK_TIMECODE_SYSTEM_PROMPT = GROK_TRANSLATE_LINES_SYSTEM;

export function normalizeWhisperSegsForGrok(
  raw: unknown
): WhisperSeg[] {
  if (!Array.isArray(raw)) return [];
  const out: WhisperSeg[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const text = typeof r.text === "string" ? r.text.trim() : "";
    if (!text) continue;
    const start = Math.max(0, Number(r.start) || 0);
    let end = Math.max(0, Number(r.end) || 0);
    if (!(end > start)) end = start + 0.35;
    out.push({ start, end, text });
  }
  out.sort((a, b) => a.start - b.start || a.end - b.end);
  return out;
}

/** 話者割り当てを Grok 用プレーンテキストにする（JSON 廃止） */
export function speakerAssignmentsToPlainText(
  speakers: { id: number; label: string; lines: string[] }[]
): string {
  const parts: string[] = ["【話者と元セリフの割当】"];
  for (const s of speakers) {
    parts.push("");
    parts.push(`話者${s.id}（${s.label}）:`);
    for (const line of s.lines) {
      const t = String(line || "").trim();
      if (t) parts.push(`- ${t}`);
    }
  }
  return parts.join("\n").trim();
}
