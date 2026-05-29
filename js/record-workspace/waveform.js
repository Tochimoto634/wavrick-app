/**
 * WaveSurfer.js — 2行マルチトラック（お手本 + 声優収録）
 * 上段: リファレンス全編波形 / 下段: 台本目安枠 + 収録波形
 */

import WaveSurfer from "https://esm.sh/wavesurfer.js@7.9.4";
import TimelinePlugin from "https://esm.sh/wavesurfer.js@7.9.4/plugins/timeline";
import RegionsPlugin from "https://esm.sh/wavesurfer.js@7.9.4/plugins/regions";
import {
  DEFAULT_TAKE_EDIT,
  MIN_TAKE_CLIP_SEC,
  normalizeTakeEdit
} from "./take-audio-edit.js?v=rw-take-edit-2026-05-22";

export const WAVEFORM_MIN_PX_PER_SEC = 80;

const REGION_COLOR = "rgba(255, 99, 132, 0.3)";
const REGION_COLOR_FOCUSED = "rgba(255, 99, 132, 0.52)";
const REGION_COLOR_RETAKE = "rgba(255, 48, 48, 0.42)";
const REGION_COLOR_RETAKE_FOCUSED = "rgba(255, 48, 48, 0.62)";

const TAKE_WAVE_COLOR = "rgba(120, 255, 200, 0.82)";
const TAKE_WAVE_PROGRESS = "rgba(200, 255, 230, 0.98)";

