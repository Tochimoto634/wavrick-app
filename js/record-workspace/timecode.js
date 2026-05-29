/**
 * Parse / format timecoded script lines.
 * Supports: [00:02.00] text  |  [01:23.40 - 01:25.80] text  |  SubRip (SRT)
 */

import {
  isSrtDocument,
  parseSrtToScriptLines
} from "./srt-timecode.js?v=rw-srt-tc-2026-05-28";

const LINE_RE =
  /^\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?(?:\s*(?:->|→|-)\s*(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?)?\]\s*(.+)$/;

export const TC_ONLY_LINE_RE =
  /^\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?(?:\s*(?:->|→|-)\s*(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?)?\]\s*$/;

const EMBEDDED_TC_RE =
  /\[\d{1,2}:\d{2}(?:\.\d{1,3})?(?:\s*(?:->|→|-)\s*\d{1,2}:\d{2}(?:\.\d{1,3})?)?\]/g;

/** 行全体がタイムコードのみか */
export function isTimecodeOnlyLine(line) {
  return TC_ONLY_LINE_RE.test(String(line || "").trim());
}

/** セリフ文中・行頭の [00:xx] 表記を除去 */
export function stripTimecodeMarkupFromText(text) {
  return String(text || "")
    .replace(EMBEDDED_TC_RE, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** UI 用の (話者1) など汎用ラベルを除去（Grok の (柴ユー) は残す） */
export function stripPlaceholderSpeakerLabel(text) {
  return String(text || "")
    .replace(/^\(話者\d+\)\s*/i, "")
    .trim();
}

function fractionToSeconds(frac) {
  if (frac == null || frac === "") return 0;
  const n = Number(frac);
  if (!Number.isFinite(n)) return 0;
  const digits = String(frac).length;
  if (digits <= 2) return n / 100;
  if (digits === 3) return n / 1000;
  return n / Math.pow(10, digits);
}

export function parseTimeParts(minutes, seconds, fraction) {
  return Number(minutes) * 60 + Number(seconds) + fractionToSeconds(fraction);
}

export function formatTimecode(seconds) {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  const whole = Math.floor(sec);
  const cs = Math.round((sec - whole) * 100);
  return `${String(m).padStart(2, "0")}:${String(whole).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

export function formatTimeRange(startSec, endSec) {
  if (endSec != null && endSec > startSec) {
    return `[${formatTimecode(startSec)} - ${formatTimecode(endSec)}]`;
  }
  return `[${formatTimecode(startSec)}]`;
}

/**
 * @param {string} raw multiline script
 * @returns {{ id: string, startSec: number, endSec: number|null, text: string, rawTc: string }[]}
 */
/**
 * @param {{ startSec: number, endSec: number|null, text: string }} opts
 */
/**
 * タイムコード+文言から安定した cueId（顧客の部分リテイク指定と共有）
 * @param {{ startSec: number, endSec?: number|null, text?: string, index?: number }} parts
 */
export function stableCueId(parts) {
  const start = Math.max(0, Number(parts.startSec) || 0);
  const end =
    parts.endSec != null && parts.endSec > start
      ? Math.round(parts.endSec * 100)
      : "x";
  const textKey = String(parts.text || "")
    .trim()
    .slice(0, 48)
    .replace(/\s+/g, "_");
  const idx = Number(parts.index) || 0;
  return `cue-${Math.round(start * 100)}-${end}-${idx}-${textKey || "line"}`;
}

function lineIdentityKey(startSec, endSec, text) {
  return `${Math.round(startSec * 1000)}|${endSec != null ? Math.round(endSec * 1000) : ""}|${String(text || "").trim()}`;
}

export function buildScriptLine(opts) {
  const startSec = Math.max(0, opts.startSec);
  const endSec =
    opts.endSec != null && opts.endSec > startSec ? opts.endSec : null;
  const text = (opts.text || "").trim() || "新しいセリフ";
  return {
    id:
      opts.id ||
      stableCueId({ startSec, endSec, text, index: opts.index ?? 0 }),
    startSec,
    endSec,
    text,
    rawTc: formatTimeRange(startSec, endSec)
  };
}

export function scriptLinesToText(lines) {
  return lines
    .map((l) => `${l.rawTc}\n${l.text}`)
    .join("\n");
}

/**
 * @param {string} raw
 * @param {{ previousLines?: { id: string, startSec: number, endSec?: number|null, text: string }[] }} [opts]
 */
/** 同一セリフ（同一行）内で Whisper セグメントを結合する最大ギャップ（秒未満） */
export const SPEECH_MERGE_MAX_GAP_SEC = 2;

/** 同一台本内で別行に分けるギャップ（秒以上・発話終了から次の発話まで） */
export const LINE_GAP_SPLIT_MIN_SEC = 2;

/** 別台本（ブロック）に分けるギャップ（秒以上） */
export const AUTO_BLOCK_GAP_SEC = 10;

const TC_ONLY_RE = TC_ONLY_LINE_RE;

/** 日本語吹替の目安: 1秒あたりの文字数（読み上げ＋間） */
export const SPEECH_CHARS_PER_SEC = 8.5;

/**
 * 台詞テキストから読み上げ時間（秒）を推定
 * @param {string} text
 */
export function estimateSpeechDurationSec(text) {
  const t = String(text || "").trim();
  if (!t) return 2;
  const chars = t.replace(/\s/g, "").length;
  const base = chars / SPEECH_CHARS_PER_SEC;
  const pauseBonus = (t.match(/[。！？!?、,\n]/g) || []).length * 0.35;
  return Math.max(2, Math.min(120, base + pauseBonus));
}

/**
 * 長い台詞を文単位に分割（1行に全セリフが入った場合の対策）
 * @param {string} text
 */
export function splitTextIntoSpeechChunks(text) {
  const t = String(text || "").trim();
  if (!t) return [];

  const byNewline = t
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (byNewline.length > 1) {
    return byNewline.flatMap((line) => splitTextIntoSpeechChunks(line));
  }

  if (/[。！？!?]/.test(t)) {
    const bySentence = t
      .split(/(?<=[。！？!?])/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (bySentence.length > 1) return bySentence;
  }

  // 「けれど、でも」などの間で区切る（吹替台本でよくある区切り）
  if (/、でも\s*\S/.test(t)) {
    const byDemo = t
      .split(/(?<=、でも)\s*/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (byDemo.length > 1) {
      return byDemo.flatMap((part) => splitTextIntoSpeechChunks(part));
    }
  }

  // 「けれど、今は〜」の切り替え（間が空く吹替の区切り）
  if (/けれど[、,]\s*今/u.test(t)) {
    const byKeredo = t
      .split(/(?<=けれど[、,])\s*/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (byKeredo.length > 1) {
      return byKeredo.flatMap((part) => splitTextIntoSpeechChunks(part));
    }
  }

  if (t.length <= 32) return [t];

  const bySentenceLegacy = t.match(/[^。！？!?\n]+[。！？!?]?/g);
  if (bySentenceLegacy && bySentenceLegacy.length > 1) {
    return bySentenceLegacy.map((s) => s.trim()).filter(Boolean);
  }

  if (t.length > 48) {
    const byComma = t.split(/(?<=[、，])\s*/).map((s) => s.trim()).filter(Boolean);
    if (byComma.length > 1) return byComma;
  }

  const maxChunk = 48;
  if (t.length <= maxChunk) return [t];
  const chunks = [];
  for (let i = 0; i < t.length; i += maxChunk) {
    chunks.push(t.slice(i, i + maxChunk).trim());
  }
  return chunks.filter(Boolean);
}

/** 文中に埋め込まれた [00:20.00] や [00:20.00 - 00:25.00] */
const INLINE_TC_RE =
  /\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?(?:\s*(?:->|→|-)\s*(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?)?\]/g;

/**
 * 台詞文中のインラインタイムコードで分割（[00:20.00] はセリフではなく区切り）
 * @param {string} text
 * @returns {{ text: string, startSec: number|null, endSec: number|null }[]|null}
 */
export function splitTextByInlineTimecodes(text) {
  const t = String(text || "").trim();
  if (!t || !/\[\d{1,2}:\d{2}/.test(t)) return null;

  const trimmedLine = t.split(/\r?\n/)[0]?.trim() || t;
  if (LINE_RE.test(trimmedLine) && trimmedLine.match(LINE_RE)?.[0] === trimmedLine) {
    return null;
  }

  const matches = [...t.matchAll(INLINE_TC_RE)];
  if (!matches.length) return null;

  const utterances = [];
  let cursor = 0;
  let nextStart = null;

  for (const m of matches) {
    const before = t.slice(cursor, m.index).trim();
    const markerStart = parseTimeParts(m[1], m[2], m[3]);
    const markerEnd =
      m[4] != null ? parseTimeParts(m[4], m[5], m[6]) : null;

    if (before) {
      const endSec =
        markerStart > (nextStart ?? 0)
          ? markerStart - 0.05
          : markerEnd != null && markerEnd > (nextStart ?? 0)
            ? markerEnd
            : null;
      utterances.push({
        text: before,
        startSec: nextStart,
        endSec
      });
    }

    nextStart = markerStart;
    cursor = m.index + m[0].length;

    if (!before && markerEnd != null && markerEnd > markerStart) {
      nextStart = markerStart;
    }
  }

  const tail = t.slice(cursor).trim();
  if (tail) {
    utterances.push({
      text: tail,
      startSec: nextStart,
      endSec: null
    });
  }

  if (utterances.length <= 1) return null;
  return utterances;
}

/**
 * 既存の台本行の文中 [00:20.00] を別行に展開
 * @param {{ id: string, startSec: number, endSec?: number|null, text: string, rawTc?: string }[]} lines
 */
export function expandScriptLinesWithInlineTimecodes(lines) {
  if (!lines?.length) return [];
  const out = [];
  for (const line of lines) {
    const parts = splitTextByInlineTimecodes(line.text);
    if (!parts) {
      out.push(line);
      continue;
    }
    for (const part of parts) {
      const startSec =
        part.startSec != null ? part.startSec : line.startSec;
      out.push(
        buildScriptLine({
          startSec,
          endSec: part.endSec,
          text: part.text,
          index: out.length
        })
      );
    }
  }
  return out;
}

/**
 * 動画／音声の実長（秒）。YouTube 長や Whisper API の duration を explicit に渡す。
 * @param {number} explicitSec YouTube・Whisper API の duration など
 * @param {{ start: number, end: number }[]} [segments]
 */
export function resolveTimelineDurationSec(explicitSec, segments) {
  const explicit = Number(explicitSec) > 0 ? Number(explicitSec) : 0;
  const rows = normalizeWhisperSegmentRows(segments);
  const segMax = rows.length
    ? Math.max(...rows.map((s) => s.end))
    : 0;

  if (explicit > 0) return explicit;
  return segMax;
}

/**
 * Whisper セグメントを動画長以内に収める
 */
export function clampWhisperSegmentsToTimeline(segments, timelineEndSec) {
  const maxT = Number(timelineEndSec);
  let rows = normalizeWhisperSegmentRows(segments);
  if (!(maxT > 0) || !rows.length) return rows;

  const segMax = Math.max(...rows.map((s) => s.end));
  if (segMax > maxT + 0.35) {
    const scale = maxT / segMax;
    rows = rows.map((s) => ({
      ...s,
      start: s.start * scale,
      end: s.end * scale
    }));
  }

  return rows
    .map((s) => {
      const start = Math.max(0, Math.min(s.start, maxT - 0.05));
      const end = Math.max(
        start + 0.05,
        Math.min(s.end > s.start ? s.end : s.start + 0.35, maxT)
      );
      return { ...s, start, end };
    })
    .filter((s) => s.start < maxT - 0.02 && s.end > s.start);
}

/**
 * 台本行の start/end を [0, 動画長] に収め、時系列順を保証
 */
export function clampScriptLinesToTimeline(lines, timelineEndSec) {
  const maxT = Number(timelineEndSec);
  if (!lines?.length) return [];
  if (!(maxT > 0)) return dedupeAndSortScriptLines(lines);

  return dedupeAndSortScriptLines(lines)
    .map((line) => {
      let startSec = Math.max(0, Math.min(Number(line.startSec) || 0, maxT - 0.1));
      let endSec =
        line.endSec != null && line.endSec > startSec
          ? Math.min(Number(line.endSec), maxT)
          : Math.min(maxT, startSec + 0.35);
      if (endSec <= startSec) {
        endSec = Math.min(maxT, startSec + 0.35);
      }
      return {
        ...line,
        startSec,
        endSec,
        rawTc: formatTimeRange(startSec, endSec)
      };
    })
    .filter((l) => l.startSec < maxT - 0.02);
}

/**
 * 行の終了秒（Whisper の end を優先。読み上げ推定で延長しない）
 * @param {{ startSec: number, endSec?: number|null }} line
 * @param {{ startSec: number }?} nextLine
 * @param {number} [timelineEndSec] 最終行のみ: 動画長で上限
 */
export function inferredLineEndSec(line, nextLine, timelineEndSec = 0) {
  const start = Math.max(0, Number(line.startSec) || 0);
  const maxEnd =
    timelineEndSec > start ? timelineEndSec : Number.POSITIVE_INFINITY;

  if (line.endSec != null && line.endSec > start) {
    let end = Math.min(line.endSec, maxEnd);
    if (nextLine && nextLine.startSec > start && end > nextLine.startSec) {
      end = Math.max(start + 0.1, Math.min(nextLine.startSec - 0.05, maxEnd));
    }
    return end;
  }
  if (nextLine && nextLine.startSec > start) {
    return Math.min(
      Math.max(start + 0.15, nextLine.startSec - 0.05),
      maxEnd
    );
  }
  const est = start + estimateSpeechDurationSec(line.text);
  return Math.min(est, maxEnd);
}

/**
 * @param {{ startSec: number, endSec?: number|null }} prev
 * @param {{ startSec: number, endSec?: number|null }} next
 */
export function gapSecBetweenScriptLines(prev, next) {
  if (!prev || !next) return 0;
  return next.startSec - inferredLineEndSec(prev, next);
}

/**
 * 台本行の endSec / rawTc を埋め、先頭・末尾を動画長に合わせる
 * @param {{ id: string, startSec: number, endSec?: number|null, text: string, rawTc?: string, blockBreak?: boolean }[]} lines
 * @param {number} [durationSec]
 */
function gapAfterLineSec(line, nextLine) {
  if (!line || !nextLine) return Infinity;
  const tail =
    line.endSec != null && line.endSec > line.startSec
      ? line.endSec
      : line.startSec;
  return nextLine.startSec - tail;
}

/** 台詞ではない行（エンドカードの社名など） */
export function isNonDialogueScriptLine(text) {
  const t = stripTimecodeMarkupFromText(text).trim();
  if (!t) return true;
  if (/^(大成建設|提供[:：]?|スポンサー|チャンネル登録)/i.test(t)) return true;
  if (t.length <= 10 && /(建設|公式|CM)$/i.test(t)) return true;
  return false;
}

/**
 * 開始時刻順に並べ、同一セリフの重複を除去
 * @param {{ id?: string, startSec: number, endSec?: number|null, text: string }[]} lines
 */
export function dedupeAndSortScriptLines(lines) {
  const sorted = [...(lines || [])]
    .filter((l) => l && !isNonDialogueScriptLine(l.text))
    .sort(
      (a, b) =>
        a.startSec - b.startSec ||
        (a.endSec ?? 0) - (b.endSec ?? 0) ||
        String(a.text).localeCompare(String(b.text))
    );

  const seen = new Set();
  const out = [];
  for (const line of sorted) {
    const textKey = compactJa(line.text).slice(0, 64);
    const key = `${Math.round(line.startSec * 100)}|${textKey}`;
    if (!textKey || seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out;
}

export function normalizeScriptLineTimings(lines, durationSec = 0) {
  if (!lines?.length) return [];
  const timelineEnd = durationSec > 0 ? durationSec : 0;
  let out = dedupeAndSortScriptLines(lines).map((l) => ({ ...l }));

  if (timelineEnd > 0) {
    out = out.map((line) => {
      const startSec = Math.max(0, Math.min(line.startSec, timelineEnd - 0.1));
      let endSec = line.endSec;
      if (endSec != null && endSec > startSec) {
        endSec = Math.min(endSec, timelineEnd);
      }
      return { ...line, startSec, endSec };
    });
  }

  for (let i = 0; i < out.length; i++) {
    const next = out[i + 1] || null;
    const gap = gapAfterLineSec(out[i], next);
    const hasCommittedEnd =
      out[i].endSec != null &&
      out[i].endSec > out[i].startSec &&
      (gap >= SPEECH_MERGE_MAX_GAP_SEC - 0.05 || !next);

    if (hasCommittedEnd) {
      const span = out[i].endSec - out[i].startSec;
      const minSpan = Math.min(estimateSpeechDurationSec(out[i].text) * 0.4, 8);
      const tooShortForText =
        compactJa(out[i].text).length >= 8 &&
        span < Math.min(minSpan, 1.8);
      if (tooShortForText) {
        const endBound = i === out.length - 1 ? timelineEnd : 0;
        out[i].endSec = inferredLineEndSec(out[i], next, endBound);
      } else if (
        span < minSpan &&
        compactJa(out[i].text).length >= 6 &&
        (!next || next.startSec - out[i].startSec > minSpan * 0.45)
      ) {
        const cap = next
          ? next.startSec - 0.05
          : timelineEnd > out[i].startSec
            ? timelineEnd
            : out[i].startSec + minSpan;
        out[i].endSec = Math.min(cap, out[i].startSec + minSpan);
      }
      out[i].rawTc = formatTimeRange(out[i].startSec, out[i].endSec);
      continue;
    }

    const endBound = i === out.length - 1 ? timelineEnd : 0;
    const end = inferredLineEndSec(out[i], next, endBound);
    out[i].endSec = end;
    out[i].rawTc = formatTimeRange(out[i].startSec, end);
  }

  out = applyBlockBreaksFromGaps(out);
  return timelineEnd > 0 ? clampScriptLinesToTimeline(out, timelineEnd) : out;
}

/**
 * Whisper セグメント → 台本行（2秒以上の無音で行分割、10秒以上は blockBreak）
 * @param {{ start: number, end: number, text: string }[]} segments
 * @param {number} [durationSec]
 */
export function normalizeWhisperSegmentRows(segments) {
  return (segments || [])
    .map((s) => ({
      start: Math.max(0, Number(s.start) || 0),
      end: Math.max(0, Number(s.end) || 0),
      text: String(s.text || "").trim()
    }))
    .filter((s) => s.text && s.end > s.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

export function buildPlainOffsetTimeMapper(plain, segments, durationSec) {
  const rows = normalizeWhisperSegmentRows(segments);
  const p = String(plain || "");
  const segJoined = rows.map((s) => s.text).join("");
  const useSegments =
    rows.length > 0 &&
    p.length > 0 &&
    segJoined.length > 0 &&
    Math.abs(p.length - segJoined.length) / Math.max(p.length, 1) < 0.25;

  if (useSegments) {
    const bounds = [];
    let charCursor = 0;
    for (const seg of rows) {
      const len = seg.text.length;
      bounds.push({
        startChar: charCursor,
        endChar: charCursor + len,
        startSec: seg.start,
        endSec: seg.end > seg.start ? seg.end : seg.start + 0.01
      });
      charCursor += len;
    }
    return (offset) => {
      const o = Math.max(0, Math.min(offset, p.length));
      const hit =
        bounds.find((b) => o >= b.startChar && o <= b.endChar) ||
        bounds[bounds.length - 1];
      if (!hit) return 0;
      const span = Math.max(1, hit.endChar - hit.startChar);
      const ratio = (o - hit.startChar) / span;
      return hit.startSec + ratio * (hit.endSec - hit.startSec);
    };
  }

  const total = durationSec > 0 ? durationSec : 1;
  return (offset) => (Math.max(0, offset) / Math.max(p.length, 1)) * total;
}

function compactJa(s) {
  return String(s || "").replace(/[\s\u3000、。！？!?,.]/g, "");
}

/** compact 文字列同士の包含・前方一致スコア（0〜1） */
function whisperTextOverlapScore(needleCompact, haystackCompact) {
  const n = String(needleCompact || "");
  const h = String(haystackCompact || "");
  if (!n || !h) return 0;
  if (h.includes(n)) {
    return n.length / Math.max(h.length, 1);
  }
  if (n.includes(h)) {
    return (h.length / Math.max(n.length, 1)) * 0.95;
  }
  const maxProbe = Math.min(n.length, 24);
  for (let len = maxProbe; len >= 4; len--) {
    const probe = n.slice(0, len);
    if (h.includes(probe)) {
      return (len / n.length) * 0.9;
    }
  }
  return 0;
}

function segEndSec(seg) {
  return seg.end > seg.start ? seg.end : seg.start + 0.35;
}

/**
 * 台詞テキストを Whisper セグメント列上で順番にマッチ（Grok 台本と文字起こしの差異に強い）
 * @param {string} text
 * @param {{ start: number, end: number, text: string }[]} rows
 * @param {number} [fromSegIdx]
 */
export function matchTextToWhisperSegments(text, rows, fromSegIdx = 0) {
  const needle = compactJa(
    stripPlaceholderSpeakerLabel(stripTimecodeMarkupFromText(text))
  );
  const list = normalizeWhisperSegmentRows(rows);
  if (!needle || !list.length) return null;

  const maxLookahead = 18;
  let best = null;
  const startAt = Math.max(0, Math.min(fromSegIdx, list.length - 1));

  for (let i = startAt; i < list.length; i++) {
    let compactJoined = "";
    for (let j = i; j < list.length && j < i + maxLookahead; j++) {
      compactJoined += compactJa(list[j].text);
      const score = whisperTextOverlapScore(needle, compactJoined);
      if (score <= 0) continue;

      const candidate = {
        fromIdx: i,
        toIdx: j,
        score,
        startSec: list[i].start,
        endSec: segEndSec(list[j])
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

/**
 * 台詞1行に対応する Whisper セグメントを順に消費（細切れ segment を結合）
 * @param {string} text
 * @param {{ start: number, end: number, text: string }[]} rows
 * @param {number} fromSegIdx
 */
export function consumeWhisperSegmentsForText(text, rows, fromSegIdx = 0) {
  const needle = compactJa(
    stripPlaceholderSpeakerLabel(stripTimecodeMarkupFromText(text))
  );
  const list = normalizeWhisperSegmentRows(rows);
  if (!needle || !list.length) return null;

  const startAt = Math.max(0, Math.min(fromSegIdx, list.length - 1));
  const minDur = estimateSpeechDurationSec(text) * 0.55;
  const used = [];
  let bestScore = 0;

  for (let i = startAt; i < list.length; i++) {
    if (used.length > 0) {
      const gap = list[i].start - segEndSec(used[used.length - 1]);
      if (gap >= SPEECH_MERGE_MAX_GAP_SEC - 0.05) break;
    }

    used.push(list[i]);
    const compactJoined = used.map((s) => compactJa(s.text)).join("");
    const score = whisperTextOverlapScore(needle, compactJoined);
    const dur = segEndSec(used[used.length - 1]) - used[0].start;
    if (used.length > 1 && score < bestScore - 0.06 && dur >= minDur) {
      used.pop();
      break;
    }
    bestScore = Math.max(bestScore, score);

    const covered =
      score >= 0.88 &&
      (compactJoined.includes(needle) || needle.includes(compactJoined));
    if (covered || dur >= minDur) {
      break;
    }
    if (used.length >= 16) break;
  }

  if (!used.length) return null;
  const joined = used.map((s) => compactJa(s.text)).join("");
  const finalScore = whisperTextOverlapScore(needle, joined);
  if (finalScore < 0.2) return null;

  return {
    fromIdx: startAt,
    toIdx: startAt + used.length - 1,
    score: finalScore,
    startSec: used[0].start,
    endSec: segEndSec(used[used.length - 1])
  };
}

/** 台本行のタイムコードが Whisper 細切れのまま短すぎるか */
export function scriptLinesNeedWhisperRetime(lines) {
  const arr = lines || [];
  if (arr.length < 2) return false;
  let shortCount = 0;
  for (const l of arr) {
    const chars = compactJa(l.text).length;
    if (chars < 8) continue;
    const span = (l.endSec ?? l.startSec) - l.startSec;
    const minOk = Math.min(estimateSpeechDurationSec(l.text) * 0.4, 1.8);
    if (span < minOk) shortCount++;
  }
  return shortCount >= 2;
}

/** Whisper 割当後の仕上げ（推定時間で end を潰さない） */
function finishWhisperAlignedLines(lines, durationSec = 0) {
  let out = applyBlockBreaksFromGaps(dedupeAndSortScriptLines(lines));
  out = out.map((l) => ({
    ...l,
    rawTc: formatTimeRange(l.startSec, l.endSec)
  }));
  return durationSec > 0 ? clampScriptLinesToTimeline(out, durationSec) : out;
}

/**
 * テキストマッチ失敗時: 未使用の Whisper セグメントを順番に割当（+2秒シフトはしない）
 */
function takeSequentialWhisperSegments(rows, fromIdx, text) {
  if (fromIdx >= rows.length) return null;
  const minDur = estimateSpeechDurationSec(text) * 0.45;
  const used = [];

  for (let i = fromIdx; i < rows.length; i++) {
    if (used.length > 0) {
      const gap = rows[i].start - segEndSec(used[used.length - 1]);
      if (gap >= SPEECH_MERGE_MAX_GAP_SEC - 0.05) break;
    }
    used.push(rows[i]);
    const dur = segEndSec(used[used.length - 1]) - used[0].start;
    if (dur >= minDur) break;
    if (used.length >= 12) break;
  }

  if (!used.length) return null;
  return {
    fromIdx,
    toIdx: fromIdx + used.length - 1,
    startSec: used[0].start,
    endSec: segEndSec(used[used.length - 1])
  };
}

/** Whisper なし時のみ: 動画長に文字数比例で割当（固定2秒ギャップは入れない） */
function estimateLinesAcrossTimeline(sentences, durationSec) {
  const maxT = durationSec > 0 ? durationSec : 0;
  const weights = sentences.map((t) => Math.max(1, compactJa(t).length));
  const totalW = weights.reduce((a, b) => a + b, 0);
  let cursor = 0;
  return sentences.map((text, i) => {
    const share = weights[i] / totalW;
    const dur =
      maxT > 0
        ? Math.max(0.35, share * maxT * 0.98)
        : estimateSpeechDurationSec(text);
    const startSec = maxT > 0 ? Math.min(cursor, maxT - 0.1) : cursor;
    let endSec = startSec + dur;
    if (maxT > 0) endSec = Math.min(endSec, maxT);
    const line = buildScriptLine({ startSec, endSec, text, index: i });
    cursor = endSec;
    return line;
  });
}

/**
 * 台本セリフ（順序固定）を Whisper に順割り当て — タイムコードの唯一の割当ロジック
 *
 * - 頭: そのセリフの発話開始（Whisper セグメントの start）
 * - ケツ: そのセリフの発話終了（Whisper セグメントの end）。次の行まで伸ばさない
 * - 前行のケツ→次行の頭が 10秒以上: blockBreak（別台本ブロック）
 * - 2秒/10秒は「行を分ける・ブロックを分ける」判定のみ（終了時刻の伸長には使わない）
 */
export function alignOrderedTextsToWhisperSegments(
  texts,
  segments,
  durationSec = 0
) {
  const sentences = (texts || [])
    .map((t) => stripPlaceholderSpeakerLabel(stripTimecodeMarkupFromText(t)))
    .filter((t) => Boolean(t) && !isNonDialogueScriptLine(t));
  const rows = normalizeWhisperSegmentRows(segments);
  if (!sentences.length) return [];
  if (!rows.length) {
    return estimateLinesAcrossTimeline(sentences, durationSec);
  }

  const anchors = [];
  let segCursor = 0;

  for (const text of sentences) {
    const match =
      consumeWhisperSegmentsForText(text, rows, segCursor) ||
      takeSequentialWhisperSegments(rows, segCursor, text);

    if (match) {
      segCursor = match.toIdx + 1;
      anchors.push({
        text,
        startSec: match.startSec,
        endSec: match.endSec
      });
      continue;
    }

    const prev = anchors[anchors.length - 1];
    const startSec = prev
      ? prev.endSec
      : rows[Math.min(segCursor, rows.length - 1)]?.start ?? 0;
    anchors.push({
      text,
      startSec,
      endSec: startSec + estimateSpeechDurationSec(text)
    });
  }

  const lines = [];
  for (let i = 0; i < anchors.length; i++) {
    const cur = anchors[i];
    let endSec = cur.endSec;
    if (durationSec > cur.startSec) {
      endSec = Math.min(endSec, durationSec);
    }
    if (endSec <= cur.startSec) {
      endSec = cur.startSec + 0.35;
    }

    const line = buildScriptLine({
      startSec: cur.startSec,
      endSec,
      text: cur.text,
      index: lines.length
    });

    if (i > 0) {
      const prevEnd = anchors[i - 1].endSec;
      if (cur.startSec - prevEnd >= AUTO_BLOCK_GAP_SEC - 0.5) {
        line.blockBreak = true;
      }
    }
    lines.push(line);
  }

  return lines;
}

function plainIndexForCompactOffset(plain, compactOffset) {
  const p = String(plain || "");
  if (compactOffset <= 0) return 0;
  let cc = 0;
  for (let i = 0; i < p.length; i++) {
    if (!/[\s\u3000、。！？!?,.]/.test(p[i])) {
      if (cc >= compactOffset) return i;
      cc++;
    }
  }
  return p.length;
}

function timingFromPlainSpan(plain, rows, hit, durationSec) {
  const timeAt = buildPlainOffsetTimeMapper(plain, rows, durationSec);
  const startSec = timeAt(hit.start);
  const endChar = Math.max(hit.start, hit.end - 1);
  let endSec = timeAt(endChar);
  if (endSec <= startSec) {
    endSec = timeAt(Math.min(plain.length - 1, hit.end));
  }
  if (endSec <= startSec) {
    endSec = startSec + 0.35;
  }
  const overlapping = rows.filter(
    (s) => s.end > startSec - 0.05 && s.start < endSec + 0.25
  );
  if (overlapping.length) {
    return {
      startSec: Math.min(startSec, overlapping[0].start),
      endSec: Math.max(endSec, ...overlapping.map((s) => segEndSec(s)))
    };
  }
  return { startSec, endSec };
}

/** 台詞テキストからセリフ単位に分割（改行＋句読点） */
export function speechChunksFromLineText(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .flatMap((row) => splitTextIntoSpeechChunks(row));
}

/**
 * 台本に無い Whisper 断片（エンドカードの社名など）を除外
 * @param {{ start: number, end: number, text: string }[]} segments
 * @param {string[]} scriptTexts
 * @param {number} [durationSec]
 */
export function filterWhisperSegmentsForScript(
  segments,
  scriptTexts,
  durationSec = 0
) {
  const rows = normalizeWhisperSegmentRows(segments);
  if (!rows.length) return [];

  const scriptPlain = compactJa(
    (scriptTexts || [])
      .map((t) => stripPlaceholderSpeakerLabel(stripTimecodeMarkupFromText(t)))
      .join("")
  );
  if (!scriptPlain) return rows;

  const segMatchesScript = (seg) => {
    const key = compactJa(seg.text);
    if (key.length < 2) return false;
    if (scriptPlain.includes(key)) return true;
    const probe = key.slice(0, Math.min(10, key.length));
    if (probe.length >= 4 && scriptPlain.includes(probe)) return true;
    return false;
  };

  const matched = rows.filter(segMatchesScript);
  if (matched.length >= 1) {
    return matched;
  }

  const dialogueEnd = rows.length
    ? Math.max(...rows.map((s) => s.end))
    : 0;
  const tailCutoff = Math.max(dialogueEnd + 1.5, durationSec * 0.88);

  return rows.filter((seg) => {
    if (segMatchesScript(seg)) return true;
    if (seg.start >= tailCutoff && seg.text.length <= 16) return false;
    if (/建設|株式会社|公式|チャンネル登録|提供|スポンサー/.test(seg.text)) {
      return false;
    }
    return seg.start < dialogueEnd + 0.5;
  });
}

/** 1行に複数セリフが詰まった粗いタイムコードか */
export function scriptLineNeedsWhisperRefine(line) {
  if (!line?.text?.trim()) return false;
  const chunks = speechChunksFromLineText(stripTimecodeMarkupFromText(line.text));
  const end =
    line.endSec != null && line.endSec > line.startSec
      ? line.endSec
      : line.startSec + estimateSpeechDurationSec(line.text);
  const span = end - line.startSec;
  return chunks.length >= 2 && span >= 5;
}

function locateTextSpanInPlain(plain, needle, fromIndex = 0) {
  const p = String(plain || "");
  const n = String(needle || "").trim();
  if (!n || !p) return null;

  let idx = p.indexOf(n, fromIndex);
  if (idx >= 0) return { start: idx, end: idx + n.length };

  const key = compactJa(n);
  if (key.length >= 4) {
    const pc = compactJa(p);
    const fromCompact = compactJa(p.slice(0, fromIndex)).length;
    let ci = pc.indexOf(key, fromCompact);
    let matchLen = key.length;
    if (ci < 0 && key.length >= 6) {
      for (let len = Math.min(20, key.length); len >= 4; len--) {
        const probe = key.slice(0, len);
        const pi = pc.indexOf(probe, fromCompact);
        if (pi >= 0) {
          ci = pi;
          matchLen = key.length;
          break;
        }
      }
    }
    if (ci >= 0) {
      const start = plainIndexForCompactOffset(p, ci);
      const end = plainIndexForCompactOffset(p, ci + matchLen);
      return { start, end: Math.max(end, start + 1), fuzzy: true };
    }
  }

  const ratio = fromIndex / Math.max(p.length, 1);
  const start = Math.min(p.length - 1, Math.floor(ratio * p.length));
  const end = Math.min(p.length, start + Math.max(8, compactJa(n).length));
  return { start, end, estimated: true };
}

/**
 * 各セリフを Whisper 文字起こし上の位置から start/end を付与
 */
export function timeSentencesFromWhisperSegments(
  sentences,
  segments,
  durationSec = 0
) {
  const rows = normalizeWhisperSegmentRows(segments);
  const list = (sentences || [])
    .map((t) => stripPlaceholderSpeakerLabel(stripTimecodeMarkupFromText(t)))
    .filter(Boolean);
  if (!list.length) return [];
  if (!rows.length) {
    return list.map((text, i) => ({
      text,
      startSec: i * 3,
      endSec: i * 3 + estimateSpeechDurationSec(text)
    }));
  }

  const plain = rows.map((r) => r.text).join("");
  const timed = [];
  let charCursor = 0;
  let segCursor = 0;

  for (const text of list) {
    const segMatch =
      consumeWhisperSegmentsForText(text, rows, segCursor) ||
      matchTextToWhisperSegments(text, rows, segCursor);
    if (segMatch) {
      segCursor = segMatch.toIdx + 1;
      timed.push({
        text,
        startSec: segMatch.startSec,
        endSec: segMatch.endSec
      });
      continue;
    }

    const hit = locateTextSpanInPlain(plain, text, charCursor);
    if (hit) {
      charCursor = Math.max(charCursor, hit.end);
      const { startSec, endSec } = timingFromPlainSpan(
        plain,
        rows,
        hit,
        durationSec
      );
      timed.push({ text, startSec, endSec });
      continue;
    }

    const prev = timed[timed.length - 1];
    const startSec = prev
      ? (prev.endSec ?? prev.startSec) + SPEECH_MERGE_MAX_GAP_SEC
      : rows[0].start;
    const endSec = startSec + estimateSpeechDurationSec(text);
    timed.push({ text, startSec, endSec });
  }

  return timed;
}

/**
 * セリフごとの時刻を 2秒/10秒 ルールでタイムコード行にまとめる
 */
export function groupTimedSentencesIntoScriptLines(timed, durationSec = 0) {
  if (!timed?.length) return [];

  const lines = [];
  let batch = null;

  const flush = () => {
    if (!batch) return;
    const line = buildScriptLine({
      startSec: batch.startSec,
      endSec: batch.endSec,
      text: batch.texts.join("\n"),
      index: lines.length
    });
    if (batch.blockBreak) line.blockBreak = true;
    lines.push(line);
    batch = null;
  };

  for (const ts of timed) {
    if (!batch) {
      batch = {
        startSec: ts.startSec,
        endSec: ts.endSec,
        texts: [ts.text],
        blockBreak: false
      };
      continue;
    }
    const gap = ts.startSec - batch.endSec;
    if (gap >= SPEECH_MERGE_MAX_GAP_SEC - 0.05) {
      flush();
      batch = {
        startSec: ts.startSec,
        endSec: ts.endSec,
        texts: [ts.text],
        blockBreak: gap >= AUTO_BLOCK_GAP_SEC - 0.5
      };
    } else {
      batch.texts.push(ts.text);
      batch.endSec = Math.max(batch.endSec, ts.endSec);
    }
  }
  flush();

  return normalizeScriptLineTimings(lines, durationSec);
}

export function buildGrokScriptLinesFromWhisper(
  sentences,
  segments,
  durationSec = 0
) {
  const clean = (sentences || [])
    .map((t) => stripPlaceholderSpeakerLabel(stripTimecodeMarkupFromText(t)))
    .filter(Boolean);
  if (!clean.length) return [];

  const rows = normalizeWhisperSegmentRows(segments);
  if (!rows.length) return [];

  return finishWhisperAlignedLines(
    alignOrderedTextsToWhisperSegments(clean, rows, durationSec),
    durationSec
  );
}

/**
 * 既に付いたタイムコード枠の中だけ Whisper で 2秒/10秒ルール分割（枠は維持）
 * @param {{ id?: string, startSec: number, endSec?: number|null, text: string, blockBreak?: boolean }[]} lines
 * @param {{ start: number, end: number, text: string }[]} segments
 * @param {number} [durationSec]
 */
export function refinePreparedTimecodedLines(lines, segments, durationSec = 0) {
  if (!lines?.length || !segments?.length) return lines || [];

  const out = [];
  for (const line of lines) {
    const text = stripTimecodeMarkupFromText(line.text);
    const chunks = speechChunksFromLineText(text);
    const lineEnd =
      line.endSec != null && line.endSec > line.startSec ? line.endSec : null;
    const span =
      (lineEnd ?? line.startSec + estimateSpeechDurationSec(text)) -
      line.startSec;

    if (chunks.length <= 1 || span < 3) {
      out.push(line);
      continue;
    }

    const windowEnd =
      lineEnd != null ? lineEnd : durationSec > line.startSec ? durationSec : 0;
    const segsInWindow = filterWhisperSegmentsForScript(
      segments,
      chunks,
      windowEnd
    ).filter((s) => s.end > line.startSec && s.start < windowEnd);
    if (!segsInWindow.length) {
      out.push(line);
      continue;
    }

    const sub = assignWhisperTimelineToTexts(chunks, segsInWindow, windowEnd);
    if (sub.length <= 1) {
      out.push(line);
      continue;
    }

    for (let i = 0; i < sub.length; i++) {
      out.push({
        ...sub[i],
        blockBreak: i === 0 ? !!line.blockBreak : false
      });
    }
  }

  return normalizeScriptLineTimings(out, durationSec);
}

export function buildScriptLinesFromWhisper(segments, durationSec = 0) {
  const rows = normalizeWhisperSegmentRows(segments);
  if (!rows.length) return [];

  const lines = [];
  let batch = null;

  const flush = () => {
    if (!batch) return;
    const text = batch.texts.join(" ").trim();
    if (!text) {
      batch = null;
      return;
    }
    const line = buildScriptLine({
      startSec: batch.startSec,
      endSec: batch.endSec,
      text,
      index: lines.length
    });
    if (batch.blockBreak) line.blockBreak = true;
    lines.push(line);
    batch = null;
  };

  for (const seg of rows) {
    const segEnd = seg.end > seg.start ? seg.end : seg.start + 0.35;
    if (!batch) {
      batch = { startSec: seg.start, endSec: segEnd, texts: [seg.text], blockBreak: false };
      continue;
    }
    let gap = seg.start - batch.endSec;
    if (gap < 0) {
      batch.endSec = Math.max(batch.endSec, segEnd);
      batch.texts.push(seg.text);
      continue;
    }
    if (gap < SPEECH_MERGE_MAX_GAP_SEC - 0.05) {
      batch.texts.push(seg.text);
      batch.endSec = Math.max(batch.endSec, segEnd);
    } else {
      flush();
      batch = {
        startSec: seg.start,
        endSec: segEnd,
        texts: [seg.text],
        blockBreak: gap >= AUTO_BLOCK_GAP_SEC - 0.5
      };
    }
  }
  flush();

  return normalizeScriptLineTimings(lines, durationSec);
}

/**
 * Grok セリフ（順序どおり）に Whisper セグメントを割り当てる。
 * 頭＝そのセリフの最初のセグメント開始、ケツ＝発話終了（次セグメントまで2秒未満なら結合）。
 * 前行のケツから次の頭まで10秒以上なら blockBreak。
 * @param {string[]} texts
 * @param {{ start: number, end: number, text: string }[]} segments
 * @param {number} [durationSec]
 */
export function assignWhisperTimelineToTexts(texts, segments, durationSec = 0) {
  const rows = normalizeWhisperSegmentRows(segments);
  return finishWhisperAlignedLines(
    alignOrderedTextsToWhisperSegments(texts, rows, durationSec),
    durationSec
  );
}

/**
 * Whisper で決めた発話ブロック（2秒/10秒ルール）に Grok の文を割り当てる。
 * 同一ブロック内の複数文は1つのタイムコードの下に改行で並べる。
 * @param {string[]} grokSentences
 * @param {{ id?: string, startSec: number, endSec?: number|null, text: string, blockBreak?: boolean }[]} whisperLines
 */
export function mapGrokSentencesToWhisperLines(grokSentences, whisperLines) {
  const sentences = (grokSentences || [])
    .map((s) => stripPlaceholderSpeakerLabel(stripTimecodeMarkupFromText(s)))
    .filter(Boolean);
  const blocks = (whisperLines || []).filter(
    (b) => b && Number.isFinite(b.startSec)
  );
  if (!sentences.length) return [];
  if (!blocks.length) {
    return sentences.map((text, i) =>
      buildScriptLine({ startSec: 0, endSec: null, text, index: i })
    );
  }
  if (sentences.length === blocks.length) {
    return blocks.map((b, i) => ({
      ...b,
      text: sentences[i],
      rawTc: formatTimeRange(b.startSec, b.endSec)
    }));
  }

  // Whisper 側で決めた行数（ブロック数）を崩さない：
  // Grok の文が多い場合は「各行に1文」＋ 残りは最後の行にまとめる。
  if (sentences.length > blocks.length) {
    const results = [];
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      const isLast = i === blocks.length - 1;
      const text = isLast ? sentences.slice(i).join("\n") : sentences[i];
      results.push({
        ...b,
        text,
        rawTc: formatTimeRange(b.startSec, b.endSec)
      });
    }
    return results;
  }

  const results = [];
  let si = 0;
  const totalChars = sentences.reduce((a, s) => a + s.length, 0) || 1;
  const totalDur =
    blocks.reduce(
      (a, b) =>
        a + Math.max(0.1, (b.endSec ?? b.startSec + 1) - b.startSec),
      0
    ) || 1;

  for (let bi = 0; bi < blocks.length; bi++) {
    const block = blocks[bi];
    const isLast = bi === blocks.length - 1;
    const dur = Math.max(
      0.1,
      (block.endSec ?? block.startSec + 1) - block.startSec
    );
    const charTarget = isLast
      ? totalChars
      : Math.round(totalChars * (dur / totalDur));

    const chunk = [];
    let chars = 0;
    while (si < sentences.length) {
      const sent = sentences[si];
      if (!isLast && chunk.length > 0 && chars >= charTarget * 0.8) {
        break;
      }
      chunk.push(sent);
      chars += sent.length;
      si++;
      if (!isLast && chars >= charTarget) break;
    }
    if (!chunk.length && si < sentences.length) {
      chunk.push(sentences[si++]);
    }

    results.push({
      ...block,
      text: chunk.join("\n"),
      rawTc: formatTimeRange(block.startSec, block.endSec)
    });
  }

  if (si < sentences.length && results.length) {
    const last = results[results.length - 1];
    last.text = [last.text, sentences.slice(si).join("\n")]
      .filter(Boolean)
      .join("\n");
    last.rawTc = formatTimeRange(last.startSec, last.endSec);
  }

  return results;
}

/**
 * Whisper セグメントを 2 秒ギャップでまとめた時間スパン一覧
 * @param {{ start: number, end: number, text: string }[]} segments
 */
export function buildWhisperTimeSpans(segments) {
  const rows = (segments || [])
    .map((s) => ({
      start: Math.max(0, Number(s.start) || 0),
      end: Math.max(0, Number(s.end) || 0),
      text: String(s.text || "").trim()
    }))
    .filter((s) => s.text);
  if (!rows.length) return [];

  const spans = [];
  let batchStart = null;
  let batchEnd = null;

  for (const seg of rows) {
    const segEnd = seg.end > seg.start ? seg.end : seg.start + 0.35;
    if (batchStart == null) {
      batchStart = seg.start;
      batchEnd = segEnd;
      continue;
    }
    const gap = seg.start - batchEnd;
    if (gap < SPEECH_MERGE_MAX_GAP_SEC - 0.05) {
      batchEnd = Math.max(batchEnd, segEnd);
    } else {
      spans.push({ start: batchStart, end: batchEnd });
      batchStart = seg.start;
      batchEnd = segEnd;
    }
  }
  if (batchStart != null) spans.push({ start: batchStart, end: batchEnd });
  return spans;
}

/**
 * @param {{ start: number, end: number }[]} spans
 * @param {number} count
 */
export function groupSpansToCount(spans, count) {
  if (!spans.length || count <= 0) return [];
  if (count === 1) {
    return [
      {
        start: spans[0].start,
        end: spans[spans.length - 1].end
      }
    ];
  }
  const groups = [];
  for (let i = 0; i < count; i++) {
    const from = Math.floor((i * spans.length) / count);
    const to = Math.max(from, Math.floor(((i + 1) * spans.length) / count) - 1);
    const slice = spans.slice(from, to + 1);
    groups.push({
      start: slice[0].start,
      end: slice[slice.length - 1].end
    });
  }
  return groups;
}

/**
 * 台本の各セリフを Whisper の時間軸に割り当てる（Grok 台本＋文字起こし）
 * @param {string[]} utterances
 * @param {{ start: number, end: number, text: string }[]} segments
 * @param {number} [durationSec]
 */
/**
 * Whisper から得た台本行の時間枠に、Grok セリフを順番どおり割り当てる
 * @param {string[]} texts
 * @param {{ id: string, startSec: number, endSec?: number|null, text: string, blockBreak?: boolean }[]} timingLines
 * @param {number} [durationSec]
 */
export function distributeTextsToTimingLines(texts, timingLines, durationSec = 0) {
  const clean = (texts || [])
    .map((t) => stripTimecodeMarkupFromText(t))
    .filter(Boolean);
  if (!clean.length || !timingLines?.length) return [];

  const n = clean.length;
  const m = timingLines.length;
  if (n === m) {
    return clean.map((text, i) => ({
      ...timingLines[i],
      text
    }));
  }

  const out = [];
  let textIdx = 0;
  for (let ti = 0; ti < m && textIdx < n; ti++) {
    const remainingBlocks = m - ti;
    const remainingTexts = n - textIdx;
    const count = Math.max(1, Math.ceil(remainingTexts / remainingBlocks));
    const blockTexts = clean.slice(textIdx, textIdx + count);
    textIdx += blockTexts.length;

    const tl = timingLines[ti];
    const blockStart = tl.startSec;
    const estDur = blockTexts.reduce(
      (s, t) => s + estimateSpeechDurationSec(t),
      0
    );
    const blockEnd =
      tl.endSec != null && tl.endSec > blockStart
        ? tl.endSec
        : blockStart + Math.max(0.35, estDur);
    const blockDur = Math.max(0.35, blockEnd - blockStart);
    const weights = blockTexts.map((t) => estimateSpeechDurationSec(t));
    const totalW = weights.reduce((a, b) => a + b, 0) || 1;
    let cursor = blockStart;

    blockTexts.forEach((text, bi) => {
      const share = (weights[bi] / totalW) * blockDur;
      const startSec = cursor;
      let endSec =
        bi === blockTexts.length - 1
          ? blockEnd
          : startSec + Math.max(0.35, share);
      if (endSec <= startSec) endSec = startSec + 0.35;
      cursor = endSec;
      const line = buildScriptLine({
        startSec,
        endSec,
        text,
        index: out.length
      });
      if (bi === 0 && tl.blockBreak) line.blockBreak = true;
      out.push(line);
    });
  }

  while (textIdx < n) {
    const last = out[out.length - 1];
    const startSec = last ? last.endSec ?? last.startSec : 0;
    const text = clean[textIdx++];
    const endSec = startSec + estimateSpeechDurationSec(text);
    out.push(
      buildScriptLine({
        startSec,
        endSec,
        text,
        index: out.length
      })
    );
  }

  if (durationSec > 0 && out.length) {
    const last = out[out.length - 1];
    if ((last.endSec ?? 0) < durationSec - 0.5) {
      last.endSec = durationSec;
      last.rawTc = formatTimeRange(last.startSec, last.endSec);
    }
  }

  return out;
}

export function alignUtterancesToWhisperSpans(
  utterances,
  segments,
  durationSec = 0
) {
  const texts = (utterances || [])
    .map((t) => stripPlaceholderSpeakerLabel(stripTimecodeMarkupFromText(t)))
    .filter(Boolean);
  if (!texts.length) return null;

  const lines = buildGrokScriptLinesFromWhisper(texts, segments, durationSec);
  return lines.length ? lines : null;
}

/**
 * 10 秒以上空く行の前に blockBreak を付与
 */
export function applyBlockBreaksFromGaps(lines) {
  if (!lines?.length) return [];
  const out = lines.map((l) => ({ ...l }));
  for (let i = 1; i < out.length; i++) {
    const prev = out[i - 1];
    const prevEnd =
      prev.endSec != null && prev.endSec > prev.startSec
        ? prev.endSec
        : prev.startSec;
    const gap = out[i].startSec - prevEnd;
    if (gap >= AUTO_BLOCK_GAP_SEC - 0.5) {
      out[i].blockBreak = true;
    }
  }
  return out;
}

function pushParsedLine(lines, prevByKey, parts, indexRef) {
  const startSec = parts.startSec;
  const end =
    parts.endSec != null && parts.endSec > startSec ? parts.endSec : null;
  const text = (parts.text || "").trim();
  if (!text) return;
  const key = lineIdentityKey(startSec, end, text);
  const id =
    prevByKey.get(key) ||
    stableCueId({ startSec, endSec: end, text, index: ++indexRef.i });
  lines.push({
    id,
    startSec,
    endSec: end,
    text,
    rawTc: formatTimeRange(startSec, parts.endSec ?? end)
  });
}

export function parseScriptLines(raw, opts = {}) {
  const trimmed = String(raw || "").trim();
  if (trimmed && isSrtDocument(trimmed)) {
    return parseSrtToScriptLines(trimmed, opts);
  }

  const prevByKey = new Map();
  for (const l of opts.previousLines || []) {
    prevByKey.set(lineIdentityKey(l.startSec, l.endSec, l.text), l.id);
  }
  const lines = [];
  const indexRef = { i: 0 };
  let pendingTc = null;
  let pendingBlockBreak = false;

  const flushPendingTc = () => {
    if (!pendingTc?.textLines?.length) {
      pendingTc = null;
      return;
    }
    pushLine({
      startSec: pendingTc.startSec,
      endSec: pendingTc.endSec,
      text: pendingTc.textLines.join("\n")
    });
    pendingTc = null;
  };

  const pushLine = (parts) => {
    pushParsedLine(lines, prevByKey, parts, indexRef);
    if (pendingBlockBreak && lines.length) {
      lines[lines.length - 1].blockBreak = true;
      pendingBlockBreak = false;
    }
  };

  for (const row of raw.split(/\r?\n/)) {
    const line = row.trim();
    if (!line) continue;
    if (/^---\s*WAVRICK_CAST\s*---$/i.test(line)) continue;
    if (line === "---" || line === "[NEW_BLOCK]") {
      flushPendingTc();
      pendingBlockBreak = true;
      continue;
    }
    if (/^【[^】]+】\s*$/.test(line)) continue;

    const tcOnly = line.match(TC_ONLY_RE);
    if (tcOnly) {
      flushPendingTc();
      pendingTc = {
        startSec: parseTimeParts(tcOnly[1], tcOnly[2], tcOnly[3]),
        endSec:
          tcOnly[4] != null
            ? parseTimeParts(tcOnly[4], tcOnly[5], tcOnly[6])
            : null,
        textLines: []
      };
      continue;
    }

    const m = line.match(LINE_RE);
    if (m && m[7].trim()) {
      flushPendingTc();
      pushLine({
        startSec: parseTimeParts(m[1], m[2], m[3]),
        endSec: m[4] != null ? parseTimeParts(m[4], m[5], m[6]) : null,
        text: m[7].trim()
      });
      continue;
    }

    if (pendingTc) {
      if (!pendingTc.textLines) pendingTc.textLines = [];
      pendingTc.textLines.push(line);
      continue;
    }

    const inline = splitTextByInlineTimecodes(line);
    if (inline) {
      for (const part of inline) {
        pushLine(part);
      }
      continue;
    }
  }

  flushPendingTc();

  return lines;
}

export const DEMO_SCRIPT = "";

export const DEFAULT_YOUTUBE_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

export function extractYouTubeVideoId(url) {
  const u = (url || "").trim();
  if (!u) return "";
  try {
    const parsed = new URL(u);
    const host = parsed.hostname.replace(/^www\./, "");
    if (host === "youtu.be") return parsed.pathname.slice(1).split("/")[0] || "";
    if (host.includes("youtube.com")) {
      if (parsed.pathname.startsWith("/shorts/")) {
        return parsed.pathname.split("/")[2] || "";
      }
      return parsed.searchParams.get("v") || "";
    }
  } catch {
    /* fall through */
  }
  const m = u.match(/(?:v=|youtu\.be\/|shorts\/)([a-zA-Z0-9_-]{6,})/);
  return m ? m[1] : "";
}
