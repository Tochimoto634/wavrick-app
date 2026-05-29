/**
 * 依頼フォーム（ytScript）→ 収録ワークスペース用の台本変換・引き継ぎ
 */

import {
  parseScriptLines,
  parseTimeParts,
  formatTimecode,
  normalizeScriptLineTimings,
  buildScriptLine,
  alignUtterancesToWhisperSpans,
  buildGrokScriptLinesFromWhisper,
  assignWhisperTimelineToTexts,
  filterWhisperSegmentsForScript,
  scriptLineNeedsWhisperRefine,
  refinePreparedTimecodedLines,
  resolveTimelineDurationSec,
  clampWhisperSegmentsToTimeline,
  estimateSpeechDurationSec,
  splitTextIntoSpeechChunks,
  splitTextByInlineTimecodes,
  expandScriptLinesWithInlineTimecodes,
  scriptLinesToText,
  isTimecodeOnlyLine,
  stripTimecodeMarkupFromText,
  stripPlaceholderSpeakerLabel,
  TC_ONLY_LINE_RE
} from "./timecode.js?v=rw-bracket-grok-2026-05-28";

import {
  buildScriptLinesFromWhisperSilenceGapRules,
  buildSrtFromWhisperSegments
} from "./timecode-silence-gap.js?v=rw-srt-tc-2026-05-28";
import { isSrtDocument } from "./srt-timecode.js?v=rw-srt-tc-2026-05-28";

export const WAVRICK_RW_HANDOFF_KEY = "wavrick_rw_handoff";

/** 稼働確認マーカー [Wavrick-N] を除去 */
export function stripTranscribeBuildMarker(raw) {
  return String(raw || "")
    .replace(/\n?\[Wavrick-\d+\]\s*$/i, "")
    .trim();
}

/** Grok / Whisper-SRT がタイムコード付きで返した台本か（フロント再計算をスキップ） */
export function isGrokTimecodedScript(raw) {
  const t = stripTranscribeBuildMarker(String(raw || "").trim());
  if (!t) return false;
  if (isSrtDocument(t)) return true;
  if (!/\[\d{1,2}:\d{2}/.test(t)) return false;
  const rows = t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!rows.length) return false;
  const tcLineRe =
    /^\[\d{1,2}:\d{2}(?:\.\d{1,3})?\s*(?:->|→|-)\s*\d{1,2}:\d{2}(?:\.\d{1,3})?\]\s+\S/;
  const tcCount = rows.filter((l) => tcLineRe.test(l)).length;
  return tcCount >= 1 && tcCount >= Math.min(2, rows.length * 0.25);
}

const LINE_RE =
  /^\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?(?:\s*(?:->|→|-)\s*(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?)?\]\s*(.+)$/;

const CAST_BLOCK_START = /^---\s*WAVRICK_CAST\s*---$/i;
const SECTION_HEAD_RE = /^【([^】]+)】\s*$/;
const SECTION_HEAD_SKIP_RE = /^【(参考:|結合版)/;

/**
 * @param {{ videoUrl?: string, script?: string }} payload
 */
export function saveHandoff(payload) {
  try {
    sessionStorage.setItem(
      WAVRICK_RW_HANDOFF_KEY,
      JSON.stringify({
        videoUrl: (payload.videoUrl || "").trim(),
        script: (payload.script || "").trim(),
        requestId: (payload.requestId || "").trim() || null,
        projectId: (payload.projectId || "").trim() || null,
        deliveryId: (payload.deliveryId || "").trim() || null,
        rawAudioUrl: (payload.rawAudioUrl || "").trim() || null,
        cleanedAudioUrl: (payload.cleanedAudioUrl || "").trim() || null,
        whisperSegments: Array.isArray(payload.whisperSegments)
          ? payload.whisperSegments
          : null,
        whisperDurationSec: Number(payload.whisperDurationSec) || 0,
        savedAt: Date.now()
      })
    );
    return true;
  } catch {
    return false;
  }
}