function formatTimelineLabel(seconds) {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function isSafariBrowser() {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return /Safari/i.test(ua) && !/Chrome|Chromium|CriOS|Edg|OPR|Firefox/i.test(ua);
}

function prepareSafariMedia(media) {
  if (!media) return;
  media.muted = false;
  media.volume = 1;
  media.playsInline = true;
  media.setAttribute("playsinline", "true");
  media.setAttribute("webkit-playsinline", "true");
  media.preload = "auto";
}

function blobToObjectUrl(blob) {
  const mime =
    blob.type && blob.type !== "application/octet-stream"
      ? blob.type
      : "audio/webm";
  return URL.createObjectURL(new Blob([blob], { type: mime }));
}

/** 上段: お手本（全編）波形 */
export class SyncedWaveform {
  /**
   * @param {HTMLElement} container
   * @param {HTMLElement|null} regionOverlay
   * @param {{ enableRegions?: boolean, onTimeUpdate?: (t:number)=>void, onSeek?: (t:number)=>void, onRegionClick?: (lineId:string, startSec:number)=>void }} hooks
   */
  constructor(container, regionOverlay = null, hooks = {}) {
    this.container = container;
    this.regionOverlay = regionOverlay;
    this.hooks = hooks;
    this.enableRegions = hooks.enableRegions !== false;
    /** @type {import('wavesurfer.js').default|null} */
    this.ws = null;
    /** @type {HTMLAudioElement|null} */
    this.mediaEl = null;
    /** @type {ReturnType<typeof RegionsPlugin.create>|null} */
    this.regionsPlugin = null;
    this.ready = false;
    this.isScrubbing = false;
    this.isPlaying = false;
    /** @type {HTMLElement|null} */
    this.scrollEl = null;
    /** @type {string|null} */
    this.focusedLineId = null;
    /** @type {{ id: string, startSec: number, endSec: number|null, text?: string }[]} */
    this.pendingScriptLines = [];
    /** @type {Map<string, HTMLElement>} */
    this.regionChipByLineId = new Map();
    /** @type {Set<string>} */
    this.retakeCueIds = new Set();
    /** @type {((el: HTMLElement|null) => void)|null} */
    this.onScrollElReady = null;
  }

  /** @param {Iterable<string>|Set<string>} cueIds */
  setRetakeCueIds(cueIds) {
    this.retakeCueIds = cueIds instanceof Set ? cueIds : new Set(cueIds || []);
    this._applyRetakeRegionStyles();
    if (this.pendingScriptLines.length) this._renderRegionOverlay(this.pendingScriptLines);
  }

  _applyRetakeRegionStyles() {
    for (const [id, chip] of this.regionChipByLineId) {
      chip.classList.toggle("rw-region-chip--retake", this.retakeCueIds.has(id));
    }
    if (this.regionsPlugin) {
      for (const region of this.regionsPlugin.getRegions?.() || []) {
        const isRetake = this.retakeCueIds.has(region.id);
        const focused = region.id === this.focusedLineId;
        try {
          region.setOptions?.({
            color: focused
              ? isRetake
                ? REGION_COLOR_RETAKE_FOCUSED
                : REGION_COLOR_FOCUSED
              : isRetake
                ? REGION_COLOR_RETAKE
                : REGION_COLOR
          });
        } catch {
          /* ignore */
        }
      }
    }
  }

  _getWaveScrollEl() {
    if (this.scrollEl) return this.scrollEl;
    const wrapper = this.ws?.getWrapper?.();
    const parent = wrapper?.parentElement;
    if (parent && parent.scrollWidth > parent.clientWidth + 2) {
      this.scrollEl = parent;
      this.onScrollElReady?.(parent);
      return parent;
    }
    return null;
  }

  _mountRegionOverlay() {
    if (!this.enableRegions) return;
    const overlay = this.regionOverlay;
    const scroll = this._getWaveScrollEl();
    if (!overlay || !scroll) return;
    scroll.style.position = "relative";
    if (overlay.parentElement !== scroll) {
      scroll.appendChild(overlay);
    }
    overlay.style.position = "absolute";
    overlay.style.top = "22px";
    overlay.style.left = "0";
    overlay.style.height = "98px";
    overlay.style.zIndex = "5";
    const w =
      scroll.scrollWidth ||
      Math.ceil(this.ws.getDuration() * WAVEFORM_MIN_PX_PER_SEC);
    overlay.style.width = `${w}px`;
  }

  scrollToTime(seconds, opts = {}) {
    if (!this.ready || !this.ws) return;
    if (this.isPlaying && !opts.force) return;

    const dur = this.ws.getDuration();
    if (dur <= 0) return;
    const t = Math.max(0, Math.min(seconds, dur));

    if (typeof this.ws.setScrollTime === "function") {
      try {
        this.ws.setScrollTime(t);
        return;
      } catch {
        /* fall through */
      }
    }

    const scroll = this._getWaveScrollEl();
    if (!scroll) return;
    const px = t * WAVEFORM_MIN_PX_PER_SEC;
    const target = px - scroll.clientWidth * 0.5;
    const maxLeft = Math.max(0, scroll.scrollWidth - scroll.clientWidth);
    scroll.scrollLeft = Math.max(0, Math.min(target, maxLeft));
  }

  _renderRegionOverlay(lines) {
    if (!this.enableRegions) return;
    const overlay = this.regionOverlay;
    if (!overlay || !this.ws) return;
    this._mountRegionOverlay();
    overlay.innerHTML = "";
    this.regionChipByLineId.clear();

    const dur = this.ws.getDuration();
    if (dur <= 0 || !lines.length) {
      overlay.classList.remove("rw-region-overlay--active");
      return;
    }

    overlay.classList.add("rw-region-overlay--active");
    const scroll = this._getWaveScrollEl();
    const totalW =
      scroll?.scrollWidth || Math.ceil(dur * WAVEFORM_MIN_PX_PER_SEC);
    overlay.style.width = `${totalW}px`;

    for (const line of lines) {
      const start = Math.max(0, line.startSec);
      const end =
        line.endSec != null && line.endSec > start ? line.endSec : start + 2;
      const leftPx = start * WAVEFORM_MIN_PX_PER_SEC;
      const widthPx = Math.max(4, (end - start) * WAVEFORM_MIN_PX_PER_SEC);

      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "rw-region-chip";
      chip.dataset.lineId = line.id;
      chip.style.left = `${leftPx}px`;
      chip.style.width = `${widthPx}px`;
      chip.title = line.text || line.rawTc || "";
      chip.setAttribute("aria-label", line.text || "担当セリフ");
      if (this.retakeCueIds.has(line.id)) {
        chip.classList.add("rw-region-chip--retake");
      }
      chip.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this.focusScriptLine(line.id, start, { seek: true, scroll: true });
        this.hooks.onRegionClick?.(line.id, start);
      });
      overlay.appendChild(chip);
      this.regionChipByLineId.set(line.id, chip);
    }

    if (this.focusedLineId) {
      this._applyFocusedRegionStyle(this.focusedLineId);
    }
  }

  _applyFocusedRegionStyle(lineId) {
    if (!this.enableRegions) return;
    for (const [id, chip] of this.regionChipByLineId) {
      chip.classList.toggle("rw-region-chip--focused", id === lineId);
    }
    this._applyRetakeRegionStyles();
  }

  _bindRegionEvents() {
    if (!this.regionsPlugin) return;
    this.regionsPlugin.on("region-clicked", (region, ev) => {
      ev?.stopPropagation?.();
      const lineId = region.id;
      if (!lineId) return;
      this.focusScriptLine(lineId, region.start, { seek: true, scroll: true });
      this.hooks.onRegionClick?.(lineId, region.start);
    });
  }

  _applyScriptLines() {
    const lines = this.pendingScriptLines;
    if (!this.ready || !lines.length) return;
    this._renderRegionOverlay(lines);

    if (this.regionsPlugin && this.enableRegions) {
      try {
        this.regionsPlugin.clearRegions?.();
      } catch {
        /* ignore */
      }
      for (const line of lines) {
        const start = Math.max(0, line.startSec);
        const end =
          line.endSec != null && line.endSec > start
            ? line.endSec
            : start + 2;
        const isRetake = this.retakeCueIds.has(line.id);
        try {
          this.regionsPlugin.addRegion({
            id: line.id,
            start,
            end,
            color: isRetake ? REGION_COLOR_RETAKE : REGION_COLOR,
            drag: false,
            resize: false
          });
        } catch {
          /* overlay is primary */
        }
      }
    }
    if (this.focusedLineId) {
      this._applyFocusedRegionStyle(this.focusedLineId);
    }
  }

  async loadUrl(audioUrl) {
    this.destroy();

    this.regionsPlugin = this.enableRegions ? RegionsPlugin.create() : null;
    this.mediaEl = document.createElement("audio");
    prepareSafariMedia(this.mediaEl);
    this.mediaEl.src = audioUrl;

    const plugins = [
      TimelinePlugin.create({
        height: 22,
        timeInterval: 1,
        primaryLabelInterval: 5,
        secondaryLabelOpacity: 0.35,
        formatTimeCallback: formatTimelineLabel,
        style: {
          fontSize: "11px",
          color: "rgba(255, 255, 255, 0.55)"
        }
      })
    ];
    if (this.regionsPlugin) plugins.push(this.regionsPlugin);

    this.ws = WaveSurfer.create({
      container: this.container,
      media: this.mediaEl,
      height: 88,
      waveColor: "rgba(77, 159, 255, 0.42)",
      progressColor: "rgba(224, 62, 48, 0.9)",
      cursorColor: "#e03e30",
      cursorWidth: 2,
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
      normalize: false,
      interact: true,
      dragToSeek: false,
      mediaControls: false,
      volume: 1,
      fillParent: false,
      minPxPerSec: WAVEFORM_MIN_PX_PER_SEC,
      autoScroll: true,
      autoCenter: true,
      hideScrollbar: true,
      plugins
    });

    this._bindRegionEvents();

    this.ws.on("ready", () => {
      this.ready = true;
      prepareSafariMedia(this.mediaEl || this.ws.getMediaElement?.());
      if (this.container) {
        this.container.style.height = "88px";
        this.container.style.maxHeight = "88px";
      }
      try {
        this.ws.zoom(WAVEFORM_MIN_PX_PER_SEC);
      } catch {
        /* ignore */
      }
      requestAnimationFrame(() => {
        this._mountRegionOverlay();
        this._applyScriptLines();
        this._getWaveScrollEl();
      });
    });

    this.ws.on("play", () => {
      this.isPlaying = true;
    });

    this.ws.on("pause", () => {
      this.isPlaying = false;
    });

    this.ws.on("finish", () => {
      this.isPlaying = false;
    });

    this.ws.on("timeupdate", (time) => {
      if (this.isScrubbing) return;
      this.hooks.onTimeUpdate?.(time);
    });

    this.ws.on("interaction", () => {
      if (!this.ready || !this.ws) return;
      this.isScrubbing = true;
      const t = this.ws.getCurrentTime();
      this.hooks.onSeek?.(t);
      requestAnimationFrame(() => {
        this.isScrubbing = false;
      });
    });

    await new Promise((resolve, reject) => {
      const ws = this.ws;
      const media = this.mediaEl;
      if (!ws || !media) return reject(new Error("WaveSurfer init failed"));

      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        media.removeEventListener("canplay", finish);
        media.removeEventListener("error", onErr);
        resolve(undefined);
      };
      const onErr = () => {
        if (settled) return;
        settled = true;
        media.removeEventListener("canplay", finish);
        media.removeEventListener("error", onErr);
        reject(new Error("音声の読み込みに失敗しました"));
      };

      ws.on("ready", finish);
      ws.on("error", (err) => {
        if (settled) return;
        settled = true;
        reject(err instanceof Error ? err : new Error(String(err)));
      });
      media.addEventListener("canplay", finish);
      media.addEventListener("error", onErr);
      if (media.readyState >= 2) finish();
    });
  }

  setScriptLines(lines) {
    this.pendingScriptLines = Array.isArray(lines) ? lines : [];
    this._applyScriptLines();
  }

  clearScriptRegions() {
    this.pendingScriptLines = [];
    this.focusedLineId = null;
    if (this.regionOverlay) {
      this.regionOverlay.innerHTML = "";
      this.regionOverlay.classList.remove("rw-region-overlay--active");
    }
    this.regionChipByLineId.clear();
    try {
      this.regionsPlugin?.clearRegions?.();
    } catch {
      /* ignore */
    }
  }

  focusScriptLine(lineId, startSec, opts = {}) {
    const { seek = false, scroll = true } = opts;
    this.focusedLineId = lineId;
    this._applyFocusedRegionStyle(lineId);
    const t = Math.max(0, startSec);
    if (seek && this.ready && this.ws) {
      this.setTime(t, { scroll: false });
    }
    if (scroll) {
      this.scrollToTime(t, { force: true });
    }
  }

  setTime(seconds, opts = {}) {
    if (!this.ready || !this.ws || this.isScrubbing) return;
    const dur = this.ws.getDuration();
    const t = dur > 0 ? Math.max(0, Math.min(seconds, dur)) : Math.max(0, seconds);
    this.ws.setTime(t);
    if (opts.scroll) {
      this.scrollToTime(t, { force: true });
    }
  }

  async play() {
    if (!this.ready || !this.ws) return false;
    const media = this.mediaEl || this.ws.getMediaElement?.();
    prepareSafariMedia(media);
    try {
      await this.ws.play();
      this.isPlaying = true;
      return true;
    } catch {
      /* Safari fallback */
    }
    if (media) {
      try {
        prepareSafariMedia(media);
        await media.play();
        this.isPlaying = true;
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  pause() {
    if (!this.ready || !this.ws) return;
    this.ws.pause();
    this.mediaEl?.pause();
    this.isPlaying = false;
  }

  isPlayingNow() {
    if (!this.ready || !this.ws) return false;
    try {
      return this.ws.isPlaying();
    } catch {
      return Boolean(this.mediaEl && !this.mediaEl.paused);
    }
  }

  getCurrentTime() {
    return this.ready && this.ws ? this.ws.getCurrentTime() : 0;
  }

  getDuration() {
    return this.ready && this.ws ? this.ws.getDuration() : 0;
  }

  getScrollElement() {
    return this._getWaveScrollEl();
  }

  destroy() {
    this.clearScriptRegions();
    if (this.ws) {
      try {
        this.ws.destroy();
      } catch {
        /* ignore */
      }
    }
    this.ws = null;
    this.mediaEl = null;
    this.regionsPlugin = null;
    this.ready = false;
    this.isPlaying = false;
    this.scrollEl = null;
    if (this.container) {
      this.container.innerHTML = "";
    }
  }
}

/**
 * 下段: 台本目安枠 + セリフ単位の収録波形
 */
class TakeTrackLane {
  /**
   * @param {HTMLElement} laneEl
   * @param {HTMLElement} scrollEl
   * @param {{ onRegionClick?: (lineId:string, startSec:number)=>void, onTakeFile?: (lineId:string, file:File)=>void, onClipPositionChange?: (lineId:string, positionSec:number)=>void, onClipEditChange?: (lineId:string, edit: { trimStartSec: number, trimEndSec: number, gain: number })=>void, onTakeDuration?: (lineId:string, durationSec:number)=>void, onTakeClipActivate?: (lineId:string)=>void }} hooks
   */
  constructor(laneEl, scrollEl, hooks = {}) {
    this.laneEl = laneEl;
    this.scrollEl = scrollEl;
    this.hooks = hooks;
    this.duration = 0;
    this.pxPerSec = WAVEFORM_MIN_PX_PER_SEC;
    this.focusedLineId = null;
    /** @type {{ id: string, startSec: number, endSec: number|null, text?: string, rawTc?: string }[]} */
    this.lines = [];
    /** @type {Map<string, { guide: HTMLElement, clip: HTMLElement|null, waveHost: HTMLElement|null, ws: import('wavesurfer.js').default|null, url: string|null, clipPositionSec: number|null, sourceDurationSec: number, trimStartSec: number, trimEndSec: number, gain: number, lineNum: number, dragCleanup: (() => void)|null, trimStartCleanup: (() => void)|null, trimEndCleanup: (() => void)|null }>} */
    this.blocks = new Map();
    /** @type {HTMLElement|null} */
    this.punchLayer = null;
    /** @type {Map<string, number>} */
    this.punchInSecByLineId = new Map();
    /** @type {Set<string>} */
    this.retakeCueIds = new Set();
  }

  /** @param {Iterable<string>|Set<string>} cueIds */
  setRetakeCueIds(cueIds) {
    this.retakeCueIds = cueIds instanceof Set ? cueIds : new Set(cueIds || []);
    for (const [id, entry] of this.blocks) {
      const on = this.retakeCueIds.has(id);
      entry.guide.classList.toggle("rw-guide-marker--retake", on);
      const badge = entry.guide.querySelector(".rw-guide-marker-badge");
      if (badge) badge.textContent = on ? "要修正" : "目安";
    }
  }

  _lineTiming(line) {
    const start = Math.max(0, line.startSec);
    const end =
      line.endSec != null && line.endSec > start ? line.endSec : start + 2;
    return { start, end, span: end - start };
  }

  setDuration(sec) {
    this.duration = Math.max(0, sec);
    this._updateLaneWidth();
  }

  setPxPerSec(px) {
    this.pxPerSec = px;
    this._updateLaneWidth();
    this._layoutBlocks();
  }

  _updateLaneWidth() {
    if (!this.laneEl) return;
    const w = Math.max(
      100,
      Math.ceil(this.duration * this.pxPerSec) || 100
    );
    this.laneEl.style.width = `${w}px`;
    this.laneEl.style.minWidth = `${w}px`;
  }

  setScriptLines(lines) {
    this.lines = Array.isArray(lines) ? lines : [];
    this._renderBlocks();
  }

  focusLine(lineId) {
    this.focusedLineId = lineId;
    for (const [id, entry] of this.blocks) {
      entry.guide.classList.toggle("rw-guide-marker--focused", id === lineId);
      entry.clip?.classList.toggle("rw-take-clip--focused", id === lineId);
    }
  }

  /** @param {string|null} lineId 録音中のセリフ（目安枠を REC 表示） */
  setRecordingHighlight(lineId) {
    for (const [id, entry] of this.blocks) {
      entry.guide.classList.toggle("rw-guide-marker--recording", id === lineId);
    }
  }

  _ensurePunchLayer() {
    if (!this.laneEl) return null;
    if (!this.punchLayer) {
      this.punchLayer = document.createElement("div");
      this.punchLayer.className = "rw-punch-layer";
      this.punchLayer.setAttribute("aria-hidden", "true");
      this.laneEl.appendChild(this.punchLayer);
    }
    return this.punchLayer;
  }

  /**
   * 収録スタート位置（台本と別に指定した秒数）
   * @param {Map<string, number>|Record<string, number>} punchMap
   */
  setPunchInMarkers(punchMap) {
    this.punchInSecByLineId = new Map();
    if (punchMap instanceof Map) {
      for (const [id, sec] of punchMap) this.punchInSecByLineId.set(id, sec);
    } else if (punchMap && typeof punchMap === "object") {
      for (const [id, sec] of Object.entries(punchMap)) {
        if (typeof sec === "number") this.punchInSecByLineId.set(id, sec);
      }
    }
    this._renderPunchMarkers();
  }

  _renderPunchMarkers() {
    const layer = this._ensurePunchLayer();
    if (!layer) return;
    layer.innerHTML = "";

    for (const line of this.lines) {
      const sec = this.punchInSecByLineId.get(line.id);
      if (sec == null || !Number.isFinite(sec)) continue;
      const scriptStart = Math.max(0, line.startSec);
      const differs = Math.abs(sec - scriptStart) > 0.08;

      const pin = document.createElement("div");
      pin.className = "rw-punch-marker";
      pin.dataset.lineId = line.id;
      pin.style.left = `${sec * this.pxPerSec}px`;
      pin.title = differs
        ? `収録スタート ${formatTimelineLabel(sec)}（台本 ${formatTimelineLabel(scriptStart)} と異なる）`
        : `収録スタート ${formatTimelineLabel(sec)}`;

      const label = document.createElement("span");
      label.className = "rw-punch-marker-label";
      label.textContent = "REC";
      pin.appendChild(label);

      if (differs) {
        const sub = document.createElement("span");
        sub.className = "rw-punch-marker-sub";
        sub.textContent = formatTimelineLabel(sec);
        pin.appendChild(sub);
      }

      layer.appendChild(pin);
    }
  }

  _renderBlocks() {
    if (!this.laneEl) return;
    this._destroyAllBlockWaves();
    this.laneEl.innerHTML = "";
    this.blocks.clear();
    this.punchLayer = null;

    for (const line of this.lines) {
      const { start, span } = this._lineTiming(line);
      const leftPx = start * this.pxPerSec;
      const guideW = Math.max(40, span * this.pxPerSec);

      const guide = document.createElement("div");
      guide.className = "rw-guide-marker";
      guide.dataset.lineId = line.id;
      guide.style.left = `${leftPx}px`;
      guide.style.width = `${guideW}px`;
      guide.setAttribute("role", "listitem");
      guide.title = `${line.text || ""}（目安のタイミング）`;

      const badge = document.createElement("span");
      badge.className = "rw-guide-marker-badge";
      badge.textContent = this.retakeCueIds.has(line.id) ? "要修正" : "目安";
      if (this.retakeCueIds.has(line.id)) {
        guide.classList.add("rw-guide-marker--retake");
      }
      guide.appendChild(badge);

      const tc = document.createElement("span");
      tc.className = "rw-guide-marker-tc";
      tc.textContent = line.rawTc || "";
      guide.appendChild(tc);

      const actions = document.createElement("div");
      actions.className = "rw-guide-marker-actions";

      const fileInput = document.createElement("input");
      fileInput.type = "file";
      fileInput.accept = "audio/*,.wav,.mp3,.m4a,.ogg,.webm";
      fileInput.className = "rw-take-block-file";
      fileInput.setAttribute("aria-label", "音声ファイルを選択");
      fileInput.addEventListener("change", () => {
        const file = fileInput.files?.[0];
        if (file) this.hooks.onTakeFile?.(line.id, file);
        fileInput.value = "";
      });

      const fileBtn = document.createElement("label");
      fileBtn.className = "rw-take-block-btn";
      fileBtn.title = "WAV / MP3 を読み込む";
      fileBtn.appendChild(fileInput);
      const fileSpan = document.createElement("span");
      fileSpan.textContent = "📁";
      fileBtn.appendChild(fileSpan);
      actions.appendChild(fileBtn);
      guide.appendChild(actions);

      guide.addEventListener("click", (ev) => {
        if (ev.target.closest(".rw-take-block-btn, .rw-take-block-file")) return;
        this.hooks.onRegionClick?.(line.id, start);
      });

      guide.addEventListener("dragover", (ev) => {
        ev.preventDefault();
        guide.classList.add("rw-guide-marker--dragover");
      });
      guide.addEventListener("dragleave", () => {
        guide.classList.remove("rw-guide-marker--dragover");
      });
      guide.addEventListener("drop", (ev) => {
        ev.preventDefault();
        guide.classList.remove("rw-guide-marker--dragover");
        const file = ev.dataTransfer?.files?.[0];
        if (file && file.type.startsWith("audio/")) {
          this.hooks.onTakeFile?.(line.id, file);
        }
      });

      this.laneEl.appendChild(guide);
      this.blocks.set(line.id, {
        guide,
        clip: null,
        waveHost: null,
        ws: null,
        url: null,
        clipPositionSec: null,
        sourceDurationSec: 0,
        trimStartSec: 0,
        trimEndSec: 0,
        gain: 1,
        lineNum: 0,
        dragCleanup: null,
        trimStartCleanup: null,
        trimEndCleanup: null
      });
    }

    this._renderPunchMarkers();
    if (this.focusedLineId) {
      this.focusLine(this.focusedLineId);
    }
  }

  _layoutBlocks() {
    for (const line of this.lines) {
      const entry = this.blocks.get(line.id);
      if (!entry) continue;
      const { start, span } = this._lineTiming(line);
      entry.guide.style.left = `${start * this.pxPerSec}px`;
      entry.guide.style.width = `${Math.max(40, span * this.pxPerSec)}px`;
      if (entry.clip) {
        if (entry.clipPositionSec == null) entry.clipPositionSec = start;
        this._applyClipLayout(entry);
      }
    }
  }

  _bindClipDrag(clip, lineId, entry) {
    if (entry.dragCleanup) {
      entry.dragCleanup();
      entry.dragCleanup = null;
    }

    const handle = clip.querySelector(".rw-take-clip-handle");
    if (!handle) return;

    let dragging = false;
    let holdReady = false;
    /** @type {ReturnType<typeof setTimeout>|null} */
    let holdTimer = null;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let downPointerId = null;
    const timeLabel = clip.querySelector(".rw-take-clip-time");
    const HOLD_MS = 280;

    const clearHold = () => {
      if (holdTimer) {
        clearTimeout(holdTimer);
        holdTimer = null;
      }
    };

    const beginDrag = (pointerId) => {
      holdReady = true;
      dragging = true;
      clip.classList.add("rw-take-clip--dragging");
      try {
        handle.setPointerCapture(pointerId);
      } catch {
        /* ignore */
      }
    };

    const onPointerDown = (ev) => {
      if (ev.button !== 0) return;
      if (ev.target.closest(".rw-take-clip-trim")) return;
      ev.preventDefault();
      ev.stopPropagation();
      downPointerId = ev.pointerId;
      startX = ev.clientX;
      startY = ev.clientY;
      startLeft = parseFloat(clip.style.left) || 0;
      holdReady = false;
      dragging = false;
      clearHold();
      holdTimer = setTimeout(() => beginDrag(ev.pointerId), HOLD_MS);
    };

    const onPointerMove = (ev) => {
      if (!holdReady && holdTimer) {
        const dx = Math.abs(ev.clientX - startX);
        const dy = Math.abs(ev.clientY - startY);
        if (dx > 10 || dy > 10) clearHold();
      }
      if (!dragging) return;
      const dx = ev.clientX - startX;
      const maxLeft = Math.max(
        0,
        (this.laneEl?.scrollWidth || 0) - (clip.offsetWidth || 48)
      );
      const nextLeft = Math.max(0, Math.min(startLeft + dx, maxLeft));
      clip.style.left = `${nextLeft}px`;
      const sec = nextLeft / this.pxPerSec;
      if (timeLabel) {
        timeLabel.textContent = formatTimelineLabel(sec);
        timeLabel.hidden = false;
      }
    };

    const onPointerUp = (ev) => {
      clearHold();
      if (!dragging) {
        const dx = Math.abs(ev.clientX - startX);
        const dy = Math.abs(ev.clientY - startY);
        if (dx < 10 && dy < 10 && downPointerId === ev.pointerId) {
          this.hooks.onTakeClipActivate?.(lineId);
        }
        downPointerId = null;
        return;
      }
      dragging = false;
      holdReady = false;
      clip.classList.remove("rw-take-clip--dragging");
      try {
        handle.releasePointerCapture(ev.pointerId);
      } catch {
        /* ignore */
      }
      const leftPx = parseFloat(clip.style.left) || 0;
      const sec = Math.max(0, leftPx / this.pxPerSec);
      entry.clipPositionSec = sec;
      if (timeLabel) timeLabel.hidden = false;
      this.hooks.onClipPositionChange?.(lineId, sec);
      downPointerId = null;
    };

    handle.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);

    entry.dragCleanup = () => {
      clearHold();
      handle.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    };
  }

  setClipPosition(lineId, positionSec) {
    const entry = this.blocks.get(lineId);
    if (!entry?.clip || !Number.isFinite(positionSec)) return;
    entry.clipPositionSec = Math.max(0, positionSec);
    this._applyClipLayout(entry);
  }

  /**
   * @param {string} lineId
   * @param {{ trimStartSec?: number, trimEndSec?: number, gain?: number }} edit
   */
  setClipEdit(lineId, edit) {
    const entry = this.blocks.get(lineId);
    if (!entry?.clip) return;
    const src = entry.sourceDurationSec || 0;
    const merged = normalizeTakeEdit(
      {
        trimStartSec: entry.trimStartSec,
        trimEndSec: entry.trimEndSec,
        gain: entry.gain,
        ...edit
      },
      src
    );
    entry.trimStartSec = merged.trimStartSec;
    entry.trimEndSec = merged.trimEndSec;
    entry.gain = merged.gain;
    this._applyClipLayout(entry);
  }

  _applyClipLayout(entry) {
    if (!entry.clip) return;
    const src = Math.max(MIN_TAKE_CLIP_SEC, entry.sourceDurationSec || 0);
    const edit = normalizeTakeEdit(
      {
        trimStartSec: entry.trimStartSec,
        trimEndSec: entry.trimEndSec,
        gain: entry.gain
      },
      src
    );
    entry.trimStartSec = edit.trimStartSec;
    entry.trimEndSec = edit.trimEndSec;
    const visibleDur = Math.max(
      MIN_TAKE_CLIP_SEC,
      src - edit.trimStartSec - edit.trimEndSec
    );
    const pos =
      entry.clipPositionSec != null
        ? entry.clipPositionSec
        : 0;
    entry.clip.style.left = `${pos * this.pxPerSec}px`;
    entry.clip.style.width = `${Math.max(24, visibleDur * this.pxPerSec)}px`;
    if (entry.waveHost) {
      const fullW = Math.max(24, src * this.pxPerSec);
      entry.waveHost.style.width = `${fullW}px`;
      entry.waveHost.style.marginLeft = `${-edit.trimStartSec * this.pxPerSec}px`;
    }
    const timeInHandle = entry.clip.querySelector(".rw-take-clip-time");
    if (timeInHandle) {
      timeInHandle.textContent = formatTimelineLabel(pos);
      timeInHandle.hidden = true;
    }
    const numEl = entry.clip.querySelector(".rw-take-clip-num");
    const tcEl = entry.clip.querySelector(".rw-take-clip-tc");
    if (numEl && entry.lineNum > 0) {
      numEl.textContent = String(entry.lineNum).padStart(2, "0");
    }
    if (tcEl) {
      tcEl.textContent = formatTimelineLabel(pos);
    }
    if (entry.ws?.media) {
      const media = entry.ws.media;
      if (media instanceof HTMLMediaElement) {
        media.volume = Math.min(1, Math.max(0, edit.gain));
      }
    }
  }

  _emitClipEdit(lineId, entry) {
    this.hooks.onClipEditChange?.(lineId, {
      trimStartSec: entry.trimStartSec,
      trimEndSec: entry.trimEndSec,
      gain: entry.gain
    });
  }

  _bindClipTrim(edgeEl, lineId, entry, side) {
    const cleanupKey =
      side === "start" ? "trimStartCleanup" : "trimEndCleanup";
    if (entry[cleanupKey]) {
      entry[cleanupKey]();
      entry[cleanupKey] = null;
    }

    let holdTimer = null;
    let dragging = false;
    let startX = 0;
    let startTrimStart = 0;
    let startTrimEnd = 0;
    const HOLD_MS = 280;

    const clearHold = () => {
      if (holdTimer) {
        clearTimeout(holdTimer);
        holdTimer = null;
      }
    };

    const onPointerDown = (ev) => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      startX = ev.clientX;
      startTrimStart = entry.trimStartSec;
      startTrimEnd = entry.trimEndSec;
      dragging = false;
      clearHold();
      holdTimer = setTimeout(() => {
        dragging = true;
        edgeEl.classList.add("is-dragging");
        entry.clip?.classList.add("rw-take-clip--trimming");
        try {
          edgeEl.setPointerCapture(ev.pointerId);
        } catch {
          /* ignore */
        }
      }, HOLD_MS);
    };

    const onPointerMove = (ev) => {
      if (!dragging && holdTimer) {
        if (Math.abs(ev.clientX - startX) > 10) clearHold();
      }
      if (!dragging) return;
      const src = entry.sourceDurationSec || 0;
      const dxSec = (ev.clientX - startX) / this.pxPerSec;
      if (side === "start") {
        const next = normalizeTakeEdit(
          {
            trimStartSec: startTrimStart + dxSec,
            trimEndSec: startTrimEnd,
            gain: entry.gain
          },
          src
        );
        entry.trimStartSec = next.trimStartSec;
        entry.trimEndSec = next.trimEndSec;
      } else {
        const next = normalizeTakeEdit(
          {
            trimStartSec: startTrimStart,
            trimEndSec: startTrimEnd - dxSec,
            gain: entry.gain
          },
          src
        );
        entry.trimStartSec = next.trimStartSec;
        entry.trimEndSec = next.trimEndSec;
      }
      this._applyClipLayout(entry);
    };

    const onPointerUp = (ev) => {
      clearHold();
      if (!dragging) return;
      dragging = false;
      edgeEl.classList.remove("is-dragging");
      entry.clip?.classList.remove("rw-take-clip--trimming");
      try {
        edgeEl.releasePointerCapture(ev.pointerId);
      } catch {
        /* ignore */
      }
      this._emitClipEdit(lineId, entry);
    };

    edgeEl.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);

    entry[cleanupKey] = () => {
      clearHold();
      edgeEl.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    };
  }

  _bindClipTrims(clip, lineId, entry) {
    const trimStart = clip.querySelector(".rw-take-clip-trim--start");
    const trimEnd = clip.querySelector(".rw-take-clip-trim--end");
    if (trimStart) this._bindClipTrim(trimStart, lineId, entry, "start");
    if (trimEnd) this._bindClipTrim(trimEnd, lineId, entry, "end");
  }

  _ensureClip(lineId) {
    const entry = this.blocks.get(lineId);
    if (!entry || entry.clip) return entry;

    const line = this.lines.find((l) => l.id === lineId);
    if (!line) return entry;

    const { start, span } = this._lineTiming(line);
    const clip = document.createElement("div");
    clip.className = "rw-take-clip";
    clip.dataset.lineId = lineId;
    clip.style.left = `${start * this.pxPerSec}px`;
    clip.style.width = `${Math.max(48, span * this.pxPerSec)}px`;

    const trimStartEl = document.createElement("div");
    trimStartEl.className = "rw-take-clip-trim rw-take-clip-trim--start";
    trimStartEl.title = "長押し→ドラッグで頭をトリム";
    trimStartEl.setAttribute("aria-label", "収録の頭をトリム");
    clip.appendChild(trimStartEl);

    const trimEndEl = document.createElement("div");
    trimEndEl.className = "rw-take-clip-trim rw-take-clip-trim--end";
    trimEndEl.title = "長押し→ドラッグで末尾をトリム";
    trimEndEl.setAttribute("aria-label", "収録の末尾をトリム");
    clip.appendChild(trimEndEl);

    const handle = document.createElement("div");
    handle.className = "rw-take-clip-handle";
    handle.title = "長押し／ドラッグでタイムライン上の位置を移動";
    handle.setAttribute("aria-label", "収録クリップを移動");
    const grip = document.createElement("span");
    grip.className = "rw-take-clip-grip";
    grip.textContent = "⋮⋮";
    handle.appendChild(grip);

    const timeLabel = document.createElement("span");
    timeLabel.className = "rw-take-clip-time";
    timeLabel.hidden = true;
    handle.appendChild(timeLabel);

    clip.appendChild(handle);

    const idLabel = document.createElement("div");
    idLabel.className = "rw-take-clip-id";
    const numSpan = document.createElement("span");
    numSpan.className = "rw-take-clip-num";
    numSpan.textContent = "—";
    const tcSpan = document.createElement("span");
    tcSpan.className = "rw-take-clip-tc";
    tcSpan.textContent = "0:00";
    idLabel.appendChild(numSpan);
    idLabel.appendChild(tcSpan);
    clip.appendChild(idLabel);

    const waveHost = document.createElement("div");
    waveHost.className = "rw-take-clip-wave";
    clip.appendChild(waveHost);

    this.laneEl.appendChild(clip);
    entry.clip = clip;
    entry.waveHost = waveHost;
    clip.style.cursor = "pointer";
    if (this.focusedLineId === lineId) {
      clip.classList.add("rw-take-clip--focused");
    }
    return entry;
  }

  _destroyBlockWave(entry) {
    if (entry.trimStartCleanup) {
      entry.trimStartCleanup();
      entry.trimStartCleanup = null;
    }
    if (entry.trimEndCleanup) {
      entry.trimEndCleanup();
      entry.trimEndCleanup = null;
    }
    if (entry.dragCleanup) {
      entry.dragCleanup();
      entry.dragCleanup = null;
    }
    if (entry.ws) {
      try {
        entry.ws.destroy();
      } catch {
        /* ignore */
      }
      entry.ws = null;
    }
    if (entry.url) {
      URL.revokeObjectURL(entry.url);
      entry.url = null;
    }
    if (entry.waveHost) entry.waveHost.innerHTML = "";
  }

  _destroyAllBlockWaves() {
    for (const entry of this.blocks.values()) {
      this._destroyBlockWave(entry);
    }
  }

  /**
   * セリフ枠内に収録波形を描画
   * @param {string} lineId
   * @param {Blob} blob
   */
  /**
   * @param {string} lineId
   * @param {Blob} blob
   * @param {{ positionSec?: number, lineNum?: number, edit?: { trimStartSec?: number, trimEndSec?: number, gain?: number } }} [opts]
   */
  async setTakeWave(lineId, blob, opts = {}) {
    const entry = this._ensureClip(lineId);
    if (!entry?.waveHost) return;

    this._destroyBlockWave(entry);
    entry.guide.classList.add("rw-guide-marker--has-take");

    const line = this.lines.find((l) => l.id === lineId);
    const start =
      entry.clipPositionSec != null
        ? entry.clipPositionSec
        : opts.positionSec != null && Number.isFinite(opts.positionSec)
          ? Math.max(0, opts.positionSec)
          : line
            ? Math.max(0, line.startSec)
            : 0;
    entry.clipPositionSec = start;
    entry.lineNum = opts.lineNum ?? entry.lineNum ?? 0;
    const editIn = opts.edit || DEFAULT_TAKE_EDIT;
    entry.trimStartSec = editIn.trimStartSec ?? 0;
    entry.trimEndSec = editIn.trimEndSec ?? 0;
    entry.gain = editIn.gain ?? 1;

    const url = blobToObjectUrl(blob);
    entry.url = url;

    const mediaEl = document.createElement("audio");
    mediaEl.src = url;
    prepareSafariMedia(mediaEl);

    const ws = WaveSurfer.create({
      container: entry.waveHost,
      media: mediaEl,
      height: 56,
      waveColor: TAKE_WAVE_COLOR,
      progressColor: TAKE_WAVE_PROGRESS,
      cursorColor: "transparent",
      cursorWidth: 0,
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
      normalize: true,
      interact: false,
      dragToSeek: false,
      mediaControls: false,
      fillParent: false,
      minPxPerSec: this.pxPerSec,
      hideScrollbar: true
    });

    entry.ws = ws;

    await new Promise((resolve, reject) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve(undefined);
      };
      ws.on("ready", () => {
        try {
          const dur = ws.getDuration();
          if (dur > 0 && entry.clip) {
            entry.sourceDurationSec = dur;
            const norm = normalizeTakeEdit(
              {
                trimStartSec: entry.trimStartSec,
                trimEndSec: entry.trimEndSec,
                gain: entry.gain
              },
              dur
            );
            entry.trimStartSec = norm.trimStartSec;
            entry.trimEndSec = norm.trimEndSec;
            entry.gain = norm.gain;
            ws.zoom(this.pxPerSec);
            this._applyClipLayout(entry);
            this.hooks.onTakeDuration?.(lineId, dur);
            this._bindClipDrag(entry.clip, lineId, entry);
            this._bindClipTrims(entry.clip, lineId, entry);
          }
        } catch {
          /* ignore */
        }
        finish();
      });
      ws.on("error", (e) => {
        if (!done) reject(e instanceof Error ? e : new Error(String(e)));
      });
      mediaEl.addEventListener("canplay", finish, { once: true });
      mediaEl.addEventListener("error", () => {
        if (!done) reject(new Error("収録音声の読み込みに失敗しました"));
      }, { once: true });
      if (mediaEl.readyState >= 2) finish();
      setTimeout(finish, 8000);
    });
  }

  clearTakeWave(lineId) {
    const entry = this.blocks.get(lineId);
    if (!entry) return;
    this._destroyBlockWave(entry);
    entry.guide.classList.remove("rw-guide-marker--has-take");
    if (entry.clip) {
      entry.clip.remove();
      entry.clip = null;
      entry.waveHost = null;
    }
  }

  destroy() {
    this._destroyAllBlockWaves();
    if (this.laneEl) this.laneEl.innerHTML = "";
    this.blocks.clear();
    this.lines = [];
  }
}

