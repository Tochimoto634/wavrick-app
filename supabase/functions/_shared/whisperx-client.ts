/** HTTP client for Wavrick WhisperX service */

import type { AlignWord } from "./whisperx-timeline-rules.ts";

export type WhisperXResponse = {
  source?: string;
  model?: string;
  language?: string;
  duration?: number;
  words?: AlignWord[];
  segments?: { start: number; end: number; text: string; words?: AlignWord[] }[];
  roughSegments?: { start: number; end: number; text: string }[];
  silenceGaps?: { start: number; end: number; duration?: number }[];
  build?: number;
};

function runpodWhisperxEndpointId(): string {
  return (
    Deno.env.get("RUNPOD_WHISPERX_ENDPOINT_ID") ||
    Deno.env.get("RUNPOD_ENDPOINT_ID") ||
    ""
  ).trim();
}

function whisperxBaseUrl(): string {
  const endpointId = runpodWhisperxEndpointId();
  if (endpointId) {
    return `https://${endpointId}.api.runpod.ai`;
  }
  const url = (Deno.env.get("WHISPERX_SERVICE_URL") || "").trim().replace(/\/$/, "");
  if (!url) {
    throw new Error(
      "WhisperX の接続先が未設定です。RunPod Serverless: RUNPOD_WHISPERX_ENDPOINT_ID + RUNPOD_API_KEY / Pod: WHISPERX_SERVICE_URL / ローカル: http://127.0.0.1:8081"
    );
  }
  return url;
}

export function isRunpodWhisperxMode(): boolean {
  return Boolean(runpodWhisperxEndpointId());
}

/** RunPod Queue `/run` で非同期投入（Load Balancer 直結とは別 Endpoint 想定） */
export function isRunpodAsyncMode(): boolean {
  if (!isRunpodWhisperxMode()) return false;
  const raw = (Deno.env.get("RUNPOD_WHISPERX_ASYNC") || "1").trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "no";
}

function runpodQueueApiBase(): string {
  const id = runpodWhisperxEndpointId();
  if (!id) throw new Error("RUNPOD_WHISPERX_ENDPOINT_ID が未設定です。");
  return `https://api.runpod.ai/v2/${id}`;
}

export type RunpodJobState =
  | "IN_QUEUE"
  | "IN_PROGRESS"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "TIMED_OUT";

export type RunpodJobStatus = {
  id: string;
  status: RunpodJobState | string;
  output?: WhisperXResponse;
  error?: string;
};

function runpodApiHeaders(): Record<string, string> {
  const key = (Deno.env.get("RUNPOD_API_KEY") || "").trim();
  if (!key) throw new Error("RUNPOD_API_KEY が未設定です。");
  return {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json"
  };
}

/** RunPod Queue: 非同期文字起こしを投入し RunPod job id を返す */
export async function submitRunpodTranscribeAsync(audioUrl: string): Promise<{ id: string; status: string }> {
  const r = await fetch(`${runpodQueueApiBase()}/run`, {
    method: "POST",
    headers: runpodApiHeaders(),
    body: JSON.stringify({ input: { audioUrl } })
  });
  const bodyText = await r.text();
  if (!r.ok) {
    let msg = bodyText.slice(0, 400);
    try {
      const j = JSON.parse(bodyText) as { error?: string; message?: string };
      if (typeof j.error === "string") msg = j.error;
      else if (typeof j.message === "string") msg = j.message;
    } catch {
      /* keep */
    }
    throw new Error(`RunPod 非同期投入に失敗しました (${r.status}): ${msg}`);
  }
  let data: { id?: string; status?: string };
  try {
    data = JSON.parse(bodyText) as { id?: string; status?: string };
  } catch {
    throw new Error("RunPod 非同期投入の応答が JSON ではありません。");
  }
  const id = String(data.id || "").trim();
  if (!id) throw new Error("RunPod が job id を返しませんでした。");
  return { id, status: String(data.status || "IN_QUEUE") };
}