function resolveHandoffScript(data) {
  if (!data || typeof data !== "object") return "";
  if (data.scriptRef) {
    try {
      return String(localStorage.getItem(`wavrick_rw_script_${data.scriptRef}`) || "").trim();
    } catch {
      return "";
    }
  }
  return String(data.script || "").trim();
}

/** @returns {{ videoUrl: string, script: string, savedAt: number, requestId: string|null, projectId: string|null, deliveryId: string|null }|null} */
export function consumeHandoff() {
  try {
    const raw = sessionStorage.getItem(WAVRICK_RW_HANDOFF_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(WAVRICK_RW_HANDOFF_KEY);
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") return null;
    const requestId = data.requestId ? String(data.requestId) : null;
    if (requestId && globalThis.WavrickWorkCases?.setSelectedCaseId) {
      globalThis.WavrickWorkCases.setSelectedCaseId(requestId);
    }
    const videoUrl = String(data.videoUrl || "").trim();
    const script = resolveHandoffScript(data);
    if (script) persistScriptToRequest(videoUrl, script);
    return {
      videoUrl,
      script,
      requestId,
      projectId: data.projectId ? String(data.projectId) : null,
      deliveryId: data.deliveryId ? String(data.deliveryId) : null,
      rawAudioUrl: data.rawAudioUrl ? String(data.rawAudioUrl) : null,
      cleanedAudioUrl: data.cleanedAudioUrl ? String(data.cleanedAudioUrl) : null,
      whisperSegments: Array.isArray(data.whisperSegments)
        ? data.whisperSegments
        : null,
      whisperDurationSec: Number(data.whisperDurationSec) || 0,
      savedAt: Number(data.savedAt) || 0
    };
  } catch {
    return null;
  }
}

function persistScriptToRequest(videoUrl, script) {
  try {
    const rows = JSON.parse(localStorage.getItem("wavrick_youtube_requests") || "[]");
    const match = rows.find(r => r.videoUrl === videoUrl);
    if (match) { match.script = script; }
    else { rows.push({ requestId: `adhoc_${Date.now()}`, videoUrl, script, name: "ブース直接", createdAt: new Date().toISOString() }); }
    localStorage.setItem("wavrick_youtube_requests", JSON.stringify(rows));
  } catch (e) { /* ignore */ }
}

/** タイムコード付き台本を案件ストレージへ保存（再オープン時も維持） */
export function persistTimecodedScriptToRequest({
  videoUrl = "",
  requestId = "",
  script = "",
  whisperSegments = null,
  whisperDurationSec = 0
} = {}) {
  try {
    const rows = JSON.parse(localStorage.getItem("wavrick_youtube_requests") || "[]");
    const id = String(requestId || "").trim();
    const match =
      (id && rows.find((r) => r.requestId === id)) ||
      rows.find((r) => r.videoUrl === videoUrl);
    if (match) {
      if (script) match.script = script;
      if (Array.isArray(whisperSegments) && whisperSegments.length) {
        match.whisperSegments = whisperSegments.slice(0, 2500);
        match.whisperDurationSec = Number(whisperDurationSec) || 0;
      }
      match.updatedAt = new Date().toISOString();
    } else if (videoUrl && script) {
      rows.push({
        requestId: id || `adhoc_${Date.now()}`,
        videoUrl,
        script,
        whisperSegments: Array.isArray(whisperSegments)
          ? whisperSegments.slice(0, 2500)
          : null,
        whisperDurationSec: Number(whisperDurationSec) || 0,
        name: "ブース直接",
        createdAt: new Date().toISOString()
      });
    }
    localStorage.setItem("wavrick_youtube_requests", JSON.stringify(rows));
  } catch {
    /* ignore */
  }
}

/**
 * 全文からタイムコード行だけを抜き出す
 * @param {string} raw
 */
export function extractTimecodedBlock(raw) {
  const lines = parseScriptLines(raw);
  if (lines.length) return scriptLinesToText(lines);
  return "";
}

function linesHaveInlineTimecodes(lines) {
  return (lines || []).some((l) => /\[\d{1,2}:\d{2}/.test(l.text || ""));
}

/** 1行にまとまった長文をセリフ単位に展開 */
export function expandUtterancesToSpeechLines(utterances) {
  const out = [];
  for (const u of utterances || []) {
    const base = stripTimecodeMarkupFromText(u.text);
    if (!base || isTimecodeOnlyLine(base)) continue;
    const chunks = splitTextIntoSpeechChunks(base);
    if (chunks.length <= 1) {
      out.push({ ...u, text: base });
      continue;
    }
    for (const text of chunks) {
      out.push({ text, startSec: u.startSec ?? null, endSec: u.endSec ?? null });
    }
  }
  return out;
}

function retimeTextsWithWhisper(texts, segments, durationSec) {
  if (!segments?.length) return [];
  const sentences = (texts || [])
    .flatMap((t) =>
      splitTextIntoSpeechChunks(
        stripPlaceholderSpeakerLabel(stripTimecodeMarkupFromText(t))
      )
    )
    .filter(Boolean);
  if (!sentences.length) return [];
  return assignWhisperTimelineToTexts(sentences, segments, durationSec);
}

function estimateTimingsForSentences(
  sentences,
  durationSec,
  startSec,
  endSec
) {
  const clean = (sentences || []).map((t) =>
    stripTimecodeMarkupFromText(t)
  ).filter((t) => String(t || "").trim());
  if (!clean.length) return [];

  const n = clean.length;
  const baseStart = Number.isFinite(startSec) ? startSec : 0;
  const baseEnd =
    endSec != null && Number.isFinite(endSec)
      ? endSec
      : durationSec > 0
        ? durationSec
        : baseStart;
  const totalDuration = Math.max(0.1, baseEnd - baseStart);

  const gapWanted = 2.2; // 次セリフ開始まで 2秒以上10秒以内想定
  const speechDurations = clean.map((t) => estimateSpeechDurationSec(t));
  const totalSpeech = speechDurations.reduce((a, b) => a + b, 0) || 1;
  const remainingForSpeech = totalDuration - (n - 1) * gapWanted;
  const speechScale = remainingForSpeech > 0 ? remainingForSpeech / totalSpeech : 0.35;

  let cursor = baseStart;
  const out = [];
  for (let i = 0; i < n; i++) {
    const dur = Math.max(0.35, speechDurations[i] * speechScale);
    const s = cursor;
    const e = s + dur;
    out.push(buildScriptLine({ startSec: s, endSec: e, text: clean[i], index: out.length }));
    cursor = e + (i < n - 1 ? gapWanted : 0);
  }

  return normalizeScriptLineTimings(out, baseEnd);
}

/** タイムコードなしのプレーンテキスト台本からセリフ列を抽出 */
function extractPlainScriptSentences(raw) {
  const t = String(raw || "").trim();
  if (!t || /\[\d{1,2}:\d{2}/.test(t) || /【[^】]+】/.test(t)) return [];
  return t
    .split(/\r?\n/)
    .map((row) =>
      stripPlaceholderSpeakerLabel(stripTimecodeMarkupFromText(row))
    )
    .filter(Boolean)
    .flatMap((line) => splitTextIntoSpeechChunks(line));
}

function isFlatPreparedTimecodedScript(raw) {
  const t = String(raw || "").trim();
  if (!t || /【[^】]+】/.test(t)) return false;
  const lines = parseScriptLines(t);
  if (!lines.length) return false;
  if (lines.some((l) => isTimecodeOnlyLine(l.text))) return false;
  if (lines.length === 1 && lines[0].text.length > 36) return false;
  if (lines.some((l) => splitTextIntoSpeechChunks(l.text).length > 1)) return false;
  return lines.every((l) => Boolean(l.text?.trim()));
}

/** セリフごとにタイムコード行が付いている（粗い再結合は不要） */
export function isPerLineTimecodedScript(raw) {
  const t = String(raw || "").trim();
  if (!t || !/\[\d{1,2}:\d{2}/.test(t)) return false;

  const parsed = parseScriptLines(t);
  if (parsed.length < 2) return false;
  if (parsed.some((l) => scriptLineNeedsWhisperRefine(l))) return false;

  const rows = t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const tcHeaders = rows.filter(
    (l) => TC_ONLY_LINE_RE.test(l) || LINE_RE.test(l)
  ).length;
  return tcHeaders >= 2;
}

/** 顧客画面などで既に付いたタイムコード台本か */
export function isPreparedTimecodedScript(raw) {
  const t = String(raw || "").trim();
  if (!t || !/\[\d{1,2}:\d{2}/.test(t)) return false;
  if (isPerLineTimecodedScript(t)) return true;
  if (isFlatPreparedTimecodedScript(t)) return true;

  const parsed = parseScriptLines(t);
  if (parsed.some((l) => scriptLineNeedsWhisperRefine(l))) return false;

  const rows = t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const tcOnlyRows = rows.filter((l) => TC_ONLY_LINE_RE.test(l));
  if (tcOnlyRows.length >= 2) return true;

  if (parsed.length >= 2) {
    const starts = new Set(parsed.map((l) => Math.round(l.startSec * 100)));
    if (starts.size >= 2) return true;
  }
  return false;
}

function isPipelineGrokScript(raw) {
  const t = String(raw || "").trim();
  if (!t) return false;
  if (isFlatPreparedTimecodedScript(t)) return false;
  if (!/【[^】]+】/.test(t)) return false;
  if (CAST_BLOCK_START.test(t)) return true;
  return extractUtterancesFromPipelineRaw(t).some((u) => u.startSec == null);
}

/**
 * Grok 台本のテキスト + Whisper の発話タイミングで台本行を組み立てる
 */
export function buildScriptLinesFromGrokAndWhisper(
  grokRaw,
  segments,
  durationSec = 0
) {
  const grokUtterances = expandUtterancesToSpeechLines(
    extractUtterancesFromPipelineRaw(grokRaw).map((u) => ({
      ...u,
      text: stripPlaceholderSpeakerLabel(stripTimecodeMarkupFromText(u.text))
    }))
  );
  const texts = grokUtterances.map((u) => u.text).filter(Boolean);

  if (!texts.length) {
    const timingLines = buildScriptLinesFromWhisperSilenceGapRules(
      segments,
      durationSec
    );
    return {
      lines: timingLines,
      source: timingLines.length ? "whisper" : "empty"
    };
  }

  if (!segments?.length) {
    return { lines: [], source: "empty" };
  }

  // Whisper が「ブロック」でしか分解できない場合でも、
  // Grok の各文に対して start/end を割り当ててから 2秒/10秒ルールで行分割する。
  // これにより「1つのタイムコードに全テキストがまとめられる」ケースを避ける。
  const lines = buildGrokScriptLinesFromWhisper(texts, segments, durationSec);
  return {
    lines,
    source: lines.length ? "grok-whisper-mapped" : "empty"
  };
}

/**
 * Grok 台本からセリフ行を抽出（行内の [00:xx] も解釈）
 * @param {string} raw
 */
export function extractUtterancesFromPipelineRaw(raw) {
  const rows = raw.split(/\r?\n/);
  const utterances = [];
  let inCast = false;
  let skipSection = false;
  let currentSpeaker = "";
  let body = [];
  let pendingTc = null;

  const speakerPrefix = (lineText) => {
    const t = String(lineText || "").trim();
    if (!currentSpeaker || /^\([^)]+\)\s/.test(t)) return "";
    if (/^話者\d+$/i.test(currentSpeaker)) return "";
    return `(${currentSpeaker}) `;
  };

  const flush = () => {
    for (const text of body) {
      const t = text.trim();
      if (!t || t === "（空）") continue;
      if (isTimecodeOnlyLine(t)) {
        const tc = t.match(TC_ONLY_LINE_RE);
        if (tc) {
          pendingTc = {
            startSec: parseTimeParts(tc[1], tc[2], tc[3]),
            endSec:
              tc[4] != null ? parseTimeParts(tc[4], tc[5], tc[6]) : null
          };
        }
        continue;
      }
      const m = t.match(LINE_RE);
      if (m) {
        const startSec = parseTimeParts(m[1], m[2], m[3]);
        const endSec =
          m[4] != null ? parseTimeParts(m[4], m[5], m[6]) : null;
        utterances.push({
          text: stripTimecodeMarkupFromText(`${speakerPrefix(m[7])}${m[7].trim()}`),
          startSec: pendingTc?.startSec ?? startSec,
          endSec:
            pendingTc?.endSec ??
            (endSec != null && endSec > startSec ? endSec : null)
        });
        pendingTc = null;
      } else {
        const full = stripTimecodeMarkupFromText(`${speakerPrefix(t)}${t}`);
        if (!full) continue;
        const inlineParts = splitTextByInlineTimecodes(full);
        if (inlineParts) {
          for (const part of inlineParts) {
            utterances.push({
              ...part,
              text: stripTimecodeMarkupFromText(part.text),
              startSec: part.startSec ?? pendingTc?.startSec ?? null,
              endSec: part.endSec ?? pendingTc?.endSec ?? null
            });
          }
        } else {
          const chunks = splitTextIntoSpeechChunks(full);
          for (const chunk of chunks) {
            utterances.push({
              text: chunk,
              startSec: pendingTc?.startSec ?? null,
              endSec: pendingTc?.endSec ?? null
            });
          }
        }
        pendingTc = null;
      }
    }
    body = [];
  };

  for (const row of rows) {
    const t = row.trim();
    if (!t) continue;
    if (CAST_BLOCK_START.test(t)) {
      flush();
      currentSpeaker = "";
      skipSection = false;
      inCast = true;
      continue;
    }
    if (inCast) {
      if (t === "---") inCast = false;
      continue;
    }
    if (SECTION_HEAD_SKIP_RE.test(t)) {
      flush();
      currentSpeaker = "";
      skipSection = true;
      continue;
    }
    const sec = t.match(SECTION_HEAD_RE);
    if (sec) {
      flush();
      skipSection = false;
      currentSpeaker = sec[1]
        .replace(/\s*\/\s*声優:.*/, "")
        .replace(/\s*\/\s*ブロック\d+\s*$/, "")
        .trim();
      continue;
    }
    if (skipSection) continue;
    body.push(t);
  }
  flush();
  return utterances.filter((u) => u.text && !isTimecodeOnlyLine(u.text));
}

function timedRowsToScript(rows, durationSec) {
  const normalized = normalizeScriptLineTimings(
    rows.map((row, i) => ({
      id: `pipe-${i}`,
      startSec: row.startSec,
      endSec: row.endSec,
      text: row.text,
      rawTc: ""
    })),
    durationSec
  );
  return scriptLinesToText(normalized);
}

/**
 * 話者ブロック形式（Grok 生成）をタイムコード台本に変換
 * @param {string} raw
 * @param {number} [durationSec]
 * @param {{ start: number, end: number, text: string }[]} [whisperSegments]
 */
export function convertPipelineScriptToTimecoded(
  raw,
  durationSec = 0,
  whisperSegments = null
) {
  const utterances = extractUtterancesFromPipelineRaw(raw);
  if (!utterances.length) {
    return { script: "", source: "empty" };
  }

  const allHaveTc = utterances.every((u) => u.startSec != null);
  let timed = null;
  let source = "estimated";

  if (allHaveTc) {
    timed = utterances.map((u) => ({
      text: u.text,
      startSec: u.startSec,
      endSec: u.endSec
    }));
    source = "timecoded";
  } else if (Array.isArray(whisperSegments) && whisperSegments.length) {
    const aligned = alignUtterancesToWhisperSpans(
      utterances.map((u) => u.text),
      whisperSegments,
      durationSec
    );
    if (aligned?.length) {
      timed = aligned;
      source = "whisper-aligned";
    }
  }

  if (!timed) {
    const n = utterances.length;
    const speechDurations = utterances.map((u) =>
      estimateSpeechDurationSec(u.text)
    );
    const totalSpeech = speechDurations.reduce((a, b) => a + b, 0);
    const gapBetween = 0.12;
    const totalGaps = Math.max(0, n - 1) * gapBetween;
    const available =
      durationSec > 1
        ? Math.max(totalSpeech, durationSec * 0.98 - totalGaps)
        : totalSpeech + totalGaps;
    let cursor = 0;
    timed = utterances.map((u, i) => {
      const dur =
        durationSec > 1 && totalSpeech > 0
          ? (speechDurations[i] / totalSpeech) *
            (available - totalGaps)
          : speechDurations[i];
      const start = cursor;
      let end = start + Math.max(0.35, dur);
      if (durationSec > 1) {
        end = Math.min(end, durationSec);
      }
      cursor = end + gapBetween;
      return { text: u.text, startSec: start, endSec: end };
    });
    source = "estimated";
  }

  const script = timedRowsToScript(timed, durationSec);
  return { script, source };
}

/**
 * @param {string} raw
 * @param {number} [durationSec]
 * @param {{ whisperSegments?: { start: number, end: number, text: string }[]|null }} [opts]
 */
function resolvePrepareTimeline(durationSec, opts = {}) {
  const explicit =
    Number(durationSec) > 0
      ? Number(durationSec)
      : Number(opts.whisperDurationSec) > 0
        ? Number(opts.whisperDurationSec)
        : 0;
  const dur = resolveTimelineDurationSec(explicit, opts.whisperSegments);
  const segments =
    dur > 0 && Array.isArray(opts.whisperSegments)
      ? clampWhisperSegmentsToTimeline(opts.whisperSegments, dur)
      : opts.whisperSegments;
  return { dur, segments, whisperDurationSec: dur };
}

function extractScriptTextsForWhisperAlign(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return [];

  if (isPipelineGrokScript(trimmed)) {
    return expandUtterancesToSpeechLines(
      extractUtterancesFromPipelineRaw(trimmed).map((u) => ({
        ...u,
        text: stripPlaceholderSpeakerLabel(stripTimecodeMarkupFromText(u.text))
      }))
    )
      .map((u) => u.text)
      .filter(Boolean);
  }

  if (!/\[\d{1,2}:\d{2}/.test(trimmed) && !/【[^】]+】/.test(trimmed)) {
    return extractPlainScriptSentences(trimmed);
  }

  if (/\[\d{1,2}:\d{2}/.test(trimmed)) {
    return parseScriptLines(trimmed)
      .map((l) =>
        stripPlaceholderSpeakerLabel(stripTimecodeMarkupFromText(l.text))
      )
      .filter(Boolean)
      .flatMap((t) => splitTextIntoSpeechChunks(t));
  }

  return [];
}

export function prepareScriptForWorkspace(raw, durationSec = 0, opts = {}) {
  const trimmed = (raw || "").trim();
  const timeline = resolvePrepareTimeline(durationSec, opts);
  const dur = timeline.dur;
  const whisperSegments = timeline.segments;

  // Grok / SRT タイムコード台本は再割当・無音ループ計算を行わない
  if (isGrokTimecodedScript(trimmed)) {
    const lines = parseScriptLines(trimmed);
    if (lines.length) {
      const script = isSrtDocument(trimmed)
        ? trimmed
        : scriptLinesToText(lines);
      return {
        script,
        source: isSrtDocument(trimmed) ? "grok-srt" : "grok-timecoded",
        lineCount: lines.length
      };
    }
  }

  const whisperFallback = () => {
    if (!Array.isArray(whisperSegments) || !whisperSegments.length) {
      return null;
    }
    const srt = buildSrtFromWhisperSegments(whisperSegments, dur);
    if (!srt) return null;
    const lines = parseScriptLines(srt);
    return {
      script: srt,
      source: "whisper-srt",
      lineCount: lines.length || srt.split(/\n\s*\n/).length
    };
  };

  const alignWithWhisper = (texts, source) => {
    if (!texts?.length || !whisperSegments?.length) return null;
    const lines = buildGrokScriptLinesFromWhisper(texts, whisperSegments, dur);
    if (!lines.length) return null;
    return {
      script: scriptLinesToText(lines),
      source,
      lineCount: lines.length
    };
  };

  if (!trimmed) {
    return whisperFallback() || { script: "", source: "empty", lineCount: 0 };
  }

  if (whisperSegments?.length) {
    const texts = extractScriptTextsForWhisperAlign(trimmed);
    const aligned = alignWithWhisper(texts, "whisper-v4");
    if (aligned) return aligned;
  }

  const timecoded = extractTimecodedBlock(trimmed);
  if (timecoded) {
    let lines = normalizeScriptLineTimings(parseScriptLines(timecoded), dur);

    if (isPreparedTimecodedScript(trimmed) && !whisperSegments?.length) {
      const needsRefine = lines.some((l) => scriptLineNeedsWhisperRefine(l));
      if (needsRefine) {
        lines = refinePreparedTimecodedLines(lines, whisperSegments, dur);
      }
      if (linesHaveInlineTimecodes(lines)) {
        lines = normalizeScriptLineTimings(
          expandScriptLinesWithInlineTimecodes(lines),
          dur
        );
      }
      return {
        script: scriptLinesToText(lines),
        source: "timecoded-preserved",
        lineCount: lines.length
      };
    }

    const tcSentences = lines.flatMap((l) =>
      splitTextIntoSpeechChunks(stripTimecodeMarkupFromText(l.text))
    );
    if (tcSentences.length > 1) {
      if (whisperSegments?.length) {
        lines = retimeTextsWithWhisper(tcSentences, whisperSegments, dur);
      } else {
        const base = lines[0] || { startSec: 0, endSec: dur };
        lines = estimateTimingsForSentences(
          tcSentences,
          dur,
          base.startSec,
          base.endSec != null ? base.endSec : dur
        );
      }
    } else if (linesHaveInlineTimecodes(lines)) {
      lines = normalizeScriptLineTimings(
        expandScriptLinesWithInlineTimecodes(lines),
        dur
      );
    }
    if (lines.length > 0) {
      return {
        script: scriptLinesToText(lines),
        source: "timecoded",
        lineCount: lines.length
      };
    }
  }

  const converted = convertPipelineScriptToTimecoded(
    trimmed,
    dur,
    whisperSegments
  );
  let lines = normalizeScriptLineTimings(
    parseScriptLines(converted.script),
    dur
  );
  if (linesHaveInlineTimecodes(lines)) {
    lines = normalizeScriptLineTimings(
      expandScriptLinesWithInlineTimecodes(lines),
      dur
    );
  }
  if (lines.length > 0) {
    return {
      script: scriptLinesToText(lines),
      source: converted.source,
      lineCount: lines.length
    };
  }

  return (
    whisperFallback() || {
      script: "",
      source: "empty",
      lineCount: 0
    }
  );
}