/**
 * 2行マルチトラック — app.js からは従来の SyncedWaveform と同じ API で利用
 */
export class DualTrackWaveform {
  /**
   * @param {HTMLElement} refContainer
   * @param {HTMLElement} takeLaneEl
   * @param {HTMLElement} takeScrollEl
   * @param {{ onTimeUpdate?: (t:number)=>void, onSeek?: (t:number)=>void, onRegionClick?: (lineId:string, startSec:number)=>void, onTakeFile?: (lineId:string, file:File)=>void }} hooks
   */
  constructor(refContainer, takeLaneEl, takeScrollEl, hooks = {}) {
    this.refContainer = refContainer;
    this.takeLaneEl = takeLaneEl;
    this.takeScrollEl = takeScrollEl;
    this.hooks = hooks;
    this.ref = new SyncedWaveform(refContainer, null, {
      enableRegions: false,
      onTimeUpdate: (t) => hooks.onTimeUpdate?.(t),
      onSeek: (t) => hooks.onSeek?.(t),
      onRegionClick: (id, s) => hooks.onRegionClick?.(id, s)
    });
    this.takeLane = new TakeTrackLane(takeLaneEl, takeScrollEl, {
      onRegionClick: (id, s) => hooks.onRegionClick?.(id, s),
      onTakeFile: (id, f) => hooks.onTakeFile?.(id, f),
      onClipPositionChange: (id, sec) => hooks.onClipPositionChange?.(id, sec),
      onClipEditChange: (id, edit) => hooks.onClipEditChange?.(id, edit),
      onTakeDuration: (id, dur) => hooks.onTakeDuration?.(id, dur),
      onTakeClipActivate: (id) => hooks.onTakeClipActivate?.(id)
    });
    this._syncingScroll = false;
    this._boundRefScroll = () => this._syncTakeScrollFromRef();
    this._boundTakeScroll = () => this._syncRefScrollFromTake();
    this.ref.onScrollElReady = (el) => {
      if (el) {
        el.removeEventListener("scroll", this._boundRefScroll);
        el.addEventListener("scroll", this._boundRefScroll, { passive: true });
      }
    };
    if (takeScrollEl) {
      takeScrollEl.addEventListener("scroll", this._boundTakeScroll, {
        passive: true
      });
    }
    /** 互換: app.js が waveform.ws を参照 */
    Object.defineProperty(this, "ws", {
      get: () => this.ref.ws
    });
    Object.defineProperty(this, "ready", {
      get: () => this.ref.ready
    });
    Object.defineProperty(this, "mediaEl", {
      get: () => this.ref.mediaEl
    });
  }

