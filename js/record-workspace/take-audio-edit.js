/**
 * Take のトリム・音量とタイムラインミックス用ユーティリティ
 */

import { encodeWavBlob } from "./wav-encode.js?v=rw-booth-2026-06-24";

export const DEFAULT_TAKE_EDIT = Object.freeze({
  trimStartSec: 0,
  trimEndSec: 0,
  gain: 1
});

export const MIN_TAKE_CLIP_SEC = 0.08;

/**
 * @param {Partial<typeof DEFAULT_TAKE_EDIT>|null|undefined} edit
 * @param {number} sourceDurationSec
 */
/**
 * トリム・音量がデフォルトか（試聴は生の録音 URL で十分）
 * @param {Partial<typeof DEFAULT_TAKE_EDIT>|null|undefined} edit
 * @param {number} sourceDurationSec
 */
export function isTakeEditAtDefault(edit, sourceDurationSec) {
  const n = normalizeTakeEdit(edit, sourceDurationSec);
  return (
    n.trimStartSec <= 0 &&
    n.trimEndSec <= 0 &&
    Math.abs(n.gain - 1) < 0.001
  );
}

export function normalizeTakeEdit(edit, sourceDurationSec) {
  const src = Math.max(0, sourceDurationSec || 0);
  const trimStartSec = Math.max(0, Number(edit?.trimStartSec) || 0);
  const trimEndSec = Math.max(0, Number(edit?.trimEndSec) || 0);
  const maxTrim = Math.max(0, src - MIN_TAKE_CLIP_SEC);
  const tStart = Math.min(trimStartSec, maxTrim);
  const tEnd = Math.min(trimEndSec, Math.max(0, src - tStart - MIN_TAKE_CLIP_SEC));
  const gainRaw = Number(edit?.gain);
  const gain = Number.isFinite(gainRaw)
    ? Math.min(2, Math.max(0, gainRaw))
    : DEFAULT_TAKE_EDIT.gain;
  return { trimStartSec: tStart, trimEndSec: tEnd, gain };
}

/**
 * @param {number} sourceDurationSec
 * @param {typeof DEFAULT_TAKE_EDIT} edit
 */
export function getEffectiveTakeDurationSec(sourceDurationSec, edit) {
  const n = normalizeTakeEdit(edit, sourceDurationSec);
  return Math.max(
    MIN_TAKE_CLIP_SEC,
    Math.max(0, sourceDurationSec) - n.trimStartSec - n.trimEndSec
  );
}

/**
 * 重なり時は加算（のちピーク正規化）
 * @param {Float32Array} mix
 * @param {number} start
 * @param {Float32Array} samples
 * @param {number} [gain]
 */
export function mixAddInto(mix, start, samples, gain = 1) {
  const g = Number.isFinite(gain) ? gain : 1;
  for (let i = 0; i < samples.length; i++) {
    const idx = start + i;
    if (idx >= mix.length) break;
    mix[idx] += samples[i] * g;
  }
}

/**
 * @param {Float32Array} mix
 * @param {number} [peak]
 */
export function limitMixPeak(mix, peak = 0.98) {
  let max = 0;
  for (let i = 0; i < mix.length; i++) {
    const a = Math.abs(mix[i]);
    if (a > max) max = a;
  }
  if (max <= peak || max < 1e-8) return;
  const scale = peak / max;
  for (let i = 0; i < mix.length; i++) mix[i] *= scale;
}

async function decodeBlob(ctx, blob) {
  const ab = await blob.arrayBuffer();
  return ctx.decodeAudioData(ab.slice(0));
}

export function audioBufferToMono(buffer) {
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0).slice();
  const l = buffer.getChannelData(0);
  const r =
    buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : buffer.getChannelData(0);
  const out = new Float32Array(buffer.length);
  for (let i = 0; i < buffer.length; i++) out[i] = (l[i] + r[i]) * 0.5;
  return out;
}

export function resampleMono(mono, fromRate, toRate) {
  if (fromRate === toRate) return mono;
  const newLen = Math.max(1, Math.round(mono.length * (toRate / fromRate)));
  const out = new Float32Array(newLen);
  for (let i = 0; i < newLen; i++) {
    const src = (i * fromRate) / toRate;
    const i0 = Math.floor(src);
    const i1 = Math.min(i0 + 1, mono.length - 1);
    const f = src - i0;
    out[i] = mono[i0] * (1 - f) + mono[i1] * f;
  }
  return out;
}

