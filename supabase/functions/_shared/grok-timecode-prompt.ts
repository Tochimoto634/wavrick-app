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
};

const SILENCE_GAP_LINE_SEC = 2.0;
const SILENCE_GAP_BLOCK_SEC = 10.0;

function compactNeedle(text: string): string {
  return String(text || "").replace(/\s+/g, "");
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

/** 1 割り当て範囲 = プレビュー 1 パーツ。Whisper 細分割は文字位置が一致するときだけ */
function cuesFromAssignRangePreviewExact(
  range: { start: number; end: number },
  plain: string,
  timeAt: (offset: number) => number,
  segments: WhisperSeg[],
  sliceText: (raw: string) => string
): BracketTimelineRow[] {
  const start = Math.max(0, Number(range.start) || 0);
  const end = Math.max(start, Number(range.end) || 0);
  const text = sliceText(plain.slice(start, end));
  if (!text) return [];

  const t0 = timeAt(start);
  const t1 = Math.max(timeAt(end), t0 + 0.35);
  const bounds = buildSegmentCharBounds(plain, segments);
  if (bounds) {
    const overlapping = bounds.filter(
      (b) => b.endChar > start && b.startChar < end
    );
    if (overlapping.length >= 2) {
      const pieces: BracketTimelineRow[] = [];
      for (const b of overlapping) {
        const cs = Math.max(start, b.startChar);
        const ce = Math.min(end, b.endChar);
        if (ce <= cs) continue;
        const piece = sliceText(plain.slice(cs, ce));
        if (!piece) continue;
        pieces.push({
          startSec: b.startSec,
          endSec: b.endSec,
          text: piece
        });
      }
      const partsNorm = normalizePreviewTextForCompare(
        pieces.map((p) => p.text).join("")
      );
      const textNorm = normalizePreviewTextForCompare(text);
      if (pieces.length >= 2 && partsNorm === textNorm) {
        return pieces;
      }
    }
  }

  return [{ startSec: t0, endSec: t1, text }];
}

/** 話者プレビュー（割り当て範囲）→ Whisper 時刻付きキュー（原語テキスト） */
export function buildTimedCuesBySpeakerFromAssignRanges(
  plain: string,
  assignRanges: AssignRangeInput[],
  speakerCount: number,
  options: {
    whisperSegments?: WhisperSeg[];
    durationSec?: number;
    timeAt?: (offset: number) => number;
    sliceText?: (raw: string) => string;
  } = {}
): Record<string, BracketTimelineRow[]> {
  const out: Record<string, BracketTimelineRow[]> = {};
  const p = String(plain || "");
  if (!p || !assignRanges.length || speakerCount < 1) return out;

  const segments = normalizeWhisperSegmentsForAssign(options.whisperSegments);
  const durationSec = Number(options.durationSec) || 0;
  const timeAt =
    typeof options.timeAt === "function"
      ? options.timeAt
      : defaultPlainTimeAt(p, segments, durationSec);
  const sliceText =
    typeof options.sliceText === "function"
      ? options.sliceText
      : cleanSpeakerPreviewSlice;

  for (let sp = 1; sp <= speakerCount; sp++) {
    const ranges = assignRanges
      .filter((r) => Number(r.speakerIndex) === sp)
      .map((r) => ({
        start: Math.max(0, Number(r.start) || 0),
        end: Math.max(0, Number(r.end) || 0)
      }))
      .filter((r) => r.end > r.start)
      .sort((a, b) => a.start - b.start);

    const allCues: BracketTimelineRow[] = [];
    for (let ri = 0; ri < ranges.length; ri++) {
      const rangeCues = cuesFromAssignRangePreviewExact(
        ranges[ri],
        p,
        timeAt,
        segments,
        sliceText
      );
      if (ri > 0 && rangeCues.length && allCues.length) {
        const gap = rangeCues[0].startSec - allCues[allCues.length - 1].endSec;
        if (gap >= SILENCE_GAP_BLOCK_SEC) rangeCues[0].blockBreak = true;
      }
      allCues.push(...rangeCues);
    }
    if (allCues.length) {
      const previewParts = ranges
        .map((rng) => sliceText(p.slice(rng.start, rng.end)))
        .filter(Boolean);
      const check = validateSpeakerPreviewScriptCoverage(previewParts, allCues);
      if (!check.ok) {
        console.warn(
          `[wavrick] 話者${sp} プレビューと台本キューが一致しません`,
          check
        );
      }
      out[String(sp)] = allCues;
    }
  }
  return out;
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
