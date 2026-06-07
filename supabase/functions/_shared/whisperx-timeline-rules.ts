/**
 * WhisperX 単語タイムスタンプ → 2秒/10秒 台本分割（Deno / Edge 共有）
 *
 * Pass 1: words → speech spans（ケツは単語間 gap ≥2s または ffmpeg silenceGaps）
 * Pass 2: spans 間ブランクで行分割（収録ブースの台本もこの区切りを流用）
 *   - gap < 2s: 連結（同一タイムコード行・同じセリフ）
 *   - 2s ≤ gap < 10s: 改行（同じ台本内の別行＝概念上の "/" 区切り・新タイムコード）
 *   - gap ≥ 10s: [NEW_BLOCK]（次の台本）
 */

export type AlignWord = { word: string; start: number; end: number };

export type SilenceGap = { start: number; end: number; duration?: number };

export type SpeechSpan = { startSec: number; endSec: number; text: string };

export type TimelineCue = SpeechSpan & { blockBreak?: boolean };

/** @deprecated 互換: 旧 whisperSegments 名 */
export type WhisperSeg = { start: number; end: number; text: string };

export const SILENCE_GAP_LINE_MIN_SEC = 2.0;
export const SILENCE_GAP_BLOCK_MIN_SEC = 10.0;
/** 発話終了（ケツ）確定: 単語間または波形上でこの秒数以上の無音 */
export const SILENCE_END_LOCK_SEC = 2.0;
export const INVALID_SEGMENT_END_FALLBACK_SEC = 0.35;
export const NEW_BLOCK_MARKER = "[NEW_BLOCK]";
/** 同一台本内の 2〜10秒ギャップ区切り。WhisperX 書き起こし表示のみに出す（台本パースで除去）。 */
export const LINE_GAP_MARKER = "/";

/** 叫び・ノイズ時の Whisper ループ幻覚を表示用に抑える（同一フレーズの連続上限） */
export const MAX_CONSECUTIVE_PHRASE_REPEAT = 2;