/** RunPod Queue: ジョブ状態を取得（完了時 output に WhisperX 結果） */
export async function getRunpodTranscribeStatus(runpodJobId: string): Promise<RunpodJobStatus> {
  const id = runpodJobId.trim();
  if (!id) throw new Error("runpodJobId が空です。");
  const r = await fetch(`${runpodQueueApiBase()}/status/${encodeURIComponent(id)}`, {
    method: "GET",
    headers: runpodApiHeaders()
  });
  const bodyText = await r.text();
  if (!r.ok) {
    let msg = bodyText.slice(0, 400);
    try {
      const j = JSON.parse(bodyText) as { error?: string; message?: string };
      if (typeof j.error === "string") msg = j.error;
      else if (typeof j.message === "string") msg = j.message;
    } catch {
      /* keep */
    }
    throw new Error(`RunPod ステータス取得に失敗しました (${r.status}): ${msg}`);
  }
  let data: RunpodJobStatus;
  try {
    data = JSON.parse(bodyText) as RunpodJobStatus;
  } catch {
    throw new Error("RunPod ステータス応答が JSON ではありません。");
  }
  if (!data.id) data.id = id;
  return data;
}

/** Edge Function のメモリ節約: RunPod に https URL を渡して直接取得させる */
export function canPassthroughAudioUrlToWhisperx(url: string): boolean {
  if (!isRunpodWhisperxMode()) return false;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host.endsWith(".local")) return false;
    return true;
  } catch {
    return false;
  }
}

const AUDIO_EXTS = new Set(["wav", "mp3", "m4a", "webm", "ogg", "flac", "opus", "aac"]);

/** multipart filename — must match actual bytes (proxy returns mp3, not m4a). */
export function guessWhisperUploadFilename(
  data: Uint8Array,
  opts?: { contentType?: string | null; url?: string | null }
): string {
  const ct = (opts?.contentType || "").split(";")[0].trim().toLowerCase();
  const mimeMap: Record<string, string> = {
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/mp4": "m4a",
    "audio/x-m4a": "m4a",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/webm": "webm",
    "audio/ogg": "ogg",
    "audio/flac": "flac"
  };
  if (ct && mimeMap[ct]) return `audio.${mimeMap[ct]}`;

  const url = (opts?.url || "").trim();
  if (url) {
    try {
      let ext = new URL(url).pathname.split(".").pop()?.toLowerCase() || "";
      if (ext === "mp4") ext = "m4a";
      if (AUDIO_EXTS.has(ext)) return `audio.${ext}`;
    } catch {
      /* keep */
    }
  }

  if (data.byteLength >= 12) {
    const riff = String.fromCharCode(...data.slice(0, 4));
    const wave = String.fromCharCode(...data.slice(8, 12));
    if (riff === "RIFF" && wave === "WAVE") return "audio.wav";
  }
  if (data.byteLength >= 3) {
    const id3 = String.fromCharCode(...data.slice(0, 3));
    if (id3 === "ID3" || (data[0] === 0xff && (data[1] & 0xe0) === 0xe0)) return "audio.mp3";
  }
  if (data.byteLength >= 8) {
    const ftyp = String.fromCharCode(...data.slice(4, 8));
    if (ftyp === "ftyp") return "audio.m4a";
  }
  if (data.byteLength >= 4 && data[0] === 0x1a && data[1] === 0x45) return "audio.webm";
  return "audio.mp3";
}

