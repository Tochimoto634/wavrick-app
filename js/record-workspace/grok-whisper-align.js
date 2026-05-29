/**
 * Grok 吹替 → WhisperX タイムラインへ時刻を固定でマージ
 */

import { formatBracketTimecode } from "./srt-timecode.js?v=rw-whisper-build7-2026-05-28";

const BRACKET_LINE_RE =
  /^\[(\d{1,2}):(\d{2})\.(\d{2})\s*-\s*(\d{1,2}):(\d{2})\.(\d{2})\]\s*(.*)$/;

const BRACKET_LINE_RE_FLEX =
  /^\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\s*(?:-\s*(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?)?\]\s*(.*)$/;

function parseBracketPart(min, sec, frac) {
  const s = Number(sec) || 0;
  const f = frac != null && frac !== "" ? Number(frac) : 0;
  const digits = String(frac || "").length;
  let sub = 0;
  if (digits <= 2) sub = f / 100;
  else if (digits === 3) sub = f / 1000;
  else if (digits > 0) sub = f / Math.pow(10, digits);
  return (Number(min) || 0) * 60 + s + sub;
}

export function stripTranscribeBuildMarker(raw) {
  return String(raw || "")
    .replace(/\n?\[Wavrick-\d+\]\s*$/i, "")
    .trim();
}

/**
 * @param {string} raw
 * @returns {{ startSec: number, endSec: number, text: string }[]}
 */
export function parseBracketTimelineText(raw) {
  const t = stripTranscribeBuildMarker(raw);
  const rows = [];
  for (const line of t.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === "[NEW_BLOCK]") continue;
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

export function formatBracketTimelineRow(row) {
  const end = row.endSec > row.startSec ? row.endSec : row.startSec + 0.35;
  return `[${formatBracketTimecode(row.startSec)} - ${formatBracketTimecode(end)}] ${row.text}`;
}

/**
 * @param {string} whisperTimeline
 * @param {string[]} translations
 */
export function mergeTranslationsIntoWhisperTimeline(whisperTimeline, translations) {
  const canon = parseBracketTimelineText(whisperTimeline);
  if (!canon.length) return stripTranscribeBuildMarker(whisperTimeline);
  const out = canon.map((row, i) => {
    const t = String(translations[i] ?? "").trim();
    return { ...row, text: t || row.text };
  });
  return out.map(formatBracketTimelineRow).join("\n");
}

/**
 * Grok 出力からセリフ本文だけ抽出（時刻は無視）
 * @param {string} grokScript
 * @returns {string[]}
 */
export function extractDialogueTextsFromGrokScript(grokScript) {
  const texts = [];
  for (const line of String(grokScript || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (
      !trimmed ||
      trimmed === "[NEW_BLOCK]" ||
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

/**
 * Grok の時刻を捨て、WhisperX タイムラインの時刻をそのまま使う
 * @param {string} whisperTimeline
 * @param {string} grokScript
 */
export function alignGrokScriptToWhisperTimeline(whisperTimeline, grokScript) {
  const canon = parseBracketTimelineText(whisperTimeline);
  if (!canon.length) return grokScript;
  const grokTexts = extractDialogueTextsFromGrokScript(grokScript);
  if (!grokTexts.length) return grokScript;

  if (grokTexts.length === canon.length) {
    return mergeTranslationsIntoWhisperTimeline(whisperTimeline, grokTexts);
  }

  const translations = canon.map((row, i) => {
    if (i < grokTexts.length) return grokTexts[i];
    return row.text;
  });
  return mergeTranslationsIntoWhisperTimeline(whisperTimeline, translations);
}

function normalizeForMatch(t) {
  return String(t || "")
    .replace(/[\s、。，,.!?！？「」『』"']/g, "")
    .toLowerCase();
}

/**
 * 話者割当テキストに含まれる Whisper 行だけを抽出
 * @param {string} whisperTimeline
 * @param {{ id: number, lines: string[] }[]} speakers
 */
export function buildScriptsBySpeakerFromWhisperTimeline(
  whisperTimeline,
  speakers,
  translatedLines
) {
  const canon = parseBracketTimelineText(whisperTimeline);
  const out = {};
  if (!canon.length) return out;

  const translations =
    Array.isArray(translatedLines) && translatedLines.length === canon.length
      ? translatedLines.map((l) => String(l ?? "").trim())
      : canon.map((row) => row.text);

  for (const s of speakers || []) {
    const key = String(s.id);
    const blob = normalizeForMatch((s.lines || []).join(""));
    const rows = [];
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
    out[key] = rows.length
      ? rows.map(formatBracketTimelineRow).join("\n")
      : "";
  }
  return out;
}