  _syncTakeScrollFromRef() {
    if (this._syncingScroll) return;
    const refScroll = this.ref.getScrollElement();
    if (!refScroll || !this.takeScrollEl) return;
    this._syncingScroll = true;
    this.takeScrollEl.scrollLeft = refScroll.scrollLeft;
    this._syncingScroll = false;
  }

  _syncRefScrollFromTake() {
    if (this._syncingScroll) return;
    const refScroll = this.ref.getScrollElement();
    if (!refScroll || !this.takeScrollEl) return;
    this._syncingScroll = true;
    refScroll.scrollLeft = this.takeScrollEl.scrollLeft;
    if (typeof this.ref.ws?.setScrollTime === "function") {
      try {
        const t = this.takeScrollEl.scrollLeft / WAVEFORM_MIN_PX_PER_SEC;
        this.ref.ws.setScrollTime(t);
      } catch {
        /* ignore */
      }
    }
    this._syncingScroll = false;
  }

  async loadUrl(audioUrl) {
    await this.ref.loadUrl(audioUrl);
    const dur = this.ref.getDuration();
    this.takeLane.setDuration(dur);
    this.takeLane.setPxPerSec(WAVEFORM_MIN_PX_PER_SEC);
    const refScroll = this.ref.getScrollElement();
    if (refScroll) {
      refScroll.removeEventListener("scroll", this._boundRefScroll);
      refScroll.addEventListener("scroll", this._boundRefScroll, {
        passive: true
      });
    }
  }

