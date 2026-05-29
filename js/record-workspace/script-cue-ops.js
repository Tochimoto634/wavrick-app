/**
 * 台本行（収録 cue）の結合・分割 — 声優向け
 * - 結合後も segments に各タイムコード＋文言を保持（1収録・テロップ複数行）
 * - 収録済み Take 結合時は、台本タイムコードどおりの間隔だけ無音を挟む（省略しない）
 */

import {
  buildScriptLine,
  formatTimeRange,
  stableCueId,
  inferredLineEndSec,
  estimateSpeechDurationSec,
  AUTO_BLOCK_GAP_SEC,
  LINE_GAP_SPLIT_MIN_SEC
} from "./timecode.js?v=rw-tc-v4-2026-05-27";

export { AUTO_BLOCK_GAP_SEC, LINE_GAP_SPLIT_MIN_SEC };

/** タイムコード上ほぼ重なっているときの最小無音（秒） */
export const MIN_MERGE_GAP_SEC = 0.35;

/**
 * @typedef {object} ScriptSegment
 * @property {number} startSec
 * @property {number|null} [endSec]
 * @property {string} text
 * @property {string} rawTc
 * @property {string} [sourceLineId] 結合前の行 id
 */

/**
 * @typedef {import('./timecode.js').buildScriptLine extends (o: infer O) => infer R ? R : never} ScriptLine
 */

/**
 * @param {ScriptLine} line
 * @returns {ScriptSegment[]}
 */
export function getLineSegments(line) {
  if (Array.isArray(line.segments) && line.segments.length) {
    return line.segments.map((s) => ({
      startSec: s.startSec,
      endSec: s.endSec ?? null,
      text: String(s.text || "").trim(),
      rawTc: s.rawTc || formatTimeRange(s.startSec, s.endSec),
      sourceLineId: s.sourceLineId || null
    }));
  }
  return [
    {
      startSec: line.startSec,
      endSec: line.endSec ?? null,
      text: String(line.text || "").trim(),
      rawTc: line.rawTc || formatTimeRange(line.startSec, line.endSec),
      sourceLineId: line.id
    }
  ];
}

/**
 * テロップ用: 結合 cue でも行ごとにタイムコード付きで返す
 * @param {ScriptLine} line
 */
export function getTeleprompterRows(line) {
  return getLineSegments(line).map((seg, i) => ({
    index: i,
    startSec: seg.startSec,
    endSec: seg.endSec,
    text: seg.text,
    timeLabel: seg.rawTc.replace(/^\[|\]$/g, "").trim()
  }));
}

/**
 * @param {ScriptLine} line
 */
export function lineDisplayText(line) {
  return getLineSegments(line)
    .map((s) => s.text)
    .filter(Boolean)
    .join(" ");
}

/**
 * @param {ScriptLine[]} lines
 * @param {number[]} indices 昇順・連続した行インデックス
 */
export function mergeScriptLines(lines, indices) {
  const sorted = [...new Set(indices)]
    .filter((i) => i >= 0 && i < lines.length)
    .sort((a, b) => a - b);
  if (sorted.length < 2) {
    return { ok: false, message: "結合するには2行以上選んでください。" };
  }
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] !== sorted[i - 1] + 1) {
      return { ok: false, message: "結合できるのは台本上で隣り合った行だけです。" };
    }
  }

  const picked = sorted.map((i) => lines[i]);
  const segments = [];
  const mergedFrom = [];
  for (const line of picked) {
    mergedFrom.push(line.id);
    for (const seg of getLineSegments(line)) {
      segments.push({
        ...seg,
        sourceLineId: seg.sourceLineId || line.id
      });
    }
  }

  const startSec = Math.min(...segments.map((s) => s.startSec));
  const endCandidates = segments.map((s) =>
    s.endSec != null && s.endSec > s.startSec
      ? s.endSec
      : s.startSec + estimateSpeechDurationSec(s.text)
  );
  const endSec = Math.max(...endCandidates);
  const text = segments.map((s) => s.text).filter(Boolean).join(" ");
  const primaryId = picked[0].id;

  const merged = {
    ...buildScriptLine({
      id: primaryId,
      startSec,
      endSec,
      text,
      index: sorted[0]
    }),
    segments,
    mergedFrom,
    isMergedCue: true
  };

  const next = lines.slice();
  next.splice(sorted[0], sorted.length, merged);
  return { ok: true, lines: next, mergedIndex: sorted[0], removedIds: mergedFrom.slice(1) };
}

