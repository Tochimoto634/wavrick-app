/**
 * 詳細設定でオンにした収録アシスト機能の実装
 */

import { getProcessedTakeSamples } from "./take-audio-edit.js?v=rw-features-2026-05-22";

/** @type {HTMLAudioElement|null} */
let overdubAudio = null;
/** @type {number} */
let pingPongGen = 0;
/** @type {number|null} */
let levelMeterRaf = null;

/**
 * @param {Float32Array} mono
 * @param {number} rate
 * @param {{ threshold?: number, minSilenceSec?: number }} [opts]
 */
export function detectSilenceTrim(mono, rate, opts = {}) {
  const threshold = opts.threshold ?? 0.012;
  const minRun = Math.floor((opts.minSilenceSec ?? 0.08) * rate);
  let start = 0;
  for (let i = 0; i < mono.length; i++) {
    if (Math.abs(mono[i]) > threshold) {
      start = Math.max(0, i - Math.floor(rate * 0.02));
      break;
    }
  }
  let end = mono.length;
  for (let i = mono.length - 1; i >= 0; i--) {
    if (Math.abs(mono[i]) > threshold) {
      end = Math.min(mono.length, i + Math.floor(rate * 0.05));
      break;
    }
  }
  const trimStartSec = start / rate;
  const trimEndSec = Math.max(0, (mono.length - end) / rate);
  if (end - start < minRun) {
    return { trimStartSec: 0, trimEndSec: 0 };
  }
  return { trimStartSec, trimEndSec };
}

/**
 * @param {Blob} blob
 */
export async function suggestNoiseGateTrim(blob) {
  const { samples, sourceDurationSec } = await getProcessedTakeSamples(
    blob,
    { trimStartSec: 0, trimEndSec: 0, gain: 1 },
    48000
  );
  return {
    ...detectSilenceTrim(samples, 48000),
    sourceDurationSec
  };
}

/**
 * @param {number} bpm
 */
export function playBpmClick(bpm = 120) {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  const ctx = new AC();
  const interval = 60 / bpm;
  const playClick = (t) => {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.frequency.value = 1000;
    g.gain.value = 0.12;
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.04);
  };
  const t0 = ctx.currentTime;
  playClick(t0);
  playClick(t0 + interval);
  playClick(t0 + interval * 2);
  setTimeout(() => ctx.close().catch(() => {}), 800);
}

export function stopOverdubMonitor() {
  if (overdubAudio) {
    overdubAudio.pause();
    overdubAudio.removeAttribute("src");
    overdubAudio = null;
  }
}

/**
 * @param {Blob|null} blob
 * @param {number} [gain]
 */
export function startOverdubMonitor(blob, gain = 0.22) {
  stopOverdubMonitor();
  if (!blob || blob.size < 44) return;
  overdubAudio = new Audio(URL.createObjectURL(blob));
  overdubAudio.loop = true;
  overdubAudio.volume = Math.min(1, Math.max(0, gain));
  void overdubAudio.play().catch(() => {});
}

/**
 * @param {object} ctx
 * @param {() => void} ctx.stopRef
 * @param {(lineId: string) => Promise<void>} ctx.playTake
 * @param {() => { id: string }|null} ctx.getFocusedLine
 * @param {() => boolean} ctx.playRefFromLine
 */
export async function runPingPongPreview(ctx) {
  const line = ctx.getFocusedLine();
  if (!line) return;
  const gen = ++pingPongGen;
  ctx.stopRef();
  const ok = ctx.playRefFromLine(line);
  if (!ok) return;
  await sleepMs(2200);
  if (gen !== pingPongGen) return;
  ctx.stopRef();
  await ctx.playTake(line.id);
}

function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * @param {AnalyserNode} analyser
 * @param {HTMLElement} labelEl
 */
export function startInputLevelMeter(analyser, labelEl) {
  stopInputLevelMeter();
  const buf = new Uint8Array(analyser.fftSize);
  const tick = () => {
    analyser.getByteTimeDomainData(buf);
    let peak = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = Math.abs(buf[i] - 128) / 128;
      if (v > peak) peak = v;
    }
    const db = peak > 1e-6 ? 20 * Math.log10(peak) : -60;
    if (labelEl) {
      labelEl.textContent = `${db.toFixed(1)} dBFS`;
      labelEl.dataset.level =
        peak > 0.85 ? "hot" : peak > 0.5 ? "warn" : "ok";
    }
    levelMeterRaf = requestAnimationFrame(tick);
  };
  levelMeterRaf = requestAnimationFrame(tick);
}

export function stopInputLevelMeter() {
  if (levelMeterRaf) {
    cancelAnimationFrame(levelMeterRaf);
    levelMeterRaf = null;
  }
}

/**
 * @param {object} opts
 */
export function buildSessionExportJson(opts) {
  const {
    scriptLines,
    lineRecorder,
    features,
    preRollSec,
    audioOffsetSec,
    recordStartByLineId,
    takeClipPositionByLineId
  } = opts;
  const lines = scriptLines.map((line, i) => {
    const takes = lineRecorder.getTakes(line.id).map((t, ti) => ({
      index: ti,
      label: lineRecorder.getTakeLabel(line.id, ti),
      size: t.size,
      durationSec: t.durationSec,
      status: t.status ?? null,
      edit: t.edit
    }));
    return {
      index: i + 1,
      id: line.id,
      startSec: line.startSec,
      endSec: line.endSec,
      text: line.text,
      recordStartSec: recordStartByLineId.get(line.id) ?? line.startSec,
      clipPositionSec: takeClipPositionByLineId.get(line.id) ?? line.startSec,
      takeCount: takes.length,
      activeTakeIndex: lineRecorder.getActiveTakeIndex(line.id),
      takes
    };
  });
  return {
    exportedAt: new Date().toISOString(),
    app: "wavrick-record-workspace",
    settings: { preRollSec, audioOffsetSec, features },
    scriptLineCount: lines.length,
    lines
  };
}

export function downloadSessionJson(data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json"
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `wavrick-session-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}