  /**
   * @param {typeof this.takeLane.lines} lines
   * @param {{ durationHint?: number }} [opts] リファレンス未読込時のタイムライン長（秒）
   */
  setScriptLines(lines, opts = {}) {
    this.ref.setScriptLines([]);
    this.takeLane.setScriptLines(lines);
    const dur = this.ref.getDuration() || opts.durationHint || 0;
    if (dur > 0) {
      this.takeLane.setDuration(dur);
      this.takeLane.setPxPerSec(WAVEFORM_MIN_PX_PER_SEC);
    }
  }

  /** @param {Iterable<string>|Set<string>} cueIds */
  setRetakeCueIds(cueIds) {
    const set = cueIds instanceof Set ? cueIds : new Set(cueIds || []);
    this.ref.setRetakeCueIds(set);
    this.takeLane.setRetakeCueIds(set);
  }

  /**
   * @param {string} lineId
   * @param {Blob} blob
   * @param {{ positionSec?: number, lineNum?: number, edit?: { trimStartSec?: number, trimEndSec?: number, gain?: number } }} [opts]
   */
  async setTakeForLine(lineId, blob, opts = {}) {
    await this.takeLane.setTakeWave(lineId, blob, opts);
  }

  setPunchInMarkers(punchMap) {
    this.takeLane.setPunchInMarkers(punchMap);
  }

