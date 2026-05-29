/**
 * SubRip (SRT) タイムコード — WhisperX 単語 / Whisper セグメントの結合・パース
 * 2秒 / 10秒無音ルール（Edge whisperx-timeline-rules.ts と同期）
 * （timecode.js との循環 import を避けるため buildScriptLine はここで完結）
 */

export const NEW_BLOCK_MARKER = "[NEW_BLOCK]";

export function formatBracketTimecode(seconds) {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  const whole = Math.floor(sec);
  const cs = Math.round((sec - whole) * 100);
  return `${String(m).padStart(2, "0")}:${String(whole).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function buildLineFromSrt(startSec, endSec, text, index) {
  const start = Math.max(0, startSec);
  const end = endSec != null && endSec > start ? endSec : null;
  const body = (text || "").trim() || "新しいセリフ";
  const endKey = end != null ? Math.round(end * 100) : "x";
  const textKey = body.slice(0, 48).replace(/\s+/g, "_");
  const rawTc =
    end != null
      ? `[${formatBracketTimecode(start)} - ${formatBracketTimecode(end)}]`
      : `[${formatBracketTimecode(start)}]`;
  return {
    id: `cue-${Math.round(start * 100)}-${endKey}-${index}-${textKey || "line"}`,
    startSec: start,
    endSec: end,
    text: body,
    rawTc
  };
}

export const SILENCE_GAP_LINE_MIN_SEC = 2.0;
export const SILENCE_GAP_BLOCK_MIN_SEC = 10.0;
/** 発話終了（ケツ）確定: 単語間または波形上でこの秒数以上の無音 */
export const SILENCE_END_LOCK_SEC = 2.0;
export const INVALID_SEGMENT_END_FALLBACK_SEC = 0.35;

const SRT_TIMELINE_RE =
  /^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{3})$/;

export const SRT_BLOCK_MARKER_TEXT = "---";

export function formatSrtTimestamp(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const whole = Math.floor(sec);
  const ms = Math.min(999, Math.round((sec - whole) * 1000));
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(whole).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

export function parseSrtTimestamp(h, m, sec, ms) {
  return (
    Number(h) * 3600 +
    Number(m) * 60 +
    Number(sec) +
    Number(ms) / 1000
  );
}

function safeEndSec(startSec, endSec) {
  const start = Math.max(0, Number(startSec) || 0);
  let end = Math.max(0, Number(endSec) || 0);
  if (!(end > start)) end = start + INVALID_SEGMENT_END_FALLBACK_SEC;
  return end;
}

function hasCjkChar(s) {
  return /[\u3040-\u30ff\u3400-\u9fff]/.test(s);
}

function joinWordTexts(parts) {
  const rows = (parts || []).map((p) => String(p || "").trim()).filter(Boolean);
  if (!rows.length) return "";
  const mostlySingle = rows.filter((r) => r.length <= 1).length / rows.length > 0.7;
  const cjkHeavy = rows.filter((r) => hasCjkChar(r)).length / rows.length > 0.5;
  if (mostlySingle && cjkHeavy) return rows.join("");
  return rows.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * WhisperX words[] を正規化
 * @param {unknown} raw
 * @returns {{ word: string, start: number, end: number }[]}
 */
export function normalizeAlignWords(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const word = String(row.word || "").trim();
    if (!word) continue;
    const start = Math.max(0, Number(row.start) || 0);
    let end = Math.max(0, Number(row.end) || 0);
    if (!(end > start)) end = start + INVALID_SEGMENT_END_FALLBACK_SEC;
    out.push({ word, start, end });
  }
  out.sort((a, b) => a.start - b.start || a.end - b.end);
  return out;
}

function clampAlignWordsToDuration(words, durationSec) {
  const maxT = Number(durationSec) > 0 ? Number(durationSec) : 0;
  if (!(maxT > 0)) return words;
  return words
    .filter((w) => w.start < maxT - 0.01)
    .map((w) => ({
      word: w.word,
      start: Math.max(0, Math.min(w.start, maxT)),
      end: safeEndSec(w.start, Math.min(w.end, maxT))
    }));
}

function normalizeSilenceGaps(silenceGaps) {
  const out = [];
  for (const sg of silenceGaps || []) {
    if (!sg || typeof sg !== "object") continue;
    const start = Math.max(0, Number(sg.start) || 0);
    const end = Math.max(0, Number(sg.end) || 0);
    const dur =
      Number(sg.duration) > 0 ? Number(sg.duration) : Math.max(0, end - start);
    if (dur <= 0) continue;
    out.push({ start, end, duration: dur });
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

function silenceBetweenWords(t0, t1, silenceGaps) {
  if (t1 - t0 >= SILENCE_END_LOCK_SEC - 0.01) return false;
  return normalizeSilenceGaps(silenceGaps).some((sg) => {
    const dur = sg.duration ?? sg.end - sg.start;
    if (dur < SILENCE_END_LOCK_SEC - 0.01) return false;
    return sg.start >= t0 + 0.05 && sg.end <= t1 - 0.05;
  });
}

function forcedSpanBreakBeforeWord(words, segments, silenceGaps) {
  const breaks = new Set();
  if (words.length < 2) return breaks;
  const segRows = normalizeWhisperSegments(segments);
  for (let si = 1; si < segRows.length; si++) {
    const gap = segRows[si].start - segRows[si - 1].end;
    if (gap < SILENCE_END_LOCK_SEC) continue;
    const wi = words.findIndex((w) => w.start >= segRows[si].start - 0.05);
    if (wi > 0) breaks.add(wi);
  }
  for (const sg of normalizeSilenceGaps(silenceGaps)) {
    const dur = sg.duration ?? sg.end - sg.start;
    if (dur < SILENCE_END_LOCK_SEC - 0.01) continue;
    const wi = words.findIndex((w) => w.start >= sg.end - 0.08);
    if (wi > 0) breaks.add(wi);
  }
  return breaks;
}

function spanGapSec(prev, next, silenceGaps) {
  const wordGap = next.startSec - prev.endSec;
  if (wordGap >= SILENCE_GAP_LINE_MIN_SEC - 0.01) return wordGap;
  for (const sg of normalizeSilenceGaps(silenceGaps)) {
    const dur = sg.duration ?? sg.end - sg.start;
    if (dur < SILENCE_GAP_LINE_MIN_SEC - 0.01) continue;
    if (next.startSec >= sg.end - 0.25 && prev.endSec <= sg.end + 0.5) return dur;
  }
  return wordGap;
}

/** Pass 1: 単語列 → 発話スパン（ケツは 2秒以上の無音で確定） */
export function buildSpeechSpansFromAlignWords(
  words,
  durationSec = 0,
  segments = [],
  silenceGaps = []
) {
  const rows = clampAlignWordsToDuration(normalizeAlignWords(words), durationSec);
  if (!rows.length) return [];

  const forcedBreaks = forcedSpanBreakBeforeWord(rows, segments, silenceGaps);

  const spans = [];
  let batchStart = rows[0].start;
  let batchEnd = rows[0].end;
  const batchTexts = [rows[0].word];

  const flush = () => {
    const text = joinWordTexts(batchTexts);
    if (!text) return;
    spans.push({
      startSec: batchStart,
      endSec: safeEndSec(batchStart, batchEnd),
      text
    });
  };

  for (let i = 1; i < rows.length; i++) {
    const w = rows[i];
    const gap = w.start - batchEnd;
    const endLocked =
      forcedBreaks.has(i) ||
      gap >= SILENCE_END_LOCK_SEC ||
      silenceBetweenWords(batchEnd, w.start, silenceGaps);

    if (endLocked) {
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
export function buildTimelineCuesFromSpeechSpans(spans, silenceGaps = []) {
  if (!spans.length) return [];

  const cueParts = [];
  let batch = {
    startSec: spans[0].startSec,
    endSec: spans[0].endSec,
    texts: [spans[0].text]
  };
  let pendingBlockBreak = false;

  const flush = () => {
    const text = joinWordTexts(batch.texts);
    if (!text) return;
    cueParts.push({
      startSec: batch.startSec,
      endSec: safeEndSec(batch.startSec, batch.endSec),
      text,
      blockBreak: pendingBlockBreak
    });
    pendingBlockBreak = false;
  };

  for (let i = 1; i < spans.length; i++) {
    const next = spans[i];
    const gap = spanGapSec(
      { startSec: batch.startSec, endSec: batch.endSec, text: "" },
      next,
      silenceGaps
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
  return cueParts;
}

/**
 * WhisperX words[] → 2秒/10秒 TimelineCue（二段パス）
 */
export function buildTimelineCuesFromAlignWords(
  words,
  durationSec = 0,
  segments = [],
  silenceGaps = []
) {
  const spans = buildSpeechSpansFromAlignWords(words, durationSec, segments, silenceGaps);
  if (!spans.length) return [];
  return buildTimelineCuesFromSpeechSpans(spans, silenceGaps);
}

/**
 * words + segments（推奨）
 */
export function buildTimelineCuesFromWhisperX(whisperXPayload, durationSec = 0) {
  const words = normalizeAlignWords(whisperXPayload?.words);
  const segments = whisperXPayload?.segments || [];
  const silenceGaps = whisperXPayload?.silenceGaps || [];
  if (words.length) {
    return buildTimelineCuesFromAlignWords(words, durationSec, segments, silenceGaps);
  }
  return buildTimelineCuesFromWhisperSegments(segments, durationSec);
}

/**
 * words[] → ブラケット台本（2秒/10秒、[NEW_BLOCK]）
 */
export function buildBracketTimelineFromAlignWords(
  words,
  durationSec = 0,
  segments = [],
  silenceGaps = []
) {
  const cues = buildTimelineCuesFromAlignWords(words, durationSec, segments, silenceGaps);
  const lines = [];
  for (const cue of cues) {
    if (cue.blockBreak) lines.push(NEW_BLOCK_MARKER);
    const end = safeEndSec(cue.startSec, cue.endSec);
    lines.push(
      `[${formatBracketTimecode(cue.startSec)} - ${formatBracketTimecode(end)}] ${cue.text}`
    );
  }
  return lines.join("\n").trim();
}

/**
 * TimelineCue → whisperSegments 互換
 */
export function timelineCuesToLegacySegments(cues) {
  return (cues || []).map((c) => ({
    start: c.startSec,
    end: c.endSec,
    text: c.text,
    ...(c.blockBreak ? { blockBreak: true } : {})
  }));
}

function normalizeWhisperSegments(segments) {
  const out = [];
  for (const row of segments || []) {
    if (!row || typeof row !== "object") continue;
    const text = String(row.text || "").trim();
    if (!text) continue;
    const start = Math.max(0, Number(row.start) || 0);
    let end = Math.max(0, Number(row.end) || 0);
    if (!(end > start)) end = start + INVALID_SEGMENT_END_FALLBACK_SEC;
    out.push({ text, start, end });
  }
  out.sort((a, b) => a.start - b.start || a.end - b.end);
  return out;
}

/**
 * セグメント間 gap（レガシー Whisper SRT）
 * gap = next.start - batch.endSec（2秒合体 / 2–10秒改行 / 10秒以上 blockBreak）
 */
export function buildTimelineCuesFromWhisperSegments(whisperSegments, durationSec = 0) {
  const rows = normalizeWhisperSegments(whisperSegments);
  if (!rows.length) return [];

  const maxT = Number(durationSec) > 0 ? Number(durationSec) : 0;
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
            return { ...s, start, end };
          })
      : rows;

  if (!filtered.length) return [];

  const cueParts = [];
  let batch = {
    startSec: filtered[0].start,
    endSec: filtered[0].end,
    texts: [filtered[0].text]
  };
  let pendingBlockBreak = false;

  const flush = () => {
    const text = joinWordTexts(batch.texts);
    if (!text) return;
    cueParts.push({
      startSec: batch.startSec,
      endSec: safeEndSec(batch.startSec, batch.endSec),
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
  return cueParts;
}


/**
 * Whisper セグメント → ブラケット台本（2秒/10秒ルール、[NEW_BLOCK] 付き）
 */
export function buildBracketTimelineFromWhisperSegments(whisperSegments, durationSec = 0) {
  const cues = buildTimelineCuesFromWhisperSegments(whisperSegments, durationSec);
  const lines = [];
  for (const cue of cues) {
    if (cue.blockBreak) lines.push(NEW_BLOCK_MARKER);
    const end = safeEndSec(cue.startSec, cue.endSec);
    lines.push(
      `[${formatBracketTimecode(cue.startSec)} - ${formatBracketTimecode(end)}] ${cue.text}`
    );
  }
  return lines.join("\n").trim();
}

/**
 * WhisperX words[] → ブラケット台本
 */
export function buildBracketTimelineFromWhisperX(whisperXPayload, durationSec = 0) {
  const cues = buildTimelineCuesFromWhisperX(whisperXPayload || {}, durationSec);
  const lines = [];
  for (const cue of cues) {
    if (cue.blockBreak) lines.push(NEW_BLOCK_MARKER);
    const end = safeEndSec(cue.startSec, cue.endSec);
    lines.push(
      `[${formatBracketTimecode(cue.startSec)} - ${formatBracketTimecode(end)}] ${cue.text}`
    );
  }
  return lines.join("\n").trim();
}

export function isBracketTimelineDocument(raw) {
  const t = String(raw || "").trim();
  if (!t || isSrtDocument(t)) return false;
  const tcLineRe =
    /^\[\d{1,2}:\d{2}(?:\.\d{1,3})?\s*(?:->|→|-)\s*\d{1,2}:\d{2}(?:\.\d{1,3})?\]\s+\S/;
  const rows = t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!rows.length) return false;
  const tcCount = rows.filter((l) => tcLineRe.test(l)).length;
  return tcCount >= 1;
}

/**
 * Whisper セグメント → SRT 本文（2秒/10秒ルール）
 * @param {{ start: number, end: number, text: string }[]} whisperSegments
 * @param {number} [durationSec]
 */
export function buildSrtFromWhisperSegments(whisperSegments, durationSec = 0) {
  const cueParts = buildTimelineCuesFromWhisperSegments(whisperSegments, durationSec);
  if (!cueParts.length) return "";

  const blocks = [];
  let openBlock = [];
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

export function isSrtDocument(raw) {
  const t = String(raw || "").trim();
  if (!t) return false;
  const blocks = t.split(/\n\s*\n/);
  let hits = 0;
  for (const block of blocks.slice(0, 12)) {
    const lines = block.trim().split(/\r?\n/).map((l) => l.trim());
    const timeline = /^\d+$/.test(lines[0] || "") ? lines[1] : lines[0];
    if (timeline && SRT_TIMELINE_RE.test(timeline)) hits++;
  }
  return hits >= 1;
}

/**
 * SRT → 台本行（内部は startSec/endSec + rawTc）
 */
export function parseSrtToScriptLines(raw, opts = {}) {
  const t = String(raw || "").trim();
  if (!t) return [];

  const blocks = t.split(/\n\s*\n/);
  const lines = [];
  let pendingBlockBreak = false;

  for (const block of blocks) {
    const rows = block.trim().split(/\r?\n/).map((l) => l.trim());
    if (!rows.length) continue;

    let timelineIdx = 0;
    if (/^\d+$/.test(rows[0]) && rows.length >= 2) timelineIdx = 1;

    const timeline = rows[timelineIdx];
    const m = timeline?.match(SRT_TIMELINE_RE);
    if (!m) continue;

    const startSec = parseSrtTimestamp(m[1], m[2], m[3], m[4]);
    const endSec = parseSrtTimestamp(m[5], m[6], m[7], m[8]);
    const text = rows.slice(timelineIdx + 1).join("\n").trim();
    if (!text || text === SRT_BLOCK_MARKER_TEXT) {
      pendingBlockBreak = true;
      continue;
    }

    const line = buildLineFromSrt(
      startSec,
      endSec > startSec ? endSec : startSec + 0.35,
      text,
      lines.length
    );
    if (pendingBlockBreak) {
      line.blockBreak = true;
      pendingBlockBreak = false;
    }
    lines.push(line);
  }

  void opts;
  return lines;
}

export function scriptLinesToSrt(lines) {
  const cues = (lines || []).filter((l) => l?.text?.trim());
  const blocks = [];
  let openBlock = [];
  let idx = 0;

  for (const l of cues) {
    if (l.blockBreak && openBlock.length) {
      blocks.push(openBlock.join("\n\n"));
      openBlock = [];
      idx = 0;
    }
    idx++;
    const start = formatSrtTimestamp(l.startSec);
    const end = formatSrtTimestamp(
      l.endSec != null && l.endSec > l.startSec ? l.endSec : l.startSec + 0.35
    );
    openBlock.push(`${idx}\n${start} --> ${end}\n${String(l.text).trim()}`);
  }
  if (openBlock.length) blocks.push(openBlock.join("\n\n"));
  return blocks.join("\n\n\n").trim();
}

export function buildScriptLinesFromWhisperSrt(whisperSegments, durationSec = 0) {
  return parseSrtToScriptLines(
    buildSrtFromWhisperSegments(whisperSegments, durationSec)
  );
}