/**
 * 結合 cue を元の行数に戻す（segments が2以上）
 * @param {ScriptLine[]} lines
 * @param {number} index
 */
export function splitMergedLine(lines, index) {
  const line = lines[index];
  if (!line) return { ok: false, message: "行が見つかりません。" };
  const segments = getLineSegments(line);
  if (segments.length < 2) {
    return { ok: false, message: "この行は結合されていません。" };
  }

  const restored = segments.map((seg, i) =>
    buildScriptLine({
      id: seg.sourceLineId || stableCueId({ startSec: seg.startSec, endSec: seg.endSec, text: seg.text, index: index + i }),
      startSec: seg.startSec,
      endSec: seg.endSec,
      text: seg.text,
      index: index + i
    })
  );

  const next = lines.slice();
  next.splice(index, 1, ...restored);
  return { ok: true, lines: next, restoredIds: restored.map((l) => l.id) };
}

/**
 * 10秒ルール境界かどうか（表示用）
 * @param {ScriptLine} prev
 * @param {ScriptLine} next
 */
export function isAutoBlockBoundary(prev, next) {
  if (!prev || !next) return false;
  const gap = next.startSec - inferredLineEndSec(prev, next);
  return gap >= AUTO_BLOCK_GAP_SEC - 0.5;
}

/**
 * @param {import('./timecode.js').buildScriptLine extends (o: infer O) => infer R ? R : never} line
 */
export function lineEndSec(line, nextLine = null) {
  const segs = getLineSegments(line);
  const last = segs[segs.length - 1] || segs[0];
  if (!last) return inferredLineEndSec(line, nextLine);
  const segLine = {
    startSec: last.startSec,
    endSec: last.endSec
  };
  return inferredLineEndSec(segLine, nextLine);
}

/**
 * 結合時に Take の間へ入れる無音秒数（台本のタイムコード差。短縮しない）
 * @param {import('./timecode.js').buildScriptLine extends (o: infer O) => infer R ? R : never} prevLine
 * @param {import('./timecode.js').buildScriptLine extends (o: infer O) => infer R ? R : never} nextLine
 */
export function gapSecBetweenLines(prevLine, nextLine) {
  const gap = nextLine.startSec - lineEndSec(prevLine);
  if (!Number.isFinite(gap) || gap < 0.05) return MIN_MERGE_GAP_SEC;
  return gap;
}

/**
 * 複数 Take を、各区間のタイムコード差どおりの無音でつなぐ（結合時）
 * @param {Float32Array[]} sampleParts
 * @param {number[]} gapSecs sampleParts[i] と [i+1] の間（長さは parts.length - 1）
 * @param {number} sampleRate
 */
export function concatSamplesWithTimelineGaps(sampleParts, gapSecs, sampleRate = 48000) {
  if (!sampleParts.length) return new Float32Array(0);
  const out = [];
  for (let i = 0; i < sampleParts.length; i++) {
    if (sampleParts[i]?.length) out.push(sampleParts[i]);
    if (i < sampleParts.length - 1) {
      const gap = Math.max(0, Number(gapSecs[i]) || MIN_MERGE_GAP_SEC);
      const gapSamples = Math.floor(gap * sampleRate);
      if (gapSamples > 0) out.push(new Float32Array(gapSamples));
    }
  }
  let total = 0;
  for (const p of out) total += p.length;
  const merged = new Float32Array(total);
  let off = 0;
  for (const p of out) {
    merged.set(p, off);
    off += p.length;
  }
  return merged;
}