function normalizeAlignToken(word: string): string {
  return String(word || "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

/**
 * align 単語列の連続重複を 1 語にまとめる（タイムスタンプは最後の end まで伸ばす）。
 * WhisperX が叫び声を同じ語で長く塗りつぶすときの対策。
 */
export function dedupeConsecutiveAlignWords(words: AlignWord[]): AlignWord[] {
  if (words.length < 2) return words;
  const out: AlignWord[] = [{ ...words[0] }];
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    const prev = out[out.length - 1];
    if (normalizeAlignToken(prev.word) === normalizeAlignToken(w.word)) {
      prev.end = safeEnd(prev.start, Math.max(prev.end, w.end));
      continue;
    }
    out.push({ ...w });
  }
  return out;
}

/** セリフ本文の同一フレーズ連続（やめてやめて… / word word word…）を上限回数に抑える */
export function collapseExcessiveTextRepetition(
  text: string,
  maxRun = MAX_CONSECUTIVE_PHRASE_REPEAT
): string {
  let t = String(text || "").trim();
  if (!t || maxRun < 1) return t;

  if (/\s/.test(t)) {
    const parts = t.split(/\s+/).filter(Boolean);
    const out: string[] = [];
    let run = 0;
    let prev = "";
    for (const p of parts) {
      const norm = normalizeAlignToken(p);
      if (norm && norm === prev) {
        run += 1;
        if (run <= maxRun) out.push(p);
      } else {
        prev = norm;
        run = 1;
        out.push(p);
      }
    }
    t = out.join(" ");
  }

  const maxLen = Math.min(16, Math.floor(t.length / (maxRun + 1)));
  for (let len = maxLen; len >= 1; len--) {
    const re = new RegExp(`(.{${len}})(?:\\1){${maxRun},}`, "gu");
    t = t.replace(re, (_m, unit: string) => unit.repeat(maxRun));
  }
  return t.trim();
}

/** 叫び・幻覚ループっぽい rough セグメント（長時間＋同じ音の繰り返し） */
export function isLikelyScreamHallucination(text: string, durationSec: number): boolean {
  const t = String(text || "").replace(/\s+/g, "");
  if (!t) return false;
  const dur = Math.max(0, Number(durationSec) || 0);
  if (dur >= 22) return true;
  if (dur < 6) return false;
  const chars = [...t];
  const unique = new Set(chars).size;
  const diversity = unique / Math.max(chars.length, 1);
  if (dur >= 10 && chars.length >= 10 && diversity < 0.32) return true;
  const once = collapseExcessiveTextRepetition(t, 1);
  if (dur >= 8 && t.length >= 16 && once.length <= Math.max(6, t.length * 0.28)) return true;
  return false;
}

function roughSegmentsNeedWordLevelFallback(rough: WhisperSeg[]): boolean {
  return rough.some((s) => isLikelyScreamHallucination(s.text, s.end - s.start));
}

export function formatBracketTimecode(seconds: number): string {
  const s = Math.max(0, Number(seconds) || 0);
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  const whole = Math.floor(sec);
  const cs = Math.round((sec - whole) * 100);
  return `${String(m).padStart(2, "0")}:${String(whole).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function hasCjkChar(s: string): boolean {
  return /[\u3040-\u30ff\u3400-\u9fff]/.test(s);
}

function joinWordTexts(parts: string[]): string {
  const rows = (parts || []).map((p) => String(p || "").trim()).filter(Boolean);
  if (!rows.length) return "";
  const mostlySingle = rows.filter((r) => r.length <= 1).length / rows.length > 0.7;
  const cjkHeavy = rows.filter((r) => hasCjkChar(r)).length / rows.length > 0.5;
  if (mostlySingle && cjkHeavy) return rows.join("");
  return rows.join(" ").replace(/\s+/g, " ").trim();
}

function safeEnd(startSec: number, endSec: number): number {
  const start = Math.max(0, Number(startSec) || 0);
  let end = Math.max(0, Number(endSec) || 0);
  if (!(end > start)) end = start + INVALID_SEGMENT_END_FALLBACK_SEC;
  return end;
}

export function normalizeAlignWords(raw: unknown): AlignWord[] {
  if (!Array.isArray(raw)) return [];
  const out: AlignWord[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const word = typeof r.word === "string" ? r.word.trim() : "";
    if (!word) continue;
    const start = Math.max(0, Number(r.start) || 0);
    let end = Math.max(0, Number(r.end) || 0);
    if (!(end > start)) end = start + INVALID_SEGMENT_END_FALLBACK_SEC;
    out.push({ word, start, end });
  }
  out.sort((a, b) => a.start - b.start || a.end - b.end);
  return dedupeConsecutiveAlignWords(out);
}

function clampWordsToDuration(words: AlignWord[], durationSec: number): AlignWord[] {
  const maxT = Number(durationSec) > 0 ? Number(durationSec) : 0;
  if (!(maxT > 0)) return words;
  return words
    .filter((w) => w.start < maxT - 0.01)
    .map((w) => {
      const start = Math.max(0, Math.min(w.start, maxT));
      const end = safeEnd(start, Math.min(w.end, maxT));
      return { word: w.word, start, end };
    });
}

function normalizeSilenceGaps(raw: unknown): SilenceGap[] {
  if (!Array.isArray(raw)) return [];
  const out: SilenceGap[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const start = Math.max(0, Number(r.start) || 0);
    const end = Math.max(0, Number(r.end) || 0);
    const duration =
      Number(r.duration) > 0 ? Number(r.duration) : Math.max(0, end - start);
    if (duration < SILENCE_GAP_LINE_MIN_SEC - 0.01) continue;
    if (end <= start) continue;
    out.push({ start, end, duration });
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

/** 単語間に実際の無音区間が挟まっている（align 詰め時は forcedBreak に任せる） */
function silenceBetweenWords(t0: number, t1: number, silenceGaps: SilenceGap[]): boolean {
  if (t1 - t0 >= SILENCE_END_LOCK_SEC - 0.01) return false;
  return normalizeSilenceGaps(silenceGaps).some((sg) => {
    const dur = sg.duration ?? sg.end - sg.start;
    if (dur < SILENCE_END_LOCK_SEC - 0.01) return false;
    return sg.start >= t0 + 0.05 && sg.end <= t1 - 0.05;
  });
}

function segmentRowsForBreaks(
  aligned: WhisperSeg[],
  rough: WhisperSeg[] = []
): WhisperSeg[] {
  const roughRows = normalizeWhisperSegments(rough);
  if (roughRows.length >= 2) return roughRows;
  return normalizeWhisperSegments(aligned);
}

function wordIndexAfterSilence(
  words: AlignWord[],
  sg: SilenceGap,
  durationSec: number
): number {
  let wi = words.findIndex((w) => w.start >= sg.end - 0.08);
  if (wi > 0) return wi;

  const dur = durationSec > 0 ? durationSec : words.length ? words[words.length - 1].end : 0;
  if (dur > 0 && words.length >= 2) {
    const ratio = Math.max(0, Math.min(1, sg.end / dur));
    wi = Math.min(words.length - 1, Math.max(1, Math.round(ratio * words.length)));
    return wi;
  }

  let lastBefore = -1;
  for (let i = 0; i < words.length; i++) {
    if (words[i].end <= sg.start + 0.2) lastBefore = i;
  }
  if (lastBefore >= 0 && lastBefore + 1 < words.length) return lastBefore + 1;
  return -1;
}

/** 1語に「でも今」が入っているとき、align 単語を仮分割 */
function splitTokenAtDemoima(token: string): { left: string; right: string } | null {
  const t = String(token || "").replace(/\s+/g, "");
  const re = /((?:けれど)?でも)(今)/g;
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t)) !== null) last = m;
  if (!last) return null;
  const cut = last.index + last[1].length;
  const left = t.slice(0, cut);
  const right = t.slice(cut);
  if (!left || !right) return null;
  return { left, right };
}

/** でも｜今 は付近の無音（波形 / ffmpeg）を選ぶ */
function pickSilenceGapNearPhraseSplit(
  tokenStart: number,
  tokenEnd: number,
  silenceGaps: SilenceGap[]
): SilenceGap | null {
  const target = tokenStart + (tokenEnd - tokenStart) * 0.72;
  let best: SilenceGap | null = null;
  let bestDist = Infinity;
  for (const sg of normalizeSilenceGaps(silenceGaps)) {
    const dur = sg.duration ?? sg.end - sg.start;
    if (dur < SILENCE_END_LOCK_SEC - 0.01) continue;
    const center = (sg.start + sg.end) / 2;
    const d = Math.abs(center - target);
    if (d < bestDist) {
      bestDist = d;
      best = sg;
    }
  }
  return best;
}

function expandWordsAtPhraseBoundary(
  words: AlignWord[],
  silenceGaps: SilenceGap[] = []
): AlignWord[] {
  const out: AlignWord[] = [];
  for (const w of words) {
    const split = splitTokenAtDemoima(w.word);
    if (split) {
      const sg = pickSilenceGapNearPhraseSplit(w.start, w.end, silenceGaps);
      if (
        sg &&
        sg.start > w.start + 0.05 &&
        sg.end < w.end - 0.05 &&
        sg.end - sg.start >= SILENCE_GAP_LINE_MIN_SEC - 0.01
      ) {
        out.push({ word: split.left, start: w.start, end: sg.start });
        out.push({ word: split.right, start: sg.end, end: w.end });
        continue;
      }
      const t = String(w.word || "").replace(/\s+/g, "");
      const span = Math.max(w.end - w.start, 0.02);
      const ratio = split.left.length / Math.max(t.length, 1);
      const est = w.start + span * ratio;
      const half = SILENCE_GAP_LINE_MIN_SEC / 2;
      out.push({
        word: split.left,
        start: w.start,
        end: Math.max(w.start + 0.05, est - half)
      });
      out.push({
        word: split.right,
        start: Math.min(w.end - 0.05, est + half),
        end: w.end
      });
      continue;
    }
    out.push(w);
  }
  return out;
}

/** prev/next の境界付近にある実際の無音区間（ffmpeg / rough segment）を探す */
function silenceGapNearBoundary(
  prev: TimelineCue,
  next: TimelineCue,
  silenceGaps: SilenceGap[],
  roughSegments: WhisperSeg[]
): { start: number; end: number } | null {
  // align が無音を詰めた結果、ケツ（prev.end）が次の頭（next.start）にぶつかっている。
  // その境界付近で「発話再開（無音の終わり）が next.start に最も近い」無音区間を選ぶ。
  const boundary = next.startSec;
  const lo = prev.startSec - 0.5;
  const hi = next.endSec + 0.5;

  type BoundaryGap = { start: number; end: number; dist: number };
  let best: BoundaryGap | null = null;
  const consider = (start: number, end: number) => {
    if (!(end - start >= SILENCE_GAP_LINE_MIN_SEC - 0.01)) return;
    if (end < lo || start > hi) return;
    const dist = Math.abs(end - boundary);
    if (best === null || dist < best.dist) best = { start, end, dist };
  };

  for (const sg of normalizeSilenceGaps(silenceGaps)) {
    consider(sg.start, sg.end);
  }
  const rough = normalizeWhisperSegments(roughSegments);
  for (let si = 1; si < rough.length; si++) {
    consider(rough[si - 1].end, rough[si].start);
  }
  const hit = best as BoundaryGap | null;
  return hit ? { start: hit.start, end: hit.end } : null;
}

/** 連続キューのケツ／頭を無音区間で離す（align 詰め・仮分割の補正） */
function resolveAdjacentCueBoundary(
  prev: TimelineCue,
  next: TimelineCue,
  silenceGaps: SilenceGap[],
  roughSegments: WhisperSeg[] = []
): { prevEnd: number; nextStart: number } | null {
  // 既に 2 秒以上離れていれば触れていない＝補正不要
  if (next.startSec - prev.endSec >= SILENCE_GAP_LINE_MIN_SEC - 0.05) {
    return null;
  }

  // 行が分かれている＝この境界には無音か明確な転換がある。
  // align が無音を詰めてケツが次の頭にぶつかっているので、実際の無音直前まで引き戻す。
  // 頭（next.start）は align の単語頭が正確なので動かさない。
  const gap = silenceGapNearBoundary(prev, next, silenceGaps, roughSegments);
  if (gap) {
    const prevEnd = Math.max(prev.startSec + 0.05, Math.min(gap.start, next.startSec));
    if (next.startSec > prevEnd) {
      return { prevEnd, nextStart: next.startSec };
    }
  }

  // 無音情報がない言い回しの転換（例: でも → 今）のフォールバック
  const prevSpan: SpeechSpan = {
    startSec: prev.startSec,
    endSec: prev.endSec,
    text: prev.text
  };
  const nextSpan: SpeechSpan = {
    startSec: next.startSec,
    endSec: next.endSec,
    text: next.text
  };
  if (phraseLineGap(prevSpan, nextSpan) != null) {
    const mid = prev.endSec;
    return {
      prevEnd: Math.max(prev.startSec + 0.05, mid),
      nextStart: mid + SILENCE_GAP_LINE_MIN_SEC
    };
  }

  return null;
}

/**
 * 最終ルール徹底（表示タイムコードのギャップ基準）。
 * - ギャップ < 2 秒 : 同じ台本・同じ行（結合）
 * - 2 秒以上 10 秒未満: 同じ台本・次の行
 * - 10 秒以上        : 別の台本（blockBreak）
 * align / rough segment が連続発話を誤って分割しても、ここで最終的に揃える。
 */
function enforceGapRules(cues: TimelineCue[]): TimelineCue[] {
  if (!cues.length) return cues;
  const out: TimelineCue[] = [{ ...cues[0], blockBreak: !!cues[0].blockBreak }];
  for (let i = 1; i < cues.length; i++) {
    const c = cues[i];
    const prev = out[out.length - 1];
    const gap = c.startSec - prev.endSec;
    if (gap < SILENCE_GAP_LINE_MIN_SEC - 0.01) {
      // 2 秒未満 → 同じ行に結合
      prev.text = joinWordTexts([prev.text, c.text]);
      prev.endSec = safeEnd(prev.startSec, Math.max(prev.endSec, c.endSec));
      continue;
    }
    out.push({ ...c, blockBreak: gap >= SILENCE_GAP_BLOCK_MIN_SEC });
  }
  return out;
}

function applySilenceBoundariesToCues(
  cues: TimelineCue[],
  silenceGaps: SilenceGap[] = [],
  roughSegments: WhisperSeg[] = []
): TimelineCue[] {
  if (cues.length < 2) return cues;
  const out = cues.map((c) => ({ ...c }));
  for (let i = 0; i < out.length - 1; i++) {
    const b = resolveAdjacentCueBoundary(out[i], out[i + 1], silenceGaps, roughSegments);
    if (!b) continue;
    out[i].endSec = safeEnd(out[i].startSec, b.prevEnd);
    out[i + 1].startSec = Math.max(b.nextStart, out[i].endSec + 0.01);
  }
  return out;
}

/** 台本の明確な転換（例: けれどでも → 今は）— 無音検出0件時のフォールバック */
function phraseBoundaryBreakBeforeWord(words: AlignWord[]): Set<number> {
  const breaks = new Set<number>();
  if (words.length < 2) return breaks;

  for (let i = 1; i < words.length; i++) {
    const left = words
      .slice(Math.max(0, i - 12), i)
      .map((w) => w.word)
      .join("")
      .replace(/\s+/g, "");
    const right = words
      .slice(i, Math.min(words.length, i + 6))
      .map((w) => w.word)
      .join("")
      .replace(/\s+/g, "");
    if (/(?:けれど)?でも$/.test(left) && /^今/.test(right)) {
      breaks.add(i);
    }
  }
  return breaks;
}

function phraseLineGap(prev: SpeechSpan, next: SpeechSpan): number | null {
  const left = prev.text.replace(/\s+/g, "");
  const right = next.text.replace(/\s+/g, "");
  if (/(?:けれど)?でも$/.test(left) && /^今/.test(right)) {
    return SILENCE_GAP_LINE_MIN_SEC;
  }
  return null;
}

/**
 * align が無音を詰めるとき、roughSegments / ffmpeg 無音の直前でスパンを切る。
 *
 * align は直前の単語末を次の発話開始まで伸ばすことがあるため、ブレーク位置だけでなく
 * 「発話が実際に終わった時刻（＝ケツ）」も返し、Pass 1 でスパン末尾を無音直前まで
 * 引き戻せるようにする。
 * 返り値: ブレークする単語 index -> その手前の発話終了秒
 */
function forcedSpanBreaksBeforeWord(
  words: AlignWord[],
  segments: WhisperSeg[],
  silenceGaps: SilenceGap[],
  roughSegments: WhisperSeg[] = [],
  durationSec = 0
): Map<number, number> {
  const breaks = new Map<number, number>();
  if (words.length < 2) return breaks;

  const register = (wi: number, speechEndSec: number) => {
    if (wi <= 0 || wi >= words.length) return;
    const wordStart = words[wi - 1]?.start ?? speechEndSec;
    const wordEnd = words[wi - 1]?.end ?? speechEndSec;
    // 実際のケツは無音直前。単語末より後ろには伸ばさず、単語頭より前にも縮めない。
    const realEnd = Math.min(wordEnd, Math.max(wordStart + 0.05, speechEndSec));
    const prev = breaks.get(wi);
    if (prev === undefined || realEnd < prev) breaks.set(wi, realEnd);
  };

  const segRows = segmentRowsForBreaks(segments, roughSegments);
  for (let si = 1; si < segRows.length; si++) {
    const gap = segRows[si].start - segRows[si - 1].end;
    if (gap < SILENCE_END_LOCK_SEC) continue;
    const wi = words.findIndex((w) => w.start >= segRows[si].start - 0.05);
    if (wi > 0) register(wi, segRows[si - 1].end);
  }

  for (const sg of normalizeSilenceGaps(silenceGaps)) {
    const dur = sg.duration ?? sg.end - sg.start;
    if (dur < SILENCE_END_LOCK_SEC - 0.01) continue;
    const wi = wordIndexAfterSilence(words, sg, durationSec);
    if (wi > 0) register(wi, sg.start);
  }

  for (const wi of phraseBoundaryBreakBeforeWord(words)) {
    // 無音情報がない言い回しの転換は、ケツを単語末のまま後段の境界補正に委ねる
    if (!breaks.has(wi)) register(wi, words[wi - 1]?.end ?? 0);
  }
  return breaks;
}

function spanGapSec(
  prev: SpeechSpan,
  next: SpeechSpan,
  silenceGaps: SilenceGap[],
  roughSegments: WhisperSeg[] = []
): number {
  const wordGap = next.startSec - prev.endSec;
  if (wordGap >= SILENCE_GAP_LINE_MIN_SEC - 0.01) return wordGap;
  for (const sg of normalizeSilenceGaps(silenceGaps)) {
    const dur = sg.duration ?? sg.end - sg.start;
    if (dur < SILENCE_GAP_LINE_MIN_SEC - 0.01) continue;
    if (next.startSec >= sg.end - 0.25 && prev.endSec <= sg.end + 0.5) return dur;
  }
  const rough = normalizeWhisperSegments(roughSegments);
  for (let si = 1; si < rough.length; si++) {
    const rgap = rough[si].start - rough[si - 1].end;
    if (rgap < SILENCE_GAP_LINE_MIN_SEC - 0.01) continue;
    if (prev.endSec >= rough[si - 1].start - 0.2 && next.startSec <= rough[si].end + 0.2) {
      return rgap;
    }
  }
  const phraseGap = phraseLineGap(prev, next);
  if (phraseGap != null) return phraseGap;
  return wordGap;
}

/** Pass 1: 単語列 → 発話スパン（ケツは 2秒以上の無音で確定） */
export function buildSpeechSpansFromAlignWords(
  words: AlignWord[],
  durationSec = 0,
  segments: WhisperSeg[] = [],
  silenceGaps: SilenceGap[] = [],
  roughSegments: WhisperSeg[] = []
): SpeechSpan[] {
  const expanded = expandWordsAtPhraseBoundary(
    normalizeAlignWords(words),
    silenceGaps
  );
  const rows = clampWordsToDuration(expanded, durationSec);
  if (!rows.length) return [];

  const forcedBreaks = forcedSpanBreaksBeforeWord(
    rows,
    segments,
    silenceGaps,
    roughSegments,
    durationSec
  );

  const spans: SpeechSpan[] = [];
  let batchStart = rows[0].start;
  let batchEnd = rows[0].end;
  const batchTexts: string[] = [rows[0].word];

  const flush = () => {
    const text = collapseExcessiveTextRepetition(joinWordTexts(batchTexts));
    if (!text) return;
    spans.push({
      startSec: batchStart,
      endSec: safeEnd(batchStart, batchEnd),
      text
    });
  };

  for (let i = 1; i < rows.length; i++) {
    const w = rows[i];
    const gap = w.start - batchEnd;
    const forcedEnd = forcedBreaks.get(i);
    const endLocked =
      forcedEnd !== undefined ||
      gap >= SILENCE_END_LOCK_SEC ||
      silenceBetweenWords(batchEnd, w.start, silenceGaps);

    if (endLocked) {
      // align が無音を詰めて単語末を次の発話まで伸ばしている場合、
      // スパン末尾（ケツ）を無音直前まで引き戻し、次行の頭にぶつからないようにする。
      if (forcedEnd !== undefined && forcedEnd > batchStart) {
        batchEnd = Math.min(batchEnd, forcedEnd);
      }
      flush();
      batchStart = w.start;
      batchEnd = w.end;
      batchTexts.length = 0;
      batchTexts.push(w.word);
      continue;
    }

    batchTexts.push(w.word);
    batchEnd = Math.max(batchEnd, w.end);
  }
  flush();
  return spans;
}

/** Pass 2: 発話スパン間ブランクで 2秒/10秒ルール */
export function buildTimelineCuesFromSpeechSpans(
  spans: SpeechSpan[],
  silenceGaps: SilenceGap[] = [],
  roughSegments: WhisperSeg[] = []
): TimelineCue[] {
  if (!spans.length) return [];

  const cues: TimelineCue[] = [];
  let batch = {
    startSec: spans[0].startSec,
    endSec: spans[0].endSec,
    texts: [spans[0].text]
  };
  let pendingBlockBreak = false;

  const flush = () => {
    const text = collapseExcessiveTextRepetition(joinWordTexts(batch.texts));
    if (!text) return;
    cues.push({
      startSec: batch.startSec,
      endSec: safeEnd(batch.startSec, batch.endSec),
      text,
      blockBreak: pendingBlockBreak
    });
    pendingBlockBreak = false;
  };

  for (let i = 1; i < spans.length; i++) {
    const next = spans[i];
    const gap = spanGapSec(
      {
        startSec: batch.startSec,
        endSec: batch.endSec,
        text: joinWordTexts(batch.texts)
      },
      next,
      silenceGaps,
      roughSegments
    );

    if (gap >= SILENCE_GAP_BLOCK_MIN_SEC) {
      flush();
      pendingBlockBreak = true;
      batch = { startSec: next.startSec, endSec: next.endSec, texts: [next.text] };
      continue;
    }

    if (gap >= SILENCE_GAP_LINE_MIN_SEC) {
      flush();
      batch = { startSec: next.startSec, endSec: next.endSec, texts: [next.text] };
      continue;
    }

    batch.texts.push(next.text);
    batch.endSec = Math.max(batch.endSec, next.endSec);
  }
  flush();
  return enforceGapRules(
    applySilenceBoundariesToCues(cues, silenceGaps, roughSegments)
  );
}

export function buildTimelineCuesFromAlignWords(
  words: AlignWord[],
  durationSec = 0,
  segments: WhisperSeg[] = [],
  silenceGaps: SilenceGap[] = [],
  roughSegments: WhisperSeg[] = []
): TimelineCue[] {
  const spans = buildSpeechSpansFromAlignWords(
    words,
    durationSec,
    segments,
    silenceGaps,
    roughSegments
  );
  if (!spans.length) return [];
  return buildTimelineCuesFromSpeechSpans(spans, silenceGaps, roughSegments);
}

/**
 * rough_segments（Whisper のネイティブ文単位セグメント）をそのまま行区切りとして cue に変換。
 * - gap < 0.1s  : 同一発話の続き → 結合
 * - 0.1s ≤ gap < 10s : 新しい行（Whisper が判断した文境界を優先）
 * - gap ≥ 10s   : blockBreak
 */
function buildCuesFromRoughSegments(roughRows: WhisperSeg[]): TimelineCue[] {
  if (!roughRows.length) return [];
  const cues: TimelineCue[] = [];
  let batch = { startSec: roughRows[0].start, endSec: roughRows[0].end, texts: [roughRows[0].text] };
  let pendingBlockBreak = false;

  const flush = () => {
    const text = collapseExcessiveTextRepetition(joinWordTexts(batch.texts));
    if (!text) return;
    cues.push({
      startSec: batch.startSec,
      endSec: safeEnd(batch.startSec, batch.endSec),
      text,
      blockBreak: pendingBlockBreak
    });
    pendingBlockBreak = false;
  };

  for (let i = 1; i < roughRows.length; i++) {
    const next = roughRows[i];
    const gap = next.start - batch.endSec;
    if (gap >= SILENCE_GAP_BLOCK_MIN_SEC) {
      flush();
      pendingBlockBreak = true;
      batch = { startSec: next.start, endSec: next.end, texts: [next.text] };
    } else if (gap < 0.1) {
      batch.texts.push(next.text);
      batch.endSec = Math.max(batch.endSec, next.end);
    } else {
      flush();
      batch = { startSec: next.start, endSec: next.end, texts: [next.text] };
    }
  }
  flush();
  return cues;
}

export function buildTimelineCuesFromWhisperX(
  words: AlignWord[],
  segments: WhisperSeg[],
  durationSec = 0,
  silenceGaps: SilenceGap[] = [],
  roughSegments: WhisperSeg[] = []
): TimelineCue[] {
  const rough = normalizeWhisperSegments(roughSegments);
  const wordRows = clampWordsToDuration(normalizeAlignWords(words), durationSec);
  // rough_segments が 2 行以上あれば通常は文単位の行区切りとして優先。
  // ただし叫び声などで 1 セグメントが長く幻覚ループすると、その間の台詞が rough から消える。
  // その場合は align 単語ベースにフォールバックする。
  if (rough.length >= 2 && !roughSegmentsNeedWordLevelFallback(rough)) {
    return buildCuesFromRoughSegments(rough);
  }
  if (wordRows.length) {
    return buildTimelineCuesFromAlignWords(
      wordRows,
      durationSec,
      segments,
      silenceGaps,
      roughSegments
    );
  }
  const segs = normalizeWhisperSegments(segments);
  if (segs.length >= 2) {
    return buildCuesFromRoughSegments(segs);
  }
  return buildTimelineCuesFromWhisperSegments(segments, durationSec);
}

export type LegacyWhisperSegment = WhisperSeg & { blockBreak?: boolean };

/** TimelineCue → API 互換 whisperSegments */
export function timelineCuesToLegacySegments(cues: TimelineCue[]): LegacyWhisperSegment[] {
  return cues.map((c) => ({
    start: c.startSec,
    end: c.endSec,
    text: c.text,
    ...(c.blockBreak ? { blockBreak: true } : {})
  }));
}

export function buildBracketTimelineFromAlignWords(
  words: AlignWord[],
  durationSec = 0,
  segments: WhisperSeg[] = [],
  silenceGaps: SilenceGap[] = [],
  roughSegments: WhisperSeg[] = []
): string {
  return bracketLinesFromCues(
    buildTimelineCuesFromAlignWords(
      words,
      durationSec,
      segments,
      silenceGaps,
      roughSegments
    )
  );
}

export function buildBracketTimelineFromWhisperX(
  words: AlignWord[],
  segments: WhisperSeg[],
  durationSec = 0,
  silenceGaps: SilenceGap[] = [],
  roughSegments: WhisperSeg[] = []
): string {
  return bracketLinesFromCues(
    buildTimelineCuesFromWhisperX(
      words,
      segments,
      durationSec,
      silenceGaps,
      roughSegments
    )
  );
}

// --- レガシー: セグメント単位（Whisper SRT 等）---

function normalizeWhisperSegments(segments: WhisperSeg[]): WhisperSeg[] {
  const out: WhisperSeg[] = [];
  for (const row of segments || []) {
    const text = collapseExcessiveTextRepetition(String(row.text || "").trim());
    if (!text) continue;
    const start = Math.max(0, Number(row.start) || 0);
    let end = Math.max(0, Number(row.end) || 0);
    if (!(end > start)) end = start + INVALID_SEGMENT_END_FALLBACK_SEC;
    out.push({ start, end, text });
  }
  out.sort((a, b) => a.start - b.start || a.end - b.end);
  return out;
}

/**
 * セグメント間 gap による 2秒/10秒（words が無い旧パス）
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
          .map((s) => ({
            start: Math.max(0, Math.min(s.start, maxT)),
            end: safeEnd(s.start, Math.min(s.end, maxT)),
            text: s.text
          }))
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
    const text = joinWordTexts(batch.texts);
    if (!text) return;
    cues.push({
      startSec: batch.startSec,
      endSec: safeEnd(batch.startSec, batch.endSec),
      text,
      blockBreak: pendingBlockBreak
    });
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

  // enforceGapRules は 2秒未満のギャップを再結合するため、
  // segments が既に文単位なら適用しない（= 返す前に再結合が起きると元の木阿弥になる）
  return cues;
}

function bracketLinesFromCues(cues: TimelineCue[]): string {
  const lines: string[] = [];
  let prevCue: TimelineCue | null = null;
  for (const cue of cues) {
    if (cue.blockBreak) {
      lines.push(NEW_BLOCK_MARKER);
    } else if (prevCue !== null) {
      // "/" は 2 秒以上のギャップのみ（同一台本内の間合い区切り表示用）
      const gap = cue.startSec - prevCue.endSec;
      if (gap >= SILENCE_GAP_LINE_MIN_SEC) {
        lines.push(LINE_GAP_MARKER);
      }
    }
    const end = safeEnd(cue.startSec, cue.endSec);
    lines.push(
      `[${formatBracketTimecode(cue.startSec)} - ${formatBracketTimecode(end)}] ${cue.text}`
    );
    prevCue = cue;
  }
  return lines.join("\n").trim();
}

export function buildBracketTimelineFromWhisperSegments(
  whisperSegments: WhisperSeg[],
  durationSec = 0
): string {
  return bracketLinesFromCues(
    buildTimelineCuesFromWhisperSegments(whisperSegments, durationSec)
  );
}

/** 2秒/10秒適用済みセグメントをそのままブラケット行に（Grok 投入用・再マージしない） */
export function buildBracketTimelineFromTimelineSegments(
  segments: LegacyWhisperSegment[]
): string {
  const lines: string[] = [];
  for (const s of segments) {
    if (s.blockBreak) lines.push(NEW_BLOCK_MARKER);
    const end = safeEnd(s.start, s.end);
    lines.push(
      `[${formatBracketTimecode(s.start)} - ${formatBracketTimecode(end)}] ${s.text}`
    );
  }
  return lines.join("\n").trim();
}
