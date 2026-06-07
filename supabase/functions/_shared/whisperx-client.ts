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

function whisperxBaseUrl(): string {
  const url = (Deno.env.get("WHISPERX_SERVICE_URL") || "").trim().replace(/\/$/, "");
  if (!url) {
    throw new Error(
      "WHISPERX_SERVICE_URL が未設定です。ローカル: http://127.0.0.1:8081 / ./scripts/start-whisperx.sh"
    );
  }
  return url;
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

function whisperxAuthHeaders(): Record<string, string> {
  const secret = (
    Deno.env.get("WHISPERX_SERVICE_SECRET") ||
    Deno.env.get("PROXY_SECRET") ||
    ""
  ).trim();
  const h: Record<string, string> = {};
  if (secret) h.Authorization = `Bearer ${secret}`;
  return h;
}

export async function transcribeWithWhisperX(
  audio: Uint8Array,
  filename: string
): Promise<WhisperXResponse> {
  const base = whisperxBaseUrl();
  const form = new FormData();
  form.append("file", new Blob([audio], { type: "application/octet-stream" }), filename);

  const r = await fetch(`${base}/transcribe`, {
    method: "POST",
    headers: whisperxAuthHeaders(),
    body: form
  });

  const bodyText = await r.text();
  if (!r.ok) {
    let msg = bodyText.slice(0, 500);
    try {
      const j = JSON.parse(bodyText) as { detail?: string };
      if (typeof j.detail === "string") msg = j.detail;
    } catch {
      /* keep */
    }
    throw new Error(`WhisperX が失敗しました (${r.status}): ${msg}`);
  }

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
