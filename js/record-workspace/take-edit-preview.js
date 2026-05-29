/**
 * Take 編集用の大きい波形プレビュー（ドラフトのトリム・音量を反映）
 */

import WaveSurfer from "https://esm.sh/wavesurfer.js@7.9.4";
import {
  DEFAULT_TAKE_EDIT,
  MIN_TAKE_CLIP_SEC,
  normalizeTakeEdit
} from "./take-audio-edit.js?v=rw-take-edit-2026-05-22";

const PREVIEW_PX_PER_SEC = 140;
const PREVIEW_WAVE_COLOR = "rgba(160, 255, 220, 0.88)";
const PREVIEW_PROGRESS = "rgba(220, 255, 240, 0.98)";

function blobToObjectUrl(blob) {
  const mime =
    blob.type && blob.type !== "application/octet-stream"
      ? blob.type
      : "audio/webm";
  return URL.createObjectURL(new Blob([blob], { type: mime }));
}

export class TakeEditPreview {
  /**
   * @param {HTMLElement} container
   */
  constructor(container) {
    this.container = container;
    /** @type {import('wavesurfer.js').default|null} */
    this.ws = null;
    /** @type {HTMLAudioElement|null} */
    this.mediaEl = null;
    /** @type {string|null} */
    this.url = null;
    this.sourceDurationSec = 0;
    this.edit = { ...DEFAULT_TAKE_EDIT };
  }

  /**
   * @param {Blob} blob
   */
  async load(blob) {
    this.destroy();
    if (!this.container) return;

    this.url = blobToObjectUrl(blob);
    this.mediaEl = document.createElement("audio");
    this.mediaEl.src = this.url;
    this.mediaEl.preload = "auto";

    this.ws = WaveSurfer.create({
      container: this.container,
      media: this.mediaEl,
      height: 128,
      waveColor: PREVIEW_WAVE_COLOR,
      progressColor: PREVIEW_PROGRESS,
      cursorColor: "rgba(251, 191, 36, 0.9)",
      cursorWidth: 2,
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
      normalize: true,
      interact: true,
      dragToSeek: true,
      minPxPerSec: PREVIEW_PX_PER_SEC,
      fillParent: true
    });

    await new Promise((resolve, reject) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve(undefined);
      };
      this.ws.on("ready", () => {
        try {
          this.sourceDurationSec = this.ws.getDuration() || 0;
          this.ws.zoom(PREVIEW_PX_PER_SEC);
          this._applyTrimVisual();
        } catch {
          /* ignore */
        }
        finish();
      });
      this.ws.on("error", (e) => {
        if (!done) reject(e instanceof Error ? e : new Error(String(e)));
      });
      this.mediaEl.addEventListener("canplay", finish, { once: true });
      this.mediaEl.addEventListener(
        "error",
        () => {
          if (!done) reject(new Error("編集プレビュー音声の読み込みに失敗しました"));
        },
        { once: true }
      );
      if (this.mediaEl.readyState >= 2) finish();
      setTimeout(finish, 8000);
    });
  }

  /**
   * @param {Partial<typeof DEFAULT_TAKE_EDIT>} edit
   */
  setEdit(edit) {
    this.edit = normalizeTakeEdit(
      { ...this.edit, ...edit },
      this.sourceDurationSec
    );
    this._applyTrimVisual();
  }

  _applyTrimVisual() {
    if (!this.container || !this.sourceDurationSec) return;
    const edit = normalizeTakeEdit(this.edit, this.sourceDurationSec);
    const src = this.sourceDurationSec;
    const leftPct = (edit.trimStartSec / src) * 100;
    const rightPct = (edit.trimEndSec / src) * 100;
    this.container.style.setProperty("--trim-left", `${leftPct}%`);
    this.container.style.setProperty("--trim-right", `${rightPct}%`);
    this.container.style.setProperty(
      "--preview-gain",
      String(Math.min(1.6, 0.55 + edit.gain * 0.45))
    );
    this.container.style.background = `linear-gradient(
      90deg,
      rgba(0, 0, 0, 0.62) 0%,
      rgba(0, 0, 0, 0.62) ${leftPct}%,
      transparent ${leftPct}%,
      transparent calc(100% - ${rightPct}%),
      rgba(0, 0, 0, 0.62) calc(100% - ${rightPct}%),
      rgba(0, 0, 0, 0.62) 100%
    )`;
  }

  destroy() {
    if (this.ws) {
      try {
        this.ws.destroy();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    if (this.url) {
      URL.revokeObjectURL(this.url);
      this.url = null;
    }
    this.mediaEl = null;
    if (this.container) {
      this.container.innerHTML = "";
      this.container.style.background = "";
    }
    this.sourceDurationSec = 0;
    this.edit = { ...DEFAULT_TAKE_EDIT };
  }

  getSourceDurationSec() {
    return this.sourceDurationSec;
  }
}
