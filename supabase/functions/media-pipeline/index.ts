import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  buildScriptsBySpeakerFromWhisperTimeline,
  GROK_TRANSLATE_LINES_SYSTEM,
  mergeTranslationsIntoWhisperTimeline,
  normalizeWhisperSegsForGrok,
  speakerAssignmentsToPlainText,
  whisperSegmentsToBracketTimelineText
} from "../_shared/grok-timecode-prompt.ts";
import {
  appendTranscribeBuildMarker,
  WAVRICK_TRANSCRIBE_BUILD
} from "../_shared/transcribe-build.ts";
import { transcribeWithWhisperX } from "../_shared/whisperx-client.ts";
import {
  buildBracketTimelineFromWhisperX,
  buildTimelineCuesFromWhisperX,
  normalizeAlignWords,
  timelineCuesToLegacySegments,
  type LegacyWhisperSegment,
  type SilenceGap,
  type WhisperSeg
} from "../_shared/whisperx-timeline-rules.ts";

const MAX_WHISPER_BYTES = 24 * 1024 * 1024;
const GROK_MODEL = Deno.env.get("GROK_MODEL") || "grok-4.3";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

type SpeakerInput = {
  id: number;
  label?: string;
  lines: string[];
};

type PipelineBody = {
  /** transcribe = Whisperのみ / script = 話者分け後にGrok / full = 従来の一括 */
  mode?: "transcribe" | "script" | "full";
  videoUrl?: string;
  audioUrl?: string;
  requestId?: string;
  speakerCount?: number;
  speakers?: SpeakerInput[];
  tone?: string;
  /** フロントで保持している Whisper セグメント（Grok へそのまま渡す） */
  whisperSegments?: WhisperSeg[];
  whisperDurationSec?: number;
  /** 文字起こし時のブラケット台本（Grok へそのまま・時刻の正） */
  whisperTimeline?: string;
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" }
  });
}

function extractYouTubeVideoId(raw: string): string | null {
  try {
    const u = new URL(raw.trim().startsWith("http") ? raw.trim() : `https://${raw.trim()}`);
    const host = (u.hostname || "").replace(/^www\./, "").toLowerCase();
    if (host === "youtu.be") {
      const id = u.pathname.replace(/^\//, "").split("/")[0] || "";
      return /^[\w-]{11}$/.test(id) ? id : null;
    }
    if (
      host === "youtube.com" ||
      host === "m.youtube.com" ||
      host === "music.youtube.com" ||
      host === "youtube-nocookie.com"
    ) {
      if (u.pathname === "/watch") {
        const v = u.searchParams.get("v");
        return v && /^[\w-]{11}$/.test(v) ? v : null;
      }
      const shorts = u.pathname.match(/^\/shorts\/([\w-]{11})/);
      if (shorts?.[1]) return shorts[1];
      const embed = u.pathname.match(/^\/embed\/([\w-]{11})/);
      if (embed?.[1]) return embed[1];
      const live = u.pathname.match(/^\/live\/([\w-]{11})/);
      if (live?.[1]) return live[1];
    }
    return null;
  } catch {
    return null;
  }
}

async function resolveUserId(req: Request): Promise<string | null> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const jwt = authHeader.slice(7).trim();
  if (!jwt) return null;
  const url = Deno.env.get("SUPABASE_URL");
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !anon) return null;
  const sb = createClient(url, anon, {
    global: { headers: { Authorization: `Bearer ${jwt}` } }
  });
  const { data, error } = await sb.auth.getUser(jwt);
  if (error || !data?.user?.id) return null;
  return data.user.id;
}

