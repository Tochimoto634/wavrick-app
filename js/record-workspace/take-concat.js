/**
 * Take の結合 — 通し再生（旧）とタイムライン配置ミックス（②声優トラックと同じ並び）
 * 重なり区間は加算ミックス（両方聞こえる）
 */

import { encodeWavBlob, mergeFloat32 } from "./wav-encode.js?v=rw-booth-2026-06-24";
import {
  getProcessedTakeSamples,
  limitMixPeak,
  mixAddInto
} from "./take-audio-edit.js?v=rw-take-edit-2026-05-22";

/**
 * 台本順に Take をつなげるだけ（ダウンロード用など）
 */
export async function buildConcatenatedTakes(lineRecorder, scriptLines, opts = {}) {
  const gapSec = opts.gapSec ?? 0.35;
  const targetRate = opts.sampleRate ?? 48000;
  const segments = [];

  for (let i = 0; i < scriptLines.length; i++) {
    const line = scriptLines[i];
    const take = lineRecorder.getActiveTake(line.id);
    if (!take?.blob) continue;
    const edit = lineRecorder.getTakeEdit(line.id, lineRecorder.getActiveTakeIndex(line.id));
    const { samples } = await getProcessedTakeSamples(take.blob, edit, targetRate);
    segments.push({ lineIndex: i, text: line.text, samples });
  }

  if (!segments.length) {
    throw new Error("繋げる収録がありません。各セリフを録音してから試してください。");
  }

  const gapSamples = Math.floor(gapSec * targetRate);
  const silence = new Float32Array(gapSamples);
  const parts = [];
  for (let s = 0; s < segments.length; s++) {
    parts.push(segments[s].samples);
    if (s < segments.length - 1 && gapSamples > 0) parts.push(silence);
  }

  const merged = mergeFloat32(parts);
  const blob = encodeWavBlob(merged, targetRate);

  return {
    blob,
    durationSec: merged.length / targetRate,
    segmentCount: segments.length,
    totalLines: scriptLines.length
  };
}

/**
 * ②声優トラックと同じ — 全編タイムラインに配置。重なりは加算してからピーク調整。
 * @param {import('./line-recorder.js').LineRecorder} lineRecorder
 * @param {{ id: string, text: string }[]} scriptLines
 * @param {{
 *   totalDurationSec: number,
 *   getClipPositionSec: (line: { id: string }) => number,
 *   audioOffsetSec?: number,
 *   sampleRate?: number
 * }} opts
 */
export async function buildTimelineMix(lineRecorder, scriptLines, opts) {
  const totalDurationSec = Math.max(opts.totalDurationSec || 0, 1);
  const audioOffsetSec = opts.audioOffsetSec ?? 0;
  const getClipPositionSec = opts.getClipPositionSec;
  const targetRate = opts.sampleRate ?? 48000;

  const totalSamples = Math.ceil(totalDurationSec * targetRate);
  const mix = new Float32Array(totalSamples);

  let placed = 0;

  for (let i = 0; i < scriptLines.length; i++) {
    const line = scriptLines[i];
    const take = lineRecorder.getActiveTake(line.id);
    if (!take?.blob) continue;

    const idx = lineRecorder.getActiveTakeIndex(line.id);
    const edit = lineRecorder.getTakeEdit(line.id, idx);

    let processed;
    try {
      processed = await getProcessedTakeSamples(take.blob, edit, targetRate);
    } catch {
      throw new Error(
        `音声${i + 1}（${line.text.slice(0, 20)}…）のデコードに失敗しました。`
      );
    }

    const posSec = Math.max(0, getClipPositionSec(line) + audioOffsetSec);
    const start = Math.floor(posSec * targetRate);
    mixAddInto(mix, start, processed.samples, 1);
    placed++;
  }

  if (!placed) {
    throw new Error("配置する収録がありません。各セリフの Take を選んでから試してください。");
  }

  limitMixPeak(mix, 0.98);

  const blob = encodeWavBlob(mix, targetRate);

  return {
    blob,
    durationSec: totalDurationSec,
    segmentCount: placed,
    totalLines: scriptLines.length,
    mode: "timeline",
    mixMode: "additive"
  };
}