  setClipPosition(lineId, positionSec) {
    this.takeLane.setClipPosition(lineId, positionSec);
  }

  /**
   * @param {string} lineId
   * @param {{ trimStartSec?: number, trimEndSec?: number, gain?: number }} edit
   */
  setClipEdit(lineId, edit) {
    this.takeLane.setClipEdit(lineId, edit);
  }

  /** @param {string|null} lineId */
  setRecordingHighlight(lineId) {
    this.takeLane.setRecordingHighlight(lineId);
  }

  clearTakeForLine(lineId) {
    this.takeLane.clearTakeWave(lineId);
  }

  focusScriptLine(lineId, startSec, opts = {}) {
    this.ref.focusedLineId = lineId;
    this.takeLane.focusLine(lineId);
    const { seek = false, scroll = true } = opts;
    const t = Math.max(0, startSec);
    if (seek && this.ref.ready) {
      this.ref.setTime(t, { scroll: false });
    }
    if (scroll) {
      this.ref.scrollToTime(t, { force: true });
      this._syncTakeScrollFromRef();
    }
  }

  clearScriptRegions() {
    this.ref.clearScriptRegions();
    this.takeLane.setScriptLines([]);
  }

  setTime(seconds, opts = {}) {
    this.ref.setTime(seconds, opts);
    if (opts.scroll) this._syncTakeScrollFromRef();
  }