async function fetchAudioFromProxy(videoUrl: string, vocalSeparate = true): Promise<{ buf: Uint8Array; vocalSeparated: boolean }> {
  const proxyUrl = Deno.env.get("YOUTUBE_AUDIO_PROXY_URL");
  if (!proxyUrl) {
    throw new Error(
      "YOUTUBE_AUDIO_PROXY_URL が未設定です。services/youtube-audio-proxy をデプロイするか、body.audioUrl で音声URLを渡してください。"
    );
  }
  const secret = Deno.env.get("YOUTUBE_AUDIO_PROXY_SECRET");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret) headers.Authorization = `Bearer ${secret}`;
  let r: Response;
  try {
    r = await fetch(proxyUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ videoUrl, vocalSeparate })
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/dns|lookup|trycloudflare|Name or service not known/i.test(msg)) {
      throw new Error(
        "YouTube音声プロキシに接続できません。YOUTUBE_AUDIO_PROXY_URL が正しくありません。"
      );
    }
    throw new Error(`音声プロキシへの接続に失敗しました: ${msg}`);
  }
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`音声プロキシが失敗しました (${r.status}): ${t.slice(0, 500)}`);
  }
  const buf = new Uint8Array(await r.arrayBuffer());
  if (buf.byteLength > MAX_WHISPER_BYTES) {
    throw new Error(`音声が大きすぎます（${buf.byteLength} bytes）。Whisper API 上限（約25MB）以内にしてください。`);
  }
  if (buf.byteLength < 256) {
    throw new Error("音声データが短すぎるか空です。");
  }
  const vocalSeparated = r.headers.get("X-Wavrick-Vocal-Separated") === "1";
  return { buf, vocalSeparated };
}

async function uploadAudioToStorage(
  admin: ReturnType<typeof createClient>,
  userId: string,
  videoId: string,
  buf: Uint8Array,
  suffix: "raw" | "cleaned"
): Promise<string> {
  const path = `${userId}/${videoId}_${suffix}.mp3`;
  const { error } = await admin.storage
    .from("customer-uploads")
    .upload(path, buf, { contentType: "audio/mpeg", upsert: true });
  if (error) throw new Error(`Storage upload failed (${suffix}): ${error.message}`);
  const { data } = admin.storage.from("customer-uploads").getPublicUrl(path);
  return data.publicUrl;
}

async function fetchAudioFromUrl(audioUrl: string): Promise<Uint8Array> {
  let parsed: URL;
  try {
    parsed = new URL(audioUrl);
  } catch {
    throw new Error("audioUrl が不正です。");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("audioUrl は https のみ対応です。");
  }
  const host = parsed.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "0.0.0.0" ||
    host.endsWith(".local") ||
    host === "metadata.google.internal"
  ) {
    throw new Error("この audioUrl ホストは SSRF 防止のためブロックされています。");
  }

  const r = await fetch(audioUrl, { redirect: "follow" });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`audioUrl の取得に失敗しました (${r.status}): ${t.slice(0, 300)}`);
  }
  const len = r.headers.get("content-length");
  if (len && Number(len) > MAX_WHISPER_BYTES) {
    throw new Error("Content-Length が Whisper の上限を超えています。");
  }
  const buf = new Uint8Array(await r.arrayBuffer());
  if (buf.byteLength > MAX_WHISPER_BYTES) {
    throw new Error(`音声が大きすぎます（${buf.byteLength} bytes）。`);
  }
  return buf;
}

function extractWhisperSegments(raw: unknown): { start: number; end: number; text: string }[] {
  const segments = Array.isArray((raw as { segments?: unknown[] })?.segments)
    ? (raw as { segments: unknown[] }).segments
    : [];
  const out: { start: number; end: number; text: string }[] = [];
  for (const row of segments) {
    const s = row as Record<string, unknown>;
    const text = typeof s.text === "string" ? s.text.trim() : "";
    if (!text) continue;
    const start = Number(s.start) || 0;
    const end = Number(s.end) || 0;
    if (end <= start) continue;
    out.push({ start, end, text });
  }
  return out;
}

/** Whisper verbose_json の duration（実音声長）を優先 */
function whisperAudioDurationSec(
  raw: unknown,
  segments: { start: number; end: number; text: string }[]
): number {
  const fromApi = Number((raw as { duration?: number })?.duration);
  if (Number.isFinite(fromApi) && fromApi > 0) return fromApi;
  if (!segments.length) return 0;
  return segments.reduce((m, s) => Math.max(m, s.end), 0);
}

