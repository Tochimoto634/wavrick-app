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
