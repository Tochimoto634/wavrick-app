/**
 * マイク録音 — record-workspace-mic-test.html と同じ手順
 * MediaRecorder + start(250) + onstop で Blob 化（Chrome / Windows 向け）
 */

import {
  DEFAULT_TAKE_EDIT,
  normalizeTakeEdit
} from "./take-audio-edit.js?v=rw-take-edit-2026-05-22";

function newTakeId() {
  return `take-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const MIN_BLOB_BYTES = 44;
const TIMESLICE_MS = 250;
const GUM_TIMEOUT_MS = 20000;
const STOP_TIMEOUT_MS = 8000;

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

export class LineRecorder {
  /**
   * @param {{ previewAudio?: HTMLAudioElement | null }} [options]
   */
  constructor(options = {}) {
    this.previewAudio = options.previewAudio ?? null;
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
    this.recordingLineId = null;
    /** ADR スタンバイ: マイクだけ開き、まだ MediaRecorder は動かさない */
    this.armedLineId = null;
    /** @type {Map<string, { takes: { id: string, url: string, blob: Blob, size: number, label: string|null, durationSec: number|null, edit: { trimStartSec: number, trimEndSec: number, gain: number }, editDraft: { trimStartSec: number, trimEndSec: number, gain: number } }[], activeIndex: number }>} */
    this.lineTakes = new Map();
    this.onTakeChange = null;
    this.lastFail = null;
    /** @type {{ id: string, lineId: string, originalIndex: number, take: object, deletedAt: string }[]} */
    this.trash = [];
    /** @type {Promise<Blob|null>|null} */
    this.stopPromise = null;
    /** @type {((blob: Blob|null) => void)|null} */
    this._stopResolve = null;
  }

  getLineState(lineId) {
    let s = this.lineTakes.get(lineId);
    if (!s) {
      s = { takes: [], activeIndex: 0 };
      this.lineTakes.set(lineId, s);
    }
    return s;
  }

  getTakeCount(lineId) {
    return this.getLineState(lineId).takes.length;
  }

  getActiveTakeIndex(lineId) {
    const s = this.getLineState(lineId);
    if (!s.takes.length) return -1;
    return Math.min(Math.max(0, s.activeIndex), s.takes.length - 1);
  }

  hasRecording(lineId) {
    return this.getTakeCount(lineId) > 0;
  }

  isRecording(lineId) {
    return (
      this.recordingLineId === lineId && this.recorder?.state === "recording"
    );
  }

  isArmed(lineId) {
    return this.armedLineId === lineId && Boolean(this.stream);
  }

  hasActiveSession(lineId) {
    return this.isRecording(lineId) || this.isArmed(lineId);
  }

  getActiveTake(lineId) {
    const s = this.getLineState(lineId);
    const i = this.getActiveTakeIndex(lineId);
    return i >= 0 ? s.takes[i] : null;
  }

  getLastFailReason() {
    return this.lastFail;
  }

  cycleTake(lineId, delta) {
    const s = this.getLineState(lineId);
    if (!s.takes.length) return;
    const n = s.takes.length;
    s.activeIndex = (s.activeIndex + delta + n) % n;
    this.onTakeChange?.(lineId, s.takes.length, s.takes[s.activeIndex]?.blob);
  }

  setActiveTake(lineId, index) {
    const s = this.getLineState(lineId);
    if (index < 0 || index >= s.takes.length) return false;
    s.activeIndex = index;
    this.onTakeChange?.(lineId, s.takes.length, s.takes[index]?.blob);
    return true;
  }

  /**
   * @param {string} lineId
   * @param {number} index
   * @returns {boolean}
   */
  getTrash() {
    return this.trash.slice();
  }

  setTrash(entries) {
    this.trash = Array.isArray(entries) ? entries.slice() : [];
  }

  /**
   * @param {string} lineId
   * @param {number} index
   * @returns {string|null} trash entry id
   */
  moveTakeToTrash(lineId, index) {
    const s = this.getLineState(lineId);
    if (index < 0 || index >= s.takes.length) return null;
    const removed = s.takes.splice(index, 1)[0];
    const entryId = `trash-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.trash.push({
      id: entryId,
      lineId,
      originalIndex: index,
      take: removed,
      deletedAt: new Date().toISOString()
    });
    if (!s.takes.length) {
      s.activeIndex = 0;
      this.onTakeChange?.(lineId, 0, null);
    } else {
      s.activeIndex = Math.min(s.activeIndex, s.takes.length - 1);
      this.onTakeChange?.(lineId, s.takes.length, s.takes[s.activeIndex]?.blob);
    }
    return entryId;
  }

  /**
   * @param {string} trashId
   * @returns {boolean}
   */
  restoreFromTrash(trashId) {
    const i = this.trash.findIndex((e) => e.id === trashId);
    if (i < 0) return false;
    const entry = this.trash.splice(i, 1)[0];
    const s = this.getLineState(entry.lineId);
    const insertAt = Math.min(Math.max(0, entry.originalIndex), s.takes.length);
    s.takes.splice(insertAt, 0, entry.take);
    s.activeIndex = insertAt;
    this.onTakeChange?.(entry.lineId, s.takes.length, entry.take?.blob ?? null);
    return true;
  }

  /**
   * @param {string} trashId
   * @returns {boolean}
   */
  purgeTrashEntry(trashId) {
    const i = this.trash.findIndex((e) => e.id === trashId);
    if (i < 0) return false;
    const entry = this.trash.splice(i, 1)[0];
    if (entry.take?.url) URL.revokeObjectURL(entry.take.url);
    return true;
  }

  deleteTake(lineId, index) {
    const s = this.getLineState(lineId);
    if (index < 0 || index >= s.takes.length) return false;
    const removed = s.takes.splice(index, 1)[0];
    if (removed?.url) URL.revokeObjectURL(removed.url);
    if (!s.takes.length) {
      s.activeIndex = 0;
      this.onTakeChange?.(lineId, 0, null);
    } else {
      s.activeIndex = Math.min(s.activeIndex, s.takes.length - 1);
      this.onTakeChange?.(lineId, s.takes.length, s.takes[s.activeIndex]?.blob);
    }
    return true;
  }

  /**
   * クラウド復元用
   * @param {string} lineId
   * @param {object} meta
   * @param {Blob} blob
   */
  importTake(lineId, meta, blob) {
    const s = this.getLineState(lineId);
    const url = URL.createObjectURL(blob);
    const edit = normalizeTakeEdit(meta.edit ?? DEFAULT_TAKE_EDIT, meta.durationSec ?? 0);
    const editDraft = normalizeTakeEdit(
      meta.editDraft ?? meta.edit ?? DEFAULT_TAKE_EDIT,
      meta.durationSec ?? 0
    );
    s.takes.push({
      id: meta.id || newTakeId(),
      url,
      blob,
      size: meta.size ?? blob.size,
      label: meta.label ?? null,
      durationSec: meta.durationSec ?? null,
      status: meta.status ?? null,
      edit,
      editDraft
    });
  }

  applyLinePack(lineId, { takes = [], activeIndex = 0 } = {}) {
    const s = this.getLineState(lineId);
    for (const t of s.takes) {
      if (t.url) URL.revokeObjectURL(t.url);
    }
    s.takes = takes;
    s.activeIndex = takes.length
      ? Math.min(Math.max(0, activeIndex), takes.length - 1)
      : 0;
    this.onTakeChange?.(
      lineId,
      s.takes.length,
      s.takes[s.activeIndex]?.blob ?? null
    );
  }

  clearAllTakes() {
    for (const [, s] of this.lineTakes) {
      for (const t of s.takes) {
        if (t.url) URL.revokeObjectURL(t.url);
      }
    }
    this.lineTakes.clear();
    for (const e of this.trash) {
      if (e.take?.url) URL.revokeObjectURL(e.take.url);
    }
    this.trash = [];
  }

  getTakes(lineId) {
    return this.getLineState(lineId).takes;
  }

  /** @param {string} lineId @param {number} index */
  getTakeLabel(lineId, index) {
    const s = this.getLineState(lineId);
    const take = s.takes[index];
    if (!take) return "";
    const custom = (take.label || "").trim();
    if (custom) return custom;
    return `Take ${index + 1}`;
  }

  /**
   * @param {string} lineId
   * @param {number} index
   * @param {string} label 空ならデフォルト名に戻す
   */
  /** @param {string} lineId @param {number} index */
  cycleTakeStatus(lineId, index) {
    const s = this.getLineState(lineId);
    if (index < 0 || index >= s.takes.length) return null;
    const order = [null, "candidate", "ng", "redo"];
    const cur = s.takes[index].status ?? null;
    const i = order.indexOf(cur);
    const next = order[(i + 1) % order.length];
    s.takes[index].status = next;
    return next;
  }

  /** @param {string} lineId @param {number} index */
  getTakeStatus(lineId, index) {
    return this.getLineState(lineId).takes[index]?.status ?? null;
  }

  setTakeLabel(lineId, index, label) {
    const s = this.getLineState(lineId);
    if (index < 0 || index >= s.takes.length) return false;
    const t = (label || "").trim();
    s.takes[index].label = t || null;
    if (index === s.activeIndex) {
      this.onTakeChange?.(lineId, s.takes.length, s.takes[index]?.blob);
    }
    return true;
  }

  /** @param {string} lineId @param {number} index */
  getTakeEdit(lineId, index) {
    const take = this.getLineState(lineId).takes[index];
    if (!take) return { ...DEFAULT_TAKE_EDIT };
    return normalizeTakeEdit(take.edit, take.durationSec ?? 0);
  }

  /** @param {string} lineId @param {number} index */
  getTakeEditDraft(lineId, index) {
    const take = this.getLineState(lineId).takes[index];
    if (!take) return { ...DEFAULT_TAKE_EDIT };
    const draft = take.editDraft || take.edit;
    return normalizeTakeEdit(draft, take.durationSec ?? 0);
  }

  /**
   * @param {string} lineId
   * @param {number} index
   * @param {Partial<typeof DEFAULT_TAKE_EDIT>} patch
   */
  setTakeEditDraft(lineId, index, patch) {
    const s = this.getLineState(lineId);
    if (index < 0 || index >= s.takes.length) return false;
    const take = s.takes[index];
    if (!take.editDraft) take.editDraft = { ...take.edit };
    take.editDraft = normalizeTakeEdit(
      { ...take.editDraft, ...patch },
      take.durationSec ?? 0
    );
    return true;
  }

  hasUnappliedEditDraft(lineId, index) {
    const applied = this.getTakeEdit(lineId, index);
    const draft = this.getTakeEditDraft(lineId, index);
    return (
      Math.abs(applied.trimStartSec - draft.trimStartSec) > 0.005 ||
      Math.abs(applied.trimEndSec - draft.trimEndSec) > 0.005 ||
      Math.abs(applied.gain - draft.gain) > 0.005
    );
  }

  /**
   * @param {string} lineId
   * @param {number} index
   * @param {Partial<typeof DEFAULT_TAKE_EDIT>} patch
   * @param {{ notify?: boolean }} [opts]
   */
  setTakeEdit(lineId, index, patch, opts = {}) {
    const s = this.getLineState(lineId);
    if (index < 0 || index >= s.takes.length) return false;
    const take = s.takes[index];
    take.edit = normalizeTakeEdit(
      { ...take.edit, ...patch },
      take.durationSec ?? 0
    );
    take.editDraft = { ...take.edit };
    if (opts.notify !== false && index === s.activeIndex) {
      this.onTakeChange?.(lineId, s.takes.length, take.blob);
    }
    return true;
  }

  /** ドラフトを本番の edit に反映 */
  applyTakeEditDraft(lineId, index, opts = {}) {
    const draft = this.getTakeEditDraft(lineId, index);
    return this.setTakeEdit(lineId, index, draft, opts);
  }

  /** @param {string} lineId @param {number} index */
  setTakeDuration(lineId, index, durationSec) {
    const s = this.getLineState(lineId);
    if (index < 0 || index >= s.takes.length) return false;
    const take = s.takes[index];
    if (!Number.isFinite(durationSec) || durationSec <= 0) return false;
    take.durationSec = durationSec;
    take.edit = normalizeTakeEdit(take.edit, durationSec);
    if (take.editDraft) {
      take.editDraft = normalizeTakeEdit(take.editDraft, durationSec);
    }
    return true;
  }

  /** @param {string} lineId @param {number} index */
  resetTakeEdit(lineId, index) {
    const empty = { ...DEFAULT_TAKE_EDIT };
    const s = this.getLineState(lineId);
    if (index < 0 || index >= s.takes.length) return false;
    const take = s.takes[index];
    take.edit = normalizeTakeEdit(empty, take.durationSec ?? 0);
    take.editDraft = { ...take.edit };
    return true;
  }

  _finishStopPromise(blob) {
    const resolve = this._stopResolve;
    this._stopResolve = null;
    this.stopPromise = null;
    if (resolve) resolve(blob);
  }

  stopStream() {
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
  }

  discardRecorder() {
    this.recorder = null;
    this.chunks = [];
  }

  forceReset() {
    this._finishStopPromise(null);
    this.recordingLineId = null;
    this.armedLineId = null;
    this.discardRecorder();
    this.stopStream();
  }

  disarm() {
    this.armedLineId = null;
    if (!this.recorder) {
      this.discardRecorder();
      this.stopStream();
    }
  }

  /**
   * マイクだけ取得（ADR プレロール用スタンバイ）
   * @param {string} lineId
   * @param {Promise<MediaStream>} [micStreamPromise]
   */
  async arm(lineId, micStreamPromise) {
    if (this.isRecording(lineId)) return;
    if (this.armedLineId === lineId && this.stream) return;

    this.cancelRecording();
    this.lastFail = null;
    this.chunks = [];

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("このブラウザはマイク録音に対応していません。");
    }

    try {
      const gum =
        micStreamPromise ||
        navigator.mediaDevices.getUserMedia({ audio: true });
      this.stream = await withTimeout(
        gum,
        GUM_TIMEOUT_MS,
        "マイクの取得がタイムアウトしました。ブラウザのマイク許可と入力デバイスを確認し、ページを再読み込みしてください。"
      );
    } catch (err) {
      this.armedLineId = null;
      this.stopStream();
      const name = err instanceof Error ? err.name : "";
      if (name === "NotAllowedError" || name === "PermissionDeniedError") {
        throw new Error(
          "マイクが拒否されました。アドレスバーの 🔒 から「許可」にしてください。"
        );
      }
      throw err instanceof Error ? err : new Error(String(err));
    }

    this.armedLineId = lineId;
  }

  _startRecorderOnStream(lineId) {
    if (!this.stream) {
      throw new Error("マイクが準備できていません。");
    }

    const mime = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "";
    try {
      this.recorder = mime
        ? new MediaRecorder(this.stream, { mimeType: mime })
        : new MediaRecorder(this.stream);
    } catch {
      this.recorder = new MediaRecorder(this.stream);
    }

    const rec = this.recorder;
    const chunks = this.chunks;

    rec.ondataavailable = (e) => {
      if (e.data?.size) chunks.push(e.data);
    };

    rec.onerror = () => {
      this.lastFail = { reason: "error", message: "MediaRecorder error" };
    };

    rec.start(TIMESLICE_MS);

    if (rec.state !== "recording") {
      this.discardRecorder();
      this.stopStream();
      this.armedLineId = null;
      throw new Error("録音エンジンを開始できませんでした。");
    }

    this.armedLineId = null;
    this.recordingLineId = lineId;
  }

  /** スタンバイ済みストリームでパンチイン録音開始 */
  punchIn(lineId) {
    if (this.isRecording(lineId)) return;
    if (this.armedLineId !== lineId || !this.stream) {
      throw new Error("マイクのスタンバイが切れています。もう一度 ● 録音 から始めてください。");
    }
    this._startRecorderOnStream(lineId);
  }

  /**
   * @param {string} lineId
   * @param {Promise<MediaStream>} [micStreamPromise] ユーザ操作直後に開始した getUserMedia
   */
  async startRecording(lineId, micStreamPromise) {
    if (this.isRecording(lineId)) return;

    this.forceReset();
    this.lastFail = null;
    this.chunks = [];
    await this.arm(lineId, micStreamPromise);
    this.punchIn(lineId);
  }

  /**
   * @param {string} lineId
   * @returns {Promise<Blob|null>}
   */
  stop(lineId) {
    if (this.stopPromise) return this.stopPromise;

    this.stopPromise = new Promise((resolve) => {
      this._stopResolve = resolve;

      const done = (blob) => {
        this.recordingLineId = null;
        this.discardRecorder();
        this._finishStopPromise(blob);
      };

      if (this.recordingLineId !== lineId || !this.recorder) {
        done(null);
        return;
      }

      const rec = this.recorder;
      const chunks = this.chunks;
      const stream = this.stream;
      const mime = rec.mimeType || "audio/webm";
      let settled = false;

      const finish = (blob) => {
        if (settled) return;
        settled = true;
        clearTimeout(stopTimer);
        if (!blob || blob.size < MIN_BLOB_BYTES) {
          this.lastFail = {
            reason: "empty",
            size: blob?.size ?? 0,
            chunks: chunks.length,
            message:
              "録音データが空でした。1秒以上話してから ■ 停止してください。マイク診断ページでも試せます。"
          };
          done(null);
          return;
        }

        this.lastFail = null;
        this.addTake(lineId, blob);
        done(blob);
      };

      const stopTimer = setTimeout(() => {
        if (stream) stream.getTracks().forEach((t) => t.stop());
        this.stream = null;
        finish(new Blob(chunks, { type: mime }));
      }, STOP_TIMEOUT_MS);

      rec.onstop = () => {
        if (stream) stream.getTracks().forEach((t) => t.stop());
        this.stream = null;
        finish(new Blob(chunks, { type: mime }));
      };

      try {
        if (rec.state === "recording") {
          rec.stop();
        } else {
          if (stream) stream.getTracks().forEach((t) => t.stop());
          this.stream = null;
          finish(new Blob(chunks, { type: mime }));
        }
      } catch {
        if (stream) stream.getTracks().forEach((t) => t.stop());
        this.stream = null;
        done(null);
      }
    });

    return this.stopPromise;
  }

  addTake(lineId, blob) {
    const s = this.getLineState(lineId);
    const url = URL.createObjectURL(blob);
    const edit = { ...DEFAULT_TAKE_EDIT };
    s.takes.push({
      id: newTakeId(),
      url,
      blob,
      size: blob.size,
      label: null,
      durationSec: null,
      /** @type {'candidate'|'ng'|'redo'|null} */
      status: null,
      edit: { ...edit },
      editDraft: { ...edit }
    });
    s.activeIndex = s.takes.length - 1;
    this.onTakeChange?.(lineId, s.takes.length, blob);
  }

  playTakeSync(lineId) {
    const take = this.getActiveTake(lineId);
    if (!take?.url) return Promise.reject(new Error("再生する録音がありません。"));
    const audio = this.previewAudio || new Audio(take.url);
    audio.src = take.url;
    audio.volume = 1;
    audio.currentTime = 0;
    return audio.play();
  }

  cancelRecording() {
    const rec = this.recorder;
    if (rec?.state === "recording") {
      try {
        rec.stop();
      } catch {
        /* ignore */
      }
    }
    if (this._stopResolve) {
      this._finishStopPromise(null);
    }
    this.recordingLineId = null;
    this.armedLineId = null;
    this.discardRecorder();
    this.stopStream();
  }

  release() {
    this.cancelRecording();
    for (const s of this.lineTakes.values()) {
      for (const t of s.takes) URL.revokeObjectURL(t.url);
    }
    this.lineTakes.clear();
  }
}
