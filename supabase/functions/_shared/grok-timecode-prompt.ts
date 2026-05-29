import { buildFlatBracketTimelineFromWhisperSegments } from "./whisper-timeline-rules.ts";
import {
  buildBracketTimelineFromTimelineSegments,
  buildBracketTimelineFromWhisperSegments,
  formatBracketTimecode,
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
  for (const line of t.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === NEW_BLOCK_MARKER) continue;
    let m = trimmed.match(BRACKET_LINE_RE);
    if (!m) m = trimmed.match(BRACKET_LINE_RE_FLEX);
    if (!m) continue;
    const startSec = parseBracketPart(m[1], m[2], m[3]);
    let endSec =
      m[4] != null ? parseBracketPart(m[4], m[5], m[6]) : startSec + 0.35;
    if (!(endSec > startSec)) endSec = startSec + 0.35;
    const text = String(m[7] || "").trim();
    if (!text) continue;
    rows.push({ startSec, endSec, text });
  }
  return rows;
}

export function formatBracketTimelineRow(row: BracketTimelineRow): string {
  const end = row.endSec > row.startSec ? row.endSec : row.startSec + 0.35;
  return `[${formatBracketTimecode(row.startSec)} - ${formatBracketTimecode(end)}] ${row.text}`;
}

export function mergeTranslationsIntoWhisperTimeline(
  whisperTimeline: string,
  translations: string[]
): string {
  const canon = parseBracketTimelineText(whisperTimeline);
  if (!canon.length) return stripWhisperTimelineMarker(whisperTimeline);
  const out = canon.map((row, i) => {
    const t = String(translations[i] ?? "").trim();
    return { ...row, text: t || row.text };
  });
  return out.map(formatBracketTimelineRow).join("\n");
}

export function extractDialogueTextsFromGrokScript(grokScript: string): string[] {
  const texts: string[] = [];
  for (const line of String(grokScript || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (
      !trimmed ||
      trimmed === NEW_BLOCK_MARKER ||
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

export function buildScriptsBySpeakerFromWhisperTimeline(
  whisperTimeline: string,
  speakers: { id: number; lines: string[] }[],
  translatedLines?: string[]
): Record<string, string> {
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
    out[key] = rows.length ? rows.map(formatBracketTimelineRow).join("\n") : "";
  }
  return out;
}

/** Grok には吹替文のみ返させる（タイムコードはサーバーで Whisper から付与） */
export const GROK_TRANSLATE_LINES_SYSTEM = `あなたはプロの吹替台本ライターです。
入力は WhisperX で確定したタイムコード付き書き起こしです。
【厳守】
- 出力にタイムコード [mm:ss.xx] を一切含めない
- 入力の行数と順序を変えない（統合・分割・入れ替え禁止）
- 各行のセリフ本文だけを自然な日本語吹替にする
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
