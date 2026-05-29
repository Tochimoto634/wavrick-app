/**
 * 部分リテイク — 顧客が指定した「目安枠（Cue）」単位の差し戻しデータモデル
 *
 * ID の役割:
 * - projectId … 1案件（依頼 requestId と紐づく）
 * - cueId … 台本の目安枠（script line.id と同一。タイムコード+文言から安定生成）
 * - retakeRequestId … 顧客が出した1件の修正依頼（枠ごと・ラウンドごと）
 * - deliveryId … 顧客が聴いた納品物（将来: 通し WAV / 案件バージョン）
 */

export const RETAKE_SCHEMA_VERSION = 1;

/** @typedef {'pending'|'in_progress'|'submitted'|'accepted'|'cancelled'} RetakeStatus */

export const RETAKE_STATUS = {
  PENDING: "pending",
  IN_PROGRESS: "in_progress",
  SUBMITTED: "submitted",
  ACCEPTED: "accepted",
  CANCELLED: "cancelled"
};

const STORAGE_PREFIX = "wavrick_rw_retake_batch:";

export function newRetakeRequestId() {
  return `rr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function newRetakeBatchId() {
  return `rb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 依頼 ID から収録プロジェクト ID を決定（顧客・声優で共通）
 * @param {string|null|undefined} requestId
 */
export function projectIdFromRequest(requestId) {
  const rid = String(requestId || "").trim();
  return rid ? `req:${rid}` : "rw-local";
}

/**
 * @param {{ id: string, startSec: number, endSec?: number|null, text: string, rawTc?: string }} line
 * @param {number} lineIndex
 * @returns {import('./cue-retake.js').CueSnapshot}
 */
export function cueSnapshotFromLine(line, lineIndex) {
  return {
    cueId: line.id,
    lineIndex,
    startSec: line.startSec,
    endSec: line.endSec ?? null,
    text: line.text,
    rawTc: line.rawTc || ""
  };
}

/**
 * @param {string} projectId
 * @param {{ requestId?: string|null, deliveryId?: string|null }} [opts]
 */
export function createEmptyRetakeBatch(projectId, opts = {}) {
  const now = new Date().toISOString();
  return {
    schemaVersion: RETAKE_SCHEMA_VERSION,
    batchId: newRetakeBatchId(),
    projectId,
    requestId: opts.requestId ?? null,
    deliveryId: opts.deliveryId ?? null,
    createdAt: now,
    updatedAt: now,
    items: []
  };
}

/**
 * 顧客側が送る部分リテイク依頼（将来 API の body）
 * @typedef {object} CustomerRetakeItemInput
 * @property {string} cueId
 * @property {string} [note]
 * @property {CueSnapshot} [cueSnapshot]
 */

/**
 * @typedef {object} CueSnapshot
 * @property {string} cueId
 * @property {number} lineIndex
 * @property {number} startSec
 * @property {number|null} endSec
 * @property {string} text
 * @property {string} rawTc
 */

/**
 * @typedef {object} CueRetakeRequest
 * @property {string} retakeRequestId
 * @property {string} cueId
 * @property {CueSnapshot} cueSnapshot
 * @property {string} note
 * @property {RetakeStatus} status
 * @property {string} requestedAt
 * @property {string} requestedBy
 * @property {string|null} submittedAt
 * @property {string|null} submittedTakeId
 * @property {number|null} submittedTakeIndex
 */

/**
 * @typedef {object} CueRetakeBatch
 * @property {number} schemaVersion
 * @property {string} batchId
 * @property {string} projectId
 * @property {string|null} requestId
 * @property {string|null} deliveryId
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {CueRetakeRequest[]} items
 */

/**
 * @param {CueRetakeBatch|null|undefined} raw
 * @returns {CueRetakeBatch|null}
 */
export function normalizeRetakeBatch(raw) {
  if (!raw || typeof raw !== "object") return null;
  const items = Array.isArray(raw.items) ? raw.items : [];
  return {
    schemaVersion: RETAKE_SCHEMA_VERSION,
    batchId: String(raw.batchId || newRetakeBatchId()),
    projectId: String(raw.projectId || "rw-local"),
    requestId: raw.requestId != null ? String(raw.requestId) : null,
    deliveryId: raw.deliveryId != null ? String(raw.deliveryId) : null,
    createdAt: String(raw.createdAt || new Date().toISOString()),
    updatedAt: String(raw.updatedAt || new Date().toISOString()),
    items: items
      .filter((it) => it && it.cueId)
      .map((it) => ({
        retakeRequestId: String(it.retakeRequestId || newRetakeRequestId()),
        cueId: String(it.cueId),
        cueSnapshot: {
          cueId: String(it.cueSnapshot?.cueId || it.cueId),
          lineIndex: Number(it.cueSnapshot?.lineIndex) || 0,
          startSec: Number(it.cueSnapshot?.startSec) || 0,
          endSec:
            it.cueSnapshot?.endSec != null ? Number(it.cueSnapshot.endSec) : null,
          text: String(it.cueSnapshot?.text || ""),
          rawTc: String(it.cueSnapshot?.rawTc || "")
        },
        note: String(it.note || "").trim(),
        status: normalizeStatus(it.status),
        requestedAt: String(it.requestedAt || new Date().toISOString()),
        requestedBy: String(it.requestedBy || "customer"),
        submittedAt: it.submittedAt ? String(it.submittedAt) : null,
        submittedTakeId: it.submittedTakeId ? String(it.submittedTakeId) : null,
        submittedTakeIndex:
          it.submittedTakeIndex != null ? Number(it.submittedTakeIndex) : null
      }))
  };
}

/** @param {string} s */
function normalizeStatus(s) {
  const v = String(s || "").toLowerCase();
  if (Object.values(RETAKE_STATUS).includes(v)) return /** @type {RetakeStatus} */ (v);
  return RETAKE_STATUS.PENDING;
}

export class CueRetakeStore {
  /**
   * @param {string} projectId
   * @param {{ requestId?: string|null, deliveryId?: string|null, batch?: CueRetakeBatch|null }} [opts]
   */
  constructor(projectId, opts = {}) {
    this.projectId = projectId;
    const existing = opts.batch ? normalizeRetakeBatch(opts.batch) : null;
    this.batch =
      existing && existing.projectId === projectId
        ? existing
        : createEmptyRetakeBatch(projectId, {
            requestId: opts.requestId,
            deliveryId: opts.deliveryId
          });
    if (opts.requestId && !this.batch.requestId) this.batch.requestId = opts.requestId;
  }

  static loadLocal(projectId) {
    try {
      const raw = localStorage.getItem(STORAGE_PREFIX + projectId);
      if (!raw) return null;
      return normalizeRetakeBatch(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  static createForProject(projectId, opts = {}) {
    const saved = CueRetakeStore.loadLocal(projectId);
    return new CueRetakeStore(projectId, { ...opts, batch: saved });
  }

  persistLocal() {
    try {
      this.batch.updatedAt = new Date().toISOString();
      localStorage.setItem(
        STORAGE_PREFIX + this.projectId,
        JSON.stringify(this.batch)
      );
      return true;
    } catch {
      return false;
    }
  }

  toJSON() {
    return { ...this.batch, updatedAt: new Date().toISOString() };
  }

  loadBatch(batch) {
    const n = normalizeRetakeBatch(batch);
    if (n && n.projectId === this.projectId) this.batch = n;
  }

  /**
   * 顧客が複数枠を指定して差し戻し（既存 pending は上書きしない）
   * @param {CustomerRetakeItemInput[]} inputs
   * @param {{ requestedBy?: string, deliveryId?: string }} [opts]
   */
  ingestCustomerRequests(inputs, opts = {}) {
    const requestedBy = opts.requestedBy || "customer";
    if (opts.deliveryId) this.batch.deliveryId = opts.deliveryId;
    let added = 0;
    for (const input of inputs || []) {
      const cueId = String(input.cueId || "").trim();
      if (!cueId) continue;
      const open = this.batch.items.find(
        (it) =>
          it.cueId === cueId &&
          (it.status === RETAKE_STATUS.PENDING ||
            it.status === RETAKE_STATUS.IN_PROGRESS)
      );
      if (open) continue;
      const snap = input.cueSnapshot || {
        cueId,
        lineIndex: 0,
        startSec: 0,
        endSec: null,
        text: "",
        rawTc: ""
      };
      this.batch.items.push({
        retakeRequestId: newRetakeRequestId(),
        cueId,
        cueSnapshot: { ...snap, cueId },
        note: String(input.note || "").trim(),
        status: RETAKE_STATUS.PENDING,
        requestedAt: new Date().toISOString(),
        requestedBy,
        submittedAt: null,
        submittedTakeId: null,
        submittedTakeIndex: null
      });
      added++;
    }
    this.batch.updatedAt = new Date().toISOString();
    return added;
  }

  /** @returns {CueRetakeRequest[]} */
  getOpenRequests() {
    return this.batch.items.filter(
      (it) =>
        it.status === RETAKE_STATUS.PENDING ||
        it.status === RETAKE_STATUS.IN_PROGRESS
    );
  }

  getPendingCount() {
    return this.getOpenRequests().length;
  }

  /** @returns {Set<string>} */
  getPendingCueIds() {
    return new Set(this.getOpenRequests().map((it) => it.cueId));
  }

  /** @param {string} cueId */
  isCueNeedsRetake(cueId) {
    return this.getOpenRequests().some((it) => it.cueId === cueId);
  }

  /** @param {string} cueId */
  getActiveRequestForCue(cueId) {
    return (
      this.batch.items.find(
        (it) =>
          it.cueId === cueId &&
          (it.status === RETAKE_STATUS.PENDING ||
            it.status === RETAKE_STATUS.IN_PROGRESS)
      ) || null
    );
  }

  /** @param {string} cueId */
  markCueInProgress(cueId) {
    const req = this.getActiveRequestForCue(cueId);
    if (req && req.status === RETAKE_STATUS.PENDING) {
      req.status = RETAKE_STATUS.IN_PROGRESS;
      this.batch.updatedAt = new Date().toISOString();
    }
  }

  /**
   * @param {string} cueId
   * @param {{ takeId: string, takeIndex: number }} submission
   */
  markCueSubmitted(cueId, submission) {
    const req = this.getActiveRequestForCue(cueId);
    if (!req) return false;
    req.status = RETAKE_STATUS.SUBMITTED;
    req.submittedAt = new Date().toISOString();
    req.submittedTakeId = submission.takeId;
    req.submittedTakeIndex = submission.takeIndex;
    this.batch.updatedAt = new Date().toISOString();
    return true;
  }

  /** 次に手を付けるべき cueId（未収録 or 要修正優先） */
  findNextOpenCueId(scriptLines, lineRecorder) {
    const open = this.getOpenRequests();
    for (const req of open) {
      const line = scriptLines.find((l) => l.id === req.cueId);
      if (!line) continue;
      if (!lineRecorder?.hasRecording?.(line.id)) return line.id;
    }
    return open[0]?.cueId ?? null;
  }
}