function clampWhisperSegmentsToDuration(
  segments: { start: number; end: number; text: string }[],
  maxSec: number
): { start: number; end: number; text: string }[] {
  if (!(maxSec > 0) || !segments.length) return segments;
  return segments
    .map((s) => ({
      start: Math.max(0, Math.min(s.start, maxSec - 0.05)),
      end: Math.max(s.start + 0.05, Math.min(s.end, maxSec)),
      text: s.text
    }))
    .filter((s) => s.start < maxSec - 0.02 && s.end > s.start);
}

type TranscribeResult = {
  text: string;
  raw: Record<string, unknown>;
  whisperTimeline: string;
  segments: LegacyWhisperSegment[];
  durationSec: number;
  language?: string;
  whisperxBuild: number | null;
  silenceGapCount: number;
};

async function transcribeWhisperX(
  audio: Uint8Array,
  filename: string
): Promise<TranscribeResult> {
  const wx = await transcribeWithWhisperX(audio, filename);
  const words = normalizeAlignWords(wx.words);
  const durationSec =
    Number(wx.duration) > 0
      ? Number(wx.duration)
      : words.length
        ? Math.max(...words.map((w) => w.end))
        : 0;

  const wxSegments: WhisperSeg[] = Array.isArray(wx.segments)
    ? wx.segments
        .map((s) => ({
          start: Number(s.start) || 0,
          end: Number(s.end) || 0,
          text: String(s.text || "").trim()
        }))
        .filter((s) => s.text)
    : [];

  const silenceGaps: SilenceGap[] = Array.isArray(wx.silenceGaps) ? wx.silenceGaps : [];
  const roughSegments: WhisperSeg[] = Array.isArray(wx.roughSegments)
    ? wx.roughSegments
        .map((s) => ({
          start: Number(s.start) || 0,
          end: Number(s.end) || 0,
          text: String(s.text || "").trim()
        }))
        .filter((s) => s.text)
    : [];

  const cues = buildTimelineCuesFromWhisperX(
    words,
    wxSegments,
    durationSec,
    silenceGaps,
    roughSegments
  );
  const segments = timelineCuesToLegacySegments(cues);
  const whisperTimeline = buildBracketTimelineFromWhisperX(
    words,
    wxSegments,
    durationSec,
    silenceGaps,
    roughSegments
  );
  const text =
    segments.map((s) => s.text).join(" ").trim() ||
    (Array.isArray(wx.segments)
      ? wx.segments.map((s) => String(s.text || "").trim()).filter(Boolean).join(" ")
      : "");
  if (!text) throw new Error("WhisperX の結果が空でした。");

  const raw: Record<string, unknown> = {
    source: "whisperx",
    model: wx.model ?? null,
    language: wx.language ?? null,
    duration: durationSec,
    text,
    words: wx.words ?? [],
    segments: wx.segments ?? [],
    timelineSegments: segments,
    whisperTimeline
  };

  return {
    text,
    raw,
    whisperTimeline,
    segments,
    durationSec,
    language: typeof wx.language === "string" ? wx.language : undefined,
    whisperxBuild: typeof wx.build === "number" ? wx.build : null,
    silenceGapCount: silenceGaps.length
  };
}

async function callGrokJson<T>(system: string, userText: string): Promise<T> {
  const key = Deno.env.get("XAI_API_KEY");
  if (!key) throw new Error("XAI_API_KEY が未設定です（Grok / xAI）。");

  const r = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: GROK_MODEL,
      temperature: 0.25,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userText }
      ]
    })
  });
  const raw = await r.json();
  if (!r.ok) {
    const msg =
      typeof raw?.error === "string"
        ? raw.error
        : typeof raw?.error?.message === "string"
          ? raw.error.message
          : JSON.stringify(raw).slice(0, 400);
    throw new Error(msg);
  }
  const content = raw?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("Grok の応答形式が不正です。");
  try {
    const cleaned = content.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
    return JSON.parse(cleaned) as T;
  } catch {
    throw new Error(`Grok の JSON 解析に失敗しました: ${content.slice(0, 400)}`);
  }
}

const GROK_JSON_OUTPUT_RULES = [
  "応答は有効な JSON のみ（説明文・コードフェンス禁止）。",
  'lines は入力と同じ行数の配列。各要素は吹替セリフ本文のみ（タイムコード [ ] を含めない）。',
  "行の追加・削除・順序変更は禁止。"
].join("\n");