  scrollToTime(seconds, opts = {}) {
    this.ref.scrollToTime(seconds, opts);
    this._syncTakeScrollFromRef();
  }

  async play() {
    return this.ref.play();
  }

  pause() {
    this.ref.pause();
  }

  isPlayingNow() {
    return this.ref.isPlayingNow();
  }

  getCurrentTime() {
    return this.ref.getCurrentTime();
  }

  getDuration() {
    return this.ref.getDuration();
  }

  destroy() {
    const refScroll = this.ref.getScrollElement();
    refScroll?.removeEventListener("scroll", this._boundRefScroll);
    this.takeScrollEl?.removeEventListener("scroll", this._boundTakeScroll);
    this.takeLane.destroy();
    this.ref.destroy();
  }
}

export function vocalSeparationHint(vocalSeparated) {
  if (vocalSeparated) {
    return "AIボーカル分離: 適用済み（BGM/伴奏を抑制）";
  }
  return "AIボーカル分離: 未適用 — ./scripts/restart-audio-proxy.sh でプロキシ再起動（②は数分かかります）";
}

function isLoopbackUrl(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h === "localhost" || h === "127.0.0.1" || h === "[::1]";
  } catch {
    return false;
  }
}

export function explainProxyFetchFailure(err, extractUrl) {
  const msg = err instanceof Error ? err.message : String(err);
  const pageSecure =
    typeof location !== "undefined" && location.protocol === "https:";
  let extractHttp = false;
  try {
    extractHttp = new URL(extractUrl).protocol === "http:";
  } catch {
    /* ignore */
  }

  if (pageSecure && (extractHttp || isLoopbackUrl(extractUrl))) {
    return [
      "このページは HTTPS のため、http://127.0.0.1 などローカル／非暗号化のプロキシには接続できません（ブラウザがブロック＝Failed to fetch）。",
      "対処: ① ローカル開発なら http://127.0.0.1:8889/record-workspace.html で開き、Mac でプロキシを起動。",
      "② 本番 wavrick.com では cloudflared の https://…trycloudflare.com/extract を下に貼り「保存」。",
      "③ または「音声ファイル」で波形のみ表示。"
    ].join(" ");
  }

  if (msg === "Failed to fetch" || /networkerror|load failed/i.test(msg)) {
    const page = typeof location !== "undefined" ? location.href : "";
    const onLocal8889 =
      typeof location !== "undefined" &&
      (location.hostname === "127.0.0.1" || location.hostname === "localhost") &&
      location.port === "8889";
    return [
      "プロキシに接続できませんでした（Failed to fetch）。",
      onLocal8889
        ? "① 別ターミナルで ./scripts/start-dev-server.sh（8889）② 別ターミナルで ./scripts/restart-audio-proxy.sh（5055）が両方動いているか確認。"
        : "ローカル開発は http://127.0.0.1:8889/record-workspace.html で開いてください（https や file:// では不可）。",
      "詳細設定のプロキシ URL が古い cloudflare や 127.0.0.1:5055 直指定になっていないか確認（ローカルは自動で /api/youtube-audio/extract を使います）。",
      "長い動画は demucs で 5〜15 分かかります。② を連打せず、プロキシのターミナルにログが出るまで待ってください。",
      "代替: 「音声ファイル」を選択。"
    ].join(" ");
  }
  return msg;
}