function whisperxAuthHeaders(json = false): Record<string, string> {
  const h: Record<string, string> = {};
  if (json) h["Content-Type"] = "application/json";
  const runpodKey = (Deno.env.get("RUNPOD_API_KEY") || "").trim();
  if (runpodKey) {
    h.Authorization = `Bearer ${runpodKey}`;
    return h;
  }
  const secret = (
    Deno.env.get("WHISPERX_SERVICE_SECRET") ||
    Deno.env.get("PROXY_SECRET") ||
    ""
  ).trim();
  if (secret) h.Authorization = `Bearer ${secret}`;
  return h;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientWhisperxStatus(status: number, msg: string): boolean {
  return status === 430 || status === 502 || status === 503 || status === 504 ||
    /Bad gateway|No Workers Available|no workers available|runpod\.ai/i.test(msg);
}

async function waitForRunpodHealthy(base: string, headers: Record<string, string>): Promise<void> {
  const maxAttempts = 10;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const r = await fetch(`${base}/ping`, { headers });
      if (r.status === 204) {
        /* モデルロード中 */
      } else if (r.ok) {
        try {
          const j = await r.json() as { status?: string };
          if (j.status === "healthy") return;
        } catch {
          return;
        }
      } else if (!isTransientWhisperxStatus(r.status, await r.text())) {
        return;
      }
    } catch {
      /* retry */
    }
    if (i < maxAttempts - 1) await sleep(8000);
  }
}

function parseWhisperxError(status: number, bodyText: string): string {
  let msg = bodyText.slice(0, 500);
  try {
    const j = JSON.parse(bodyText) as { detail?: string; title?: string };
    if (typeof j.detail === "string") msg = j.detail;
    else if (typeof j.title === "string") msg = j.title;
  } catch {
    /* keep */
  }
  if (isTransientWhisperxStatus(status, msg)) {
    return (
      `WhisperX が失敗しました (${status}): RunPod GPU ワーカーが起動中か一時的に応答していません。` +
      "1〜3分待ってから再試行してください（TCP URL の設定は不要です。RUNPOD_API_KEY + RUNPOD_WHISPERX_ENDPOINT_ID のみ）。"
    );
  }
  return `WhisperX が失敗しました (${status}): ${msg}`;
}

function parseWhisperxResponse(bodyText: string): WhisperXResponse {
  let data: WhisperXResponse;
  try {
    data = JSON.parse(bodyText) as WhisperXResponse;
  } catch {
    throw new Error("WhisperX の応答が JSON ではありません。");
  }
  const words = Array.isArray(data.words) ? data.words : [];
  const segments = Array.isArray(data.segments) ? data.segments : [];
  if (!words.length && !segments.length) {
    throw new Error("WhisperX の結果が空でした（words / segments なし）。");
  }
  return data;
}

async function postTranscribe(
  init: { method: "POST"; headers: Record<string, string>; body: BodyInit }
): Promise<WhisperXResponse> {
  const base = whisperxBaseUrl();
  const headers = { ...whisperxAuthHeaders(), ...init.headers };
  if (isRunpodWhisperxMode()) {
    await waitForRunpodHealthy(base, headers);
  }

  const maxAttempts = isRunpodWhisperxMode() ? 4 : 1;
  let lastErr = "WhisperX リクエストが失敗しました。";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (isRunpodWhisperxMode() && attempt > 1) {
      await waitForRunpodHealthy(base, headers);
    }
    const r = await fetch(`${base}/transcribe`, {
      method: "POST",
      headers,
      body: init.body
    });
    const bodyText = await r.text();
    if (r.ok) return parseWhisperxResponse(bodyText);

    lastErr = parseWhisperxError(r.status, bodyText);
    if (attempt < maxAttempts && isTransientWhisperxStatus(r.status, bodyText)) {
      await sleep(12000);
      continue;
    }
    throw new Error(lastErr);
  }

  throw new Error(lastErr);
}

export async function transcribeWithWhisperXFromUrl(audioUrl: string): Promise<WhisperXResponse> {
  return postTranscribe({
    method: "POST",
    headers: whisperxAuthHeaders(true),
    body: JSON.stringify({ audioUrl })
  });
}

export async function transcribeWithWhisperX(
  audio: Uint8Array,
  filename: string
): Promise<WhisperXResponse> {
  const form = new FormData();
  form.append("file", new Blob([audio], { type: "application/octet-stream" }), filename);
  return postTranscribe({
    method: "POST",
    headers: {},
    body: form
  });
}