/**
 * @param {Blob} blob
 * @param {typeof DEFAULT_TAKE_EDIT} edit
 * @param {number} targetRate
 */
export async function getProcessedTakeSamples(blob, edit, targetRate) {
  const ctx = new AudioContext();
  try {
    const buffer = await decodeBlob(ctx, blob);
    const mono = audioBufferToMono(buffer);
    const resampled = resampleMono(mono, buffer.sampleRate, targetRate);
    const editNorm = normalizeTakeEdit(edit, resampled.length / targetRate);
    const start = Math.floor(editNorm.trimStartSec * targetRate);
    const end = Math.max(
      start,
      resampled.length - Math.floor(editNorm.trimEndSec * targetRate)
    );
    const slice = resampled.subarray(start, end);
    const out =
      editNorm.gain === 1
        ? slice.slice()
        : (() => {
            const g = new Float32Array(slice.length);
            for (let i = 0; i < slice.length; i++) g[i] = slice[i] * editNorm.gain;
            return g;
          })();
    return {
      samples: out,
      sourceDurationSec: buffer.duration,
      effectiveDurationSec: out.length / targetRate,
      edit: editNorm
    };
  } finally {
    await ctx.close().catch(() => {});
  }
}

/**
 * @param {Blob} blob
 * @returns {Promise<number>}
 */
/** @type {WeakMap<HTMLAudioElement, { ctx: AudioContext, gain: GainNode }>} */
const previewAudioChains = new WeakMap();

export function detachEditedAudioPreview(audio) {
  const chain = previewAudioChains.get(audio);
  if (chain) {
    chain.ctx.close().catch(() => {});
    previewAudioChains.delete(audio);
  }
}

/**
 * トリム・ゲイン付き試聴（HTMLAudioElement.volume は 1 上限のため Web Audio を使用）
 * @param {HTMLAudioElement} audio
 * @param {{ trimStartSec: number, trimEndSec: number, gain: number, srcDurationSec: number }} opts
 */
/** @type {Map<string, string>} */
const previewUrlByKey = new Map();

/**
 * 編集済み WAV の object URL（試聴用・MediaElementSource 問題を回避）
 * @param {Blob} blob
 * @param {typeof DEFAULT_TAKE_EDIT} edit
 * @param {number} [targetRate]
 */
export async function createEditedPreviewUrl(blob, edit, targetRate = 48000) {
  const { samples } = await getProcessedTakeSamples(blob, edit, targetRate);
  const out = encodeWavBlob(samples, targetRate);
  return URL.createObjectURL(out);
}

/**
 * @param {string} key
 * @param {string|null} url
 */
export function storePreviewUrl(key, url) {
  const prev = previewUrlByKey.get(key);
  if (prev) URL.revokeObjectURL(prev);
  if (url) previewUrlByKey.set(key, url);
  else previewUrlByKey.delete(key);
}

export async function playEditedAudioPreview(audio, opts) {
  const trimStart = Math.max(0, opts.trimStartSec || 0);
  const srcDur = Math.max(0, opts.srcDurationSec || 0);
  const trimEnd = Math.max(0, opts.trimEndSec || 0);
  const stopAt = Math.max(trimStart + MIN_TAKE_CLIP_SEC, srcDur - trimEnd);
  const gain = Math.max(0, Number(opts.gain) || 1);

  let chain = previewAudioChains.get(audio);
  if (!chain) {
    const ctx = new AudioContext();
    const source = ctx.createMediaElementSource(audio);
    const gainNode = ctx.createGain();
    source.connect(gainNode).connect(ctx.destination);
    chain = { ctx, gain: gainNode };
    previewAudioChains.set(audio, chain);
  }
  chain.gain.gain.value = gain;

  audio.currentTime = trimStart;

  const stopAtTrim = () => {
    if (audio.currentTime >= stopAt - 0.02) {
      audio.pause();
      audio.removeEventListener("timeupdate", stopAtTrim);
    }
  };
  audio.removeEventListener("timeupdate", stopAtTrim);
  audio.addEventListener("timeupdate", stopAtTrim);
  const prevOnEnded = audio.onended;
  audio.onended = () => {
    audio.removeEventListener("timeupdate", stopAtTrim);
    if (typeof prevOnEnded === "function") prevOnEnded.call(audio);
  };

  await audio.play();
}

export async function probeBlobDurationSec(blob) {
  const ctx = new AudioContext();
  try {
    const buffer = await decodeBlob(ctx, blob);
    return buffer.duration;
  } finally {
    await ctx.close().catch(() => {});
  }
}