export async function fetchAudioBlobFromProxy(videoUrl, proxy) {
  const extractUrl = resolveProxyExtractUrl(proxy.extractUrl);
  let sameOrigin = false;
  try {
    sameOrigin = new URL(extractUrl).origin === location.origin;
  } catch {
    sameOrigin = false;
  }

  if (sameOrigin && typeof location !== "undefined") {
    try {
      const healthUrl = `${location.origin}/api/youtube-audio/health`;
      const healthRes = await fetch(healthUrl, { method: "GET" });
      if (!healthRes.ok) {
        throw new Error(
          "開発サーバー (8889) は起動していますが、音声プロキシ (5055) に届きません。./scripts/restart-audio-proxy.sh を実行してください。"
        );
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("音声プロキシ")) {
        throw err;
      }
      throw new Error(
        "開発サーバー (http://127.0.0.1:8889) に接続できません。別ターミナルで ./scripts/start-dev-server.sh を起動してください。"
      );
    }
  }

  let res;
  try {
    const headers = { "Content-Type": "application/json" };
    if (!sameOrigin) {
      headers.Authorization = `Bearer ${proxy.secret}`;
    }
    res = await fetch(extractUrl, {
      method: "POST",
      headers,
      credentials: sameOrigin ? "same-origin" : "omit",
      body: JSON.stringify({
        videoUrl,
        vocalSeparate: true
      })
    });
  } catch (err) {
    throw new Error(explainProxyFetchFailure(err, extractUrl));
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      text || `音声プロキシエラー (${res.status})。Mac で ./scripts/cursor-ai-setup.sh を実行してください。`
    );
  }
  const blob = await res.blob();
  const type =
    blob.type && blob.type !== "application/octet-stream"
      ? blob.type
      : "audio/mpeg";
  const vocalSeparated = res.headers.get("X-Wavrick-Vocal-Separated") === "1";
  return {
    blob: new Blob([blob], { type }),
    vocalSeparated
  };
}

export function resolveProxyExtractUrl(raw) {
  const t = (raw || "").trim();
  if (!t) return t;
  if (typeof location !== "undefined" && t.startsWith("/")) {
    let path = t.replace(/\/+$/, "");
    if (!path.endsWith("/extract")) path = `${path}/extract`;
    return `${location.origin}${path}`;
  }
  let u = t;
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  const base = u.replace(/\/+$/, "");
  if (base.endsWith("/extract")) return base;
  return `${base}/extract`;
}

export function readProxyConfig() {
  const cfg = typeof window !== "undefined" ? window.WAVRICK_CONFIG || {} : {};
  const host =
    typeof location !== "undefined" ? location.hostname.toLowerCase() : "";
  const isLocalDev =
    host === "localhost" || host === "127.0.0.1" || host === "[::1]";

  const secret =
    localStorage.getItem("wavrick_audio_proxy_secret") ||
    cfg.audioProxySecret ||
    "wavrick-local-dev-secret";

  if (isLocalDev && typeof location !== "undefined") {
    return {
      extractUrl: `${location.origin}/api/youtube-audio/extract`,
      secret
    };
  }

  const rawUrl =
    localStorage.getItem("wavrick_audio_proxy_url") ||
    cfg.audioProxyUrl ||
    "http://127.0.0.1:5055/extract";
  const extractUrl = resolveProxyExtractUrl(rawUrl);
  return { extractUrl, secret };
}

export { isSafariBrowser };
