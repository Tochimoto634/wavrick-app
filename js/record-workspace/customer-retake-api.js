/**
 * 顧客向け「部分リテイク」画面用 API（将来実装の契約）
 * 収録ブースの cueId / projectId と同じ ID を使うことで声優側と突き合わせ可能。
 */

import { projectIdFromRequest, RETAKE_SCHEMA_VERSION } from "./cue-retake.js?v=rw-cue-retake-2026-05-22";

/**
 * 納品時点の目安枠一覧（顧客 UI のチェックボックス用）
 * @param {string} requestId
 * @param {{ id: string, startSec: number, endSec?: number|null, text: string, rawTc?: string }[]} scriptLines
 * @param {string} [deliveryId]
 */
export function buildCueCatalogForCustomer(requestId, scriptLines, deliveryId = null) {
  const projectId = projectIdFromRequest(requestId);
  return {
    schemaVersion: RETAKE_SCHEMA_VERSION,
    projectId,
    requestId: requestId || null,
    deliveryId,
    cues: (scriptLines || []).map((line, lineIndex) => ({
      cueId: line.id,
      lineIndex,
      startSec: line.startSec,
      endSec: line.endSec ?? null,
      text: line.text,
      rawTc: line.rawTc || "",
      label: `セリフ ${lineIndex + 1}`
    }))
  };
}

/**
 * 顧客が「この枠だけ直して」を送信するときの payload
 * @param {object} opts
 * @param {string} opts.requestId
 * @param {string} [opts.deliveryId]
 * @param {{ cueId: string, note: string, cueSnapshot?: object }[]} opts.items
 * @param {string} [opts.customerEmail]
 */
export function buildCustomerPartialRetakePayload(opts) {
  const requestId = String(opts.requestId || "").trim();
  const projectId = projectIdFromRequest(requestId);
  const items = (opts.items || []).map((it) => ({
    cueId: String(it.cueId),
    note: String(it.note || "").trim(),
    cueSnapshot: it.cueSnapshot || null
  }));
  return {
    type: "partial_retake_request",
    schemaVersion: RETAKE_SCHEMA_VERSION,
    projectId,
    requestId: requestId || null,
    deliveryId: opts.deliveryId || null,
    requestedAt: new Date().toISOString(),
    requestedBy: opts.customerEmail || "customer",
    items
  };
}