function resolveWhisperTimeline(
  body: PipelineBody,
  segments: WhisperSeg[],
  durationSec: number
): string {
  const fromBody = typeof body.whisperTimeline === "string" ? body.whisperTimeline.trim() : "";
  if (fromBody) return fromBody.replace(/\n?\[Wavrick-\d+\]\s*$/i, "").trim();
  return whisperSegmentsToBracketTimelineText(segments, durationSec);
}

async function translateWhisperTimelineWithGrok(
  whisperTimeline: string,
  extraUserHint = ""
): Promise<{ translation: string; lines: string[]; script: string }> {
  const userText = [
    "【WhisperX タイムコード付き書き起こし（行数・順序厳守）】",
    "各行のセリフを日本語吹替にしてください。タイムコードは出力しないでください。",
    "",
    whisperTimeline,
    extraUserHint ? `\n${extraUserHint}` : ""
  ]
    .filter(Boolean)
    .join("\n");

  const system = [
    GROK_TRANSLATE_LINES_SYSTEM,
    "",
    "次の JSON のみを返してください:",
    '{"translation":"参考訳（短くてよい）","lines":["1行目の吹替のみ","2行目…"]}',
    GROK_JSON_OUTPUT_RULES
  ].join("\n");

  const parsed = await callGrokJson<{ translation?: string; lines?: string[] }>(
    system,
    userText
  );
  const lines = Array.isArray(parsed.lines)
    ? parsed.lines.map((l) => String(l ?? "").trim())
    : [];
  const script = mergeTranslationsIntoWhisperTimeline(whisperTimeline, lines);
  const translation = typeof parsed.translation === "string" ? parsed.translation : "";
  return { translation, lines, script };
}

/**
 * Whisper タイムスタンプ付きセグメントを Grok に渡し、タイムコード付き吹替台本を生成
 */
async function translateAndScriptWithGrok(
  whisperSegments: WhisperSeg[],
  durationSec = 0,
  whisperTimelineFromBody = ""
): Promise<{ translation: string; script: string }> {
  if (!whisperSegments.length) {
    throw new Error("whisperSegments が空です。");
  }

  const whisperTimeline =
    whisperTimelineFromBody.trim() ||
    whisperSegmentsToBracketTimelineText(whisperSegments, durationSec);
  const { translation, script } = await translateWhisperTimelineWithGrok(whisperTimeline);
  if (!script) throw new Error("吹替台本の組み立てに失敗しました。");
  return { translation, script };
}

function normalizeSpeakers(body: PipelineBody): SpeakerInput[] {
  const raw = Array.isArray(body.speakers) ? body.speakers : [];
  const out: SpeakerInput[] = [];
  for (const s of raw) {
    const id = Number(s?.id);
    if (!Number.isFinite(id) || id < 1) continue;
    const lines = Array.isArray(s.lines)
      ? s.lines.map((l) => String(l || "").trim()).filter(Boolean)
      : [];
    if (!lines.length) continue;
    const label = typeof s.label === "string" && s.label.trim() ? s.label.trim() : `話者${id}`;
    out.push({ id, label, lines });
  }
  out.sort((a, b) => a.id - b.id);
  return out;
}

async function scriptBySpeakersWithGrok(params: {
  whisperSegments: WhisperSeg[];
  speakers: SpeakerInput[];
  tone?: string;
  durationSec?: number;
  whisperTimeline?: string;
}): Promise<{ scriptsBySpeaker: Record<string, string>; referenceTranslation: string }> {
  if (!params.whisperSegments.length) {
    throw new Error("whisperSegments が空です。");
  }

  const toneHint = (params.tone || "").trim() ? `希望トーン: ${params.tone.trim()}` : "";
  const dur = Number(params.durationSec) > 0 ? Number(params.durationSec) : 0;
  const whisperTimeline =
    params.whisperTimeline?.trim() ||
    whisperSegmentsToBracketTimelineText(params.whisperSegments, dur);

  const speakerPlain = speakerAssignmentsToPlainText(
    params.speakers.map((s) => ({
      id: s.id,
      label: (s.label && String(s.label).trim()) || `話者${s.id}`,
      lines: s.lines
    }))
  );

  const { translation: referenceTranslation, lines, script: mergedScript } =
    await translateWhisperTimelineWithGrok(
      whisperTimeline,
      [speakerPlain, toneHint].filter(Boolean).join("\n")
    );

  let scriptsBySpeaker = buildScriptsBySpeakerFromWhisperTimeline(
    whisperTimeline,
    params.speakers.map((s) => ({ id: s.id, lines: s.lines })),
    lines
  );

  if (params.speakers.length === 1) {
    const key = String(params.speakers[0].id);
    if (!scriptsBySpeaker[key]?.trim()) {
      scriptsBySpeaker = { [key]: mergedScript };
    }
  }

  if (!Object.keys(scriptsBySpeaker).some((k) => scriptsBySpeaker[k]?.trim())) {
    throw new Error("話者別台本の組み立てに失敗しました。");
  }

  return { scriptsBySpeaker, referenceTranslation };
}

