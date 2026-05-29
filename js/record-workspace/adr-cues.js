/**
 * ADR 風キュー — プレロール再生・3-2-1 カウント・ピッ音（Pro Tools / Source-Connect 系）
 */

/** @type {AudioContext|null} */
let audioCtx = null;

function getAudioContext() {
  if (!audioCtx && typeof AudioContext !== "undefined") {
    audioCtx = new AudioContext();
  }
  return audioCtx;
}

/**
 * @param {number} freqHz
 * @param {number} durationSec
 * @param {number} [volume]
 */
export function playCueBeep(freqHz = 880, durationSec = 0.12, volume = 0.35) {
  const ctx = getAudioContext();
  if (!ctx) return;
  if (ctx.state === "suspended") void ctx.resume();

  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.value = freqHz;
  gain.gain.value = volume;
  osc.connect(gain);
  gain.connect(ctx.destination);
  const t0 = ctx.currentTime;
  gain.gain.setValueAtTime(volume, t0);
  gain.gain.exponentialRampToValueAtTime(0.001, t0 + durationSec);
  osc.start(t0);
  osc.stop(t0 + durationSec + 0.02);
}

/** 3 → 2 → 1 → GO（GO は高め） */
export async function playCountdownBeeps(countdownSec = 3) {
  const steps = Math.max(1, Math.min(5, Math.round(countdownSec)));
  for (let n = steps; n >= 1; n--) {
    playCueBeep(660 + (steps - n) * 80, 0.1, 0.32);
    await sleep(1000);
  }
  playCueBeep(1200, 0.18, 0.42);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {HTMLElement|null} overlay
 * @param {{ phase?: string, count?: number|string, sub?: string }} state
 */
export function updateAdrOverlay(overlay, state) {
  if (!overlay) return;
  const { phase = "", count = "", sub = "" } = state;
  overlay.dataset.phase = phase;
  const countEl = overlay.querySelector(".rw-adr-count");
  const subEl = overlay.querySelector(".rw-adr-sub");
  const phaseEl = overlay.querySelector(".rw-adr-phase");
  if (countEl) countEl.textContent = count !== "" ? String(count) : "";
  if (subEl) subEl.textContent = sub;
  if (phaseEl) phaseEl.textContent = phase;
  overlay.hidden = !phase && count === "" && !sub;
}

export function hideAdrOverlay(overlay) {
  if (!overlay) return;
  overlay.hidden = true;
  overlay.dataset.phase = "";
  updateAdrOverlay(overlay, { phase: "", count: "", sub: "" });
}