function buildTrainingBundle(params: {
  videoUrl: string;
  transcriptLen: number;
  audioSource: string;
  whisperLanguage?: string;
  segmentCount: number;
}) {
  return {
    schemaVersion: 1,
    videoUrl: params.videoUrl,
    audioSource: params.audioSource,
    metrics: {
      transcriptChars: params.transcriptLen,
      whisperLanguage: params.whisperLanguage ?? null,
      whisperSegmentCount: params.segmentCount,
      recordedAt: new Date().toISOString()
    },
    notes:
      "将来の品質改善用に保持。個人情報・著作権に配慮し、公開・学習利用の可否は別途ポリシーで管理してください。"
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "Method not allowed" }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    return jsonResponse({ ok: false, error: "Supabase サーバー環境変数が不足しています。" }, 500);
  }

  let body: PipelineBody;
  try {
    body = (await req.json()) as PipelineBody;
  } catch {
    return jsonResponse({ ok: false, error: "JSON body が不正です。" }, 400);
  }

  const mode = body.mode === "transcribe" || body.mode === "script" || body.mode === "full" ? body.mode : "full";
  const videoUrl = (body.videoUrl || "").trim();
  const audioUrl = (body.audioUrl || "").trim();
  const requestId = (body.requestId || "").trim() || null;

  const userId = await resolveUserId(req);
  const admin = createClient(supabaseUrl, serviceKey);
  const started = Date.now();

  if (mode === "script") {
    const speakers = normalizeSpeakers(body);
    if (!speakers.length) {
      return jsonResponse(
        { ok: false, error: "speakers に、話者 id と lines（1行以上）が必要です。" },
        400
      );
    }

    const whisperSegments = normalizeWhisperSegsForGrok(body.whisperSegments);
    if (!whisperSegments.length) {
      return jsonResponse(
        {
          ok: false,
          error:
            "whisperSegments が必要です。先に「文字起こし（WhisperX）」を実行し、タイムスタンプ付きデータを取得してから台本生成してください。"
        },
        400
      );
    }

    const { data: inserted, error: insErr } = await admin
      .from("media_pipeline_jobs")
      .insert({
        user_id: userId,
        request_id: requestId,
        video_url: videoUrl || null,
        audio_url: null,
        audio_source: "speaker_script",
        status: "running",
        step: "grok"
      })
      .select("id")
      .single();

    if (insErr || !inserted?.id) {
      return jsonResponse({ ok: false, error: insErr?.message || "ジョブの作成に失敗しました。" }, 500);
    }
    const jobId = inserted.id as string;

    try {
      const scriptDur =
        Number(body.whisperDurationSec) > 0
          ? Number(body.whisperDurationSec)
          : whisperAudioDurationSec(null, whisperSegments);
      const whisperTimeline = resolveWhisperTimeline(body, whisperSegments, scriptDur);
      const grok = await scriptBySpeakersWithGrok({
        whisperSegments,
        speakers,
        tone: body.tone,
        durationSec: scriptDur,
        whisperTimeline
      });
      const combinedScript = speakers
        .map((s) => {
          const key = String(s.id);
          const bodyText = grok.scriptsBySpeaker[key] || grok.scriptsBySpeaker[s.id] || "";
          return `【${s.label}】\n${bodyText}`.trim();
        })
        .join("\n\n");
      const durationMs = Date.now() - started;

      await admin
        .from("media_pipeline_jobs")
        .update({
          status: "completed",
          step: "done",
          error: null,
          translation: grok.referenceTranslation,
          script: combinedScript,
          training_bundle: {
            schemaVersion: 2,
            mode: "script",
            speakerCount: body.speakerCount ?? speakers.length,
            speakers: speakers.map((s) => ({ id: s.id, lineCount: s.lines.length }))
          },
          models: { grok: GROK_MODEL },
          duration_ms: durationMs,
          updated_at: new Date().toISOString()
        })
        .eq("id", jobId);

      return jsonResponse({
        ok: true,
        jobId,
        mode: "script",
        scriptsBySpeaker: grok.scriptsBySpeaker,
        referenceTranslation: grok.referenceTranslation,
        script: combinedScript,
        timecodedByWhisper: true,
        whisperTimeline,
        whisperSegments,
        whisperDurationSec:
          Number(body.whisperDurationSec) > 0
            ? Number(body.whisperDurationSec)
            : whisperAudioDurationSec(null, whisperSegments),
        durationMs
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await admin
        .from("media_pipeline_jobs")
        .update({
          status: "failed",
          step: "error",
          error: msg,
          updated_at: new Date().toISOString()
        })
        .eq("id", jobId);
      return jsonResponse({ ok: false, jobId, error: msg }, 422);
    }
  }

  if (!videoUrl && !audioUrl) {
    return jsonResponse({ ok: false, error: "videoUrl または audioUrl のどちらかが必要です。" }, 400);
  }

  if (videoUrl && !extractYouTubeVideoId(videoUrl)) {
    return jsonResponse({ ok: false, error: "YouTube の動画URLとして解釈できませんでした。" }, 400);
  }

  const { data: inserted, error: insErr } = await admin
    .from("media_pipeline_jobs")
    .insert({
      user_id: userId,
      request_id: requestId,
      video_url: videoUrl || null,
      audio_url: audioUrl || null,
      audio_source: "pending",
      status: "running",
      step: "init"
    })
    .select("id")
    .single();

  if (insErr || !inserted?.id) {
    return jsonResponse({ ok: false, error: insErr?.message || "ジョブの作成に失敗しました。" }, 500);
  }

  const jobId = inserted.id as string;

  try {
    let audio: Uint8Array;
    let audioSource: string;
    let filename = "audio.m4a";

    let rawAudioStorageUrl: string | null = null;
    let cleanedAudioStorageUrl: string | null = null;
    const videoId = extractYouTubeVideoId(videoUrl || "") || "upload";

    if (audioUrl) {
      audioSource = "audio_url";
      audio = await fetchAudioFromUrl(audioUrl);
      try {
        const ext = new URL(audioUrl).pathname.split(".").pop();
        if (ext && /^[a-z0-9]+$/i.test(ext) && ext.length <= 5) filename = `audio.${ext}`;
      } catch {
        /* keep default */
      }
      if (userId) {
        try {
          rawAudioStorageUrl = await uploadAudioToStorage(admin, userId, videoId, audio, "raw");
        } catch { /* non-critical */ }
      }
    } else {
      audioSource = Deno.env.get("YOUTUBE_AUDIO_PROXY_URL") ? "youtube_proxy" : "missing_proxy";
      if (audioSource === "missing_proxy") {
        throw new Error(
          "YouTube の videoUrl のみでは音声を取得できません。Supabase secrets に YOUTUBE_AUDIO_PROXY_URL を設定するか、抽出済み音声の audioUrl を指定してください。"
        );
      }
      await admin.from("media_pipeline_jobs").update({ step: "extract", audio_source: audioSource }).eq("id", jobId);

      const rawResult = await fetchAudioFromProxy(videoUrl, false);
      const cleanedResult = await fetchAudioFromProxy(videoUrl, true);
      audio = cleanedResult.vocalSeparated ? cleanedResult.buf : rawResult.buf;

      if (userId) {
        try {
          rawAudioStorageUrl = await uploadAudioToStorage(admin, userId, videoId, rawResult.buf, "raw");
          if (cleanedResult.vocalSeparated) {
            cleanedAudioStorageUrl = await uploadAudioToStorage(admin, userId, videoId, cleanedResult.buf, "cleaned");
          }
        } catch { /* non-critical */ }
      }
    }

    await admin.from("media_pipeline_jobs").update({ step: "whisperx", audio_source: audioSource }).eq("id", jobId);

    const whisper = await transcribeWhisperX(audio, filename);
    const whisperLang = whisper.language;

    if (mode === "transcribe") {
      const durationMs = Date.now() - started;
      const trainingBundle = buildTrainingBundle({
        videoUrl: videoUrl || audioUrl,
        transcriptLen: whisper.text.length,
        audioSource,
        whisperLanguage: whisperLang,
        segmentCount: whisper.segments.length
      });

      await admin
        .from("media_pipeline_jobs")
        .update({
          status: "completed",
          step: "transcribed",
          error: null,
          whisper_transcript: whisper.text,
          whisper_raw: whisper.raw,
          training_bundle: trainingBundle,
          models: { whisperx: whisper.raw.model ?? "whisperx" },
          duration_ms: durationMs,
          updated_at: new Date().toISOString()
        })
        .eq("id", jobId);

      const audioDurationSec = whisper.durationSec;
      const whisperSegments = clampWhisperSegmentsToDuration(
        whisper.segments,
        audioDurationSec
      );

      return jsonResponse({
        ok: true,
        jobId,
        mode: "transcribe",
        whisperTranscript: appendTranscribeBuildMarker(whisper.text),
        whisperLanguage: whisperLang ?? null,
        whisperSegments,
        whisperDurationSec: audioDurationSec,
        whisperTimeline: appendTranscribeBuildMarker(whisper.whisperTimeline),
        whisperSource: "whisperx",
        transcribeBuild: WAVRICK_TRANSCRIBE_BUILD,
        whisperxBuild: whisper.whisperxBuild,
        silenceGapCount: whisper.silenceGapCount,
        timelineLineCount: whisperSegments.length,
        audioDurationSec,
        durationMs,
        rawAudioUrl: rawAudioStorageUrl,
        cleanedAudioUrl: cleanedAudioStorageUrl
      });
    }

    await admin.from("media_pipeline_jobs").update({ step: "grok" }).eq("id", jobId);

    const audioDurationSec = whisper.durationSec;
    const whisperSegments = clampWhisperSegmentsToDuration(
      whisper.segments,
      audioDurationSec
    );
    const whisperTimelineForGrok = resolveWhisperTimeline(
      body,
      whisperSegments,
      audioDurationSec
    );
    const grok = await translateAndScriptWithGrok(
      whisperSegments,
      audioDurationSec,
      whisperTimelineForGrok
    );

    const durationMs = Date.now() - started;
    const trainingBundle = buildTrainingBundle({
      videoUrl: videoUrl || audioUrl,
      transcriptLen: whisper.text.length,
      audioSource,
      whisperLanguage: whisperLang,
      segmentCount: whisper.segments.length
    });

    await admin
      .from("media_pipeline_jobs")
      .update({
        status: "completed",
        step: "done",
        error: null,
        whisper_transcript: whisper.text,
        whisper_raw: whisper.raw,
        translation: grok.translation,
        script: grok.script,
        training_bundle: trainingBundle,
        models: { whisperx: whisper.raw.model ?? "whisperx", grok: GROK_MODEL },
        duration_ms: durationMs,
        updated_at: new Date().toISOString()
      })
      .eq("id", jobId);

    return jsonResponse({
      ok: true,
      jobId,
      mode: "full",
      whisperTranscript: whisper.text,
      whisperSegments,
      whisperDurationSec: audioDurationSec,
      whisperTimeline: whisper.whisperTimeline,
      whisperSource: "whisperx",
      translation: grok.translation,
      script: grok.script,
      timecodedByWhisper: true,
      durationMs
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await admin
      .from("media_pipeline_jobs")
      .update({
        status: "failed",
        step: "error",
        error: msg,
        updated_at: new Date().toISOString()
      })
      .eq("id", jobId);
    return jsonResponse({ ok: false, jobId, error: msg }, 422);
  }
});
