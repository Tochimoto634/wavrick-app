import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  buildChronologicalScriptFromWhisperTimeline,
  buildChronologicalTimedCuesFromAssignRanges,
  buildScriptsBySpeakerFromWhisperTimeline,
  chronologicalCuesToScript,
  GROK_TRANSLATE_LINES_SYSTEM,
  mergeTranslationsIntoWhisperTimeline,
  normalizeWhisperSegsForGrok,
  scriptsBySpeakerFromChronologicalCues,
  speakerAssignmentsToPlainText,
  whisperSegmentsToBracketTimelineText
} from "../_shared/grok-timecode-prompt.ts";
import {
  appendTranscribeBuildMarker,
  WAVRICK_TRANSCRIBE_BUILD
} from "../_shared/transcribe-build.ts";
import {
  canPassthroughAudioUrlToWhisperx,
  getRunpodTranscribeStatus,
  guessWhisperUploadFilename,
  isRunpodAsyncMode,
  isRunpodWhisperxMode,
  submitRunpodTranscribeAsync,
  transcribeWithWhisperX,
  transcribeWithWhisperXFromUrl
} from "../_shared/whisperx-client.ts";
import {
  buildBracketTimelineFromWhisperX,
  buildTimelineCuesFromWhisperX,
  joinWordTexts,
  normalizeAlignWords,
  timelineCuesToLegacySegments,
  type LegacyWhisperSegment,
  type SilenceGap,
  type WhisperSeg
} from "../_shared/whisperx-timeline-rules.ts";
import { corsHeadersForRequest } from "../_shared/cors.ts";
import {
  burstLimitPerMinute,
  clientIpFromRequest,
  enforceRateLimit,
  mediaPipelineLimits,
  rateLimitResponseHeaders
} from "../_shared/rate-limit.ts";

/** 返却 MP3 想定。48MB ≒ 128kbps で約50分弱（従来24MBは yt-dlp 途中打切りで約4〜5分止まりの原因だった） */
const MAX_WHISPER_BYTES = 48 * 1024 * 1024;
const GROK_MODEL = Deno.env.get("GROK_MODEL") || "grok-4.3";
/** 1 回の Grok に載せる行数（長尺・多話者でタイムアウトしないよう分割） */
const GROK_PREVIEW_LINES_BATCH_SIZE = 20;
const GROK_PREVIEW_LINES_BATCH_MAX_CHARS = 12_000;

type SpeakerInput = {
  id: number;
  label?: string;
  lines: string[];
};

type PipelineBody = {
  /** transcribe = Whisperのみ / prepare-audio = YouTube音声をStorageへ / status = ジョブ確認 / script / full */
  mode?: "transcribe" | "prepare-audio" | "status" | "script" | "full";
  /** status モードで参照する media_pipeline_jobs.id */
  jobId?: string;
  videoUrl?: string;
  audioUrl?: string;
  /** prepare-audio 後の transcribe で同じジョブを継続 */
  existingJobId?: string;
  requestId?: string;
  speakerCount?: number;
  speakers?: SpeakerInput[];
  tone?: string;
  /** フロントで保持している Whisper セグメント（Grok へそのまま渡す） */
  whisperSegments?: WhisperSeg[];
  whisperDurationSec?: number;
  /** 文字起こし時のブラケット台本（Grok へそのまま・時刻の正） */
  whisperTimeline?: string;
  /** 話者割り当て UI のプレーンテキスト（文字オフセットの基準） */
  transcriptPlain?: string;
  /** 話者割り当て範囲（ドラッグ選択） */
  assignRanges?: {
    start: number;
    end: number;
    speakerIndex: number;
    startSec?: number;
    endSec?: number;
  }[];
};

function makeJsonResponse(corsHeaders: Record<string, string>) {
  return (body: unknown, status = 200, extraHeaders: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: {
        ...corsHeaders,
        ...extraHeaders,
        "Content-Type": "application/json; charset=utf-8"
      }
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

async function fetchAudioFromProxy(
  videoUrl: string,
  vocalSeparate = true
): Promise<{ buf: Uint8Array; vocalSeparated: boolean; contentType: string | null }> {
  const proxyUrl = Deno.env.get("YOUTUBE_AUDIO_PROXY_URL");
  if (!proxyUrl) {
    throw new Error(
      "YOUTUBE_AUDIO_PROXY_URL が未設定です。services/youtube-audio-proxy をデプロイするか、body.audioUrl で音声URLを渡してください。"
    );
  }
  let r: Response;
  try {
    r = await fetch(proxyUrl, {
      method: "POST",
      headers: proxyAuthHeaders(),
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
    let detail = t.slice(0, 500);
    try {
      const parsed = JSON.parse(t) as { error?: string };
      if (parsed?.error) detail = String(parsed.error);
    } catch {
      /* keep raw body */
    }
    throw new Error(`音声プロキシが失敗しました (${r.status}): ${detail}`);
  }
  const buf = new Uint8Array(await r.arrayBuffer());
  if (buf.byteLength > MAX_WHISPER_BYTES) {
    throw new Error(
      `音声が大きすぎます（${buf.byteLength} bytes）。上限は約48MBです。短くするかビットレートを下げてください。`
    );
  }
  if (buf.byteLength < 256) {
    throw new Error("音声データが短すぎるか空です。");
  }
  const vocalSeparated = r.headers.get("X-Wavrick-Vocal-Separated") === "1";
  return { buf, vocalSeparated, contentType: r.headers.get("Content-Type") };
}

function pipelineRawAudioPath(
  userId: string | null,
  jobId: string,
  videoId: string
): string {
  return userId
    ? `${userId}/${videoId}_raw.mp3`
    : `pipeline-temp/${jobId}_raw.mp3`;
}

function assertAudioSizeWithinLimit(byteLength: number, label: string): void {
  if (byteLength > MAX_WHISPER_BYTES) {
    throw new Error(
      `${label}が大きすぎます（${byteLength} bytes）。上限は約48MBです。短い動画で試してください。`
    );
  }
  if (byteLength < 256) {
    throw new Error(`${label}が短すぎるか空です。`);
  }
}

function proxyAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const secret = (Deno.env.get("YOUTUBE_AUDIO_PROXY_SECRET") || "").trim();
  if (secret) headers.Authorization = `Bearer ${secret}`;
  return headers;
}

/** Edge のメモリ節約: バイト列を抱えずストリームで Storage に保存 */
async function streamBodyToStorage(
  admin: ReturnType<typeof createClient>,
  storagePath: string,
  body: ReadableStream<Uint8Array>,
  contentType: string
): Promise<string> {
  const { error } = await admin.storage.from("customer-uploads").upload(storagePath, body, {
    contentType,
    upsert: true,
    duplex: "half"
  } as { contentType: string; upsert: boolean; duplex: string });
  if (error) throw new Error(`Storage upload failed: ${error.message}`);
  const { data } = admin.storage.from("customer-uploads").getPublicUrl(storagePath);
  return data.publicUrl;
}

async function fetchProxyAudioToStorage(
  admin: ReturnType<typeof createClient>,
  videoUrl: string,
  storagePath: string,
  vocalSeparate = false
): Promise<{ publicUrl: string; vocalSeparated: boolean; audioDurationSec?: number }> {
  const proxyUrl = Deno.env.get("YOUTUBE_AUDIO_PROXY_URL");
  if (!proxyUrl) {
    throw new Error("YOUTUBE_AUDIO_PROXY_URL が未設定です。");
  }
  let r: Response;
  try {
    r = await fetch(proxyUrl, {
      method: "POST",
      headers: proxyAuthHeaders(),
      body: JSON.stringify({
        videoUrl,
        vocalSeparate,
        delivery: "storage",
        storagePath
      })
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`音声プロキシへの接続に失敗しました: ${msg}`);
  }

  const contentType = (r.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
  if (contentType.includes("application/json")) {
    const j = await r.json() as {
      ok?: boolean;
      error?: string;
      audioUrl?: string;
      vocalSeparated?: boolean;
      audioDurationSec?: number;
    };
    if (!r.ok || j.ok === false) {
      throw new Error(`音声プロキシが失敗しました (${r.status}): ${j.error || "unknown"}`);
    }
    const publicUrl = String(j.audioUrl || "").trim();
    if (!publicUrl) throw new Error("音声プロキシが audioUrl を返しませんでした。");
    if (!canPassthroughAudioUrlToWhisperx(publicUrl)) {
      throw new Error("Storage URL を RunPod に渡せません。");
    }
    return {
      publicUrl,
      vocalSeparated: Boolean(j.vocalSeparated),
      audioDurationSec: Number(j.audioDurationSec) > 0 ? Number(j.audioDurationSec) : undefined
    };
  }

  if (!r.ok) {
    const t = await r.text();
    let detail = t.slice(0, 500);
    try {
      const parsed = JSON.parse(t) as { error?: string };
      if (parsed?.error) detail = String(parsed.error);
    } catch {
      /* keep */
    }
    throw new Error(
      `音声プロキシが旧形式で音声バイト列を返しました (${r.status})。` +
      " Railway の youtube-audio-proxy を最新にデプロイし、環境変数 SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY を設定してください。"
    );
  }
  const contentLength = Number(r.headers.get("Content-Length") || "0");
  if (contentLength > 0) assertAudioSizeWithinLimit(contentLength, "音声");
  if (!r.body) throw new Error("音声プロキシの応答ボディが空です。");

  const mime = contentType || "audio/mpeg";
  const publicUrl = await streamBodyToStorage(admin, storagePath, r.body, mime);
  if (!canPassthroughAudioUrlToWhisperx(publicUrl)) {
    throw new Error("Storage URL を RunPod に渡せません。");
  }
  return {
    publicUrl,
    vocalSeparated: r.headers.get("X-Wavrick-Vocal-Separated") === "1"
  };
}

async function streamAudioUrlToStorage(
  admin: ReturnType<typeof createClient>,
  audioUrl: string,
  storagePath: string
): Promise<string> {
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
  const contentLength = Number(r.headers.get("Content-Length") || "0");
  if (contentLength > 0) assertAudioSizeWithinLimit(contentLength, "audioUrl の音声");
  if (!r.body) throw new Error("audioUrl の応答ボディが空です。");

  const contentType = (r.headers.get("Content-Type") || "audio/mpeg").split(";")[0].trim();
  const publicUrl = await streamBodyToStorage(admin, storagePath, r.body, contentType);
  if (!canPassthroughAudioUrlToWhisperx(publicUrl)) {
    throw new Error("Storage URL を RunPod に渡せません。");
  }
  return publicUrl;
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

async function buildTranscribeResult(wx: Awaited<ReturnType<typeof transcribeWithWhisperX>>): Promise<TranscribeResult> {
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
  const textFromCues =
    segments.map((s) => s.text).join(" ").trim() ||
    (Array.isArray(wx.segments)
      ? wx.segments.map((s) => String(s.text || "").trim()).filter(Boolean).join(" ")
      : "");
  const textFromWords = words.length
    ? joinWordTexts(words.map((w) => w.word))
    : "";
  const digitScore = (s: string) => (String(s || "").match(/\d/g) || []).length;
  const text =
    textFromWords &&
    (digitScore(textFromWords) > digitScore(textFromCues) ||
      (textFromWords.length > textFromCues.length + 3 &&
        textFromCues.length > 0 &&
        textFromWords.includes(textFromCues.slice(0, Math.min(24, textFromCues.length)))))
      ? textFromWords
      : textFromCues || textFromWords;
  if (!text) throw new Error("WhisperX の結果が空でした。");

  const raw: Record<string, unknown> = {
    source: "whisperx",
    model: wx.model ?? null,
    language: wx.language ?? null,
    duration: durationSec,
    text,
    segmentCount: segments.length,
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

async function transcribeWhisperX(
  audio: Uint8Array,
  filename: string
): Promise<TranscribeResult> {
  return buildTranscribeResult(await transcribeWithWhisperX(audio, filename));
}

async function transcribeWhisperXFromUrl(audioUrl: string): Promise<TranscribeResult> {
  return buildTranscribeResult(await transcribeWithWhisperXFromUrl(audioUrl));
}

type PipelineJobRow = {
  id: string;
  user_id: string | null;
  video_url: string | null;
  audio_url: string | null;
  audio_source: string | null;
  status: string;
  step: string | null;
  error: string | null;
  whisper_transcript: string | null;
  whisper_raw: Record<string, unknown> | null;
  training_bundle: Record<string, unknown> | null;
  models: Record<string, unknown> | null;
  duration_ms: number | null;
};

function modelsRunpodJobId(models: Record<string, unknown> | null | undefined): string {
  const id = models?.runpodJobId;
  return typeof id === "string" ? id.trim() : "";
}

function buildTranscribeJsonResponse(params: {
  jobId: string;
  whisper: TranscribeResult;
  whisperLang?: string;
  durationMs: number;
  rawAudioUrl?: string | null;
  cleanedAudioUrl?: string | null;
  status?: string;
  async?: boolean;
}): Record<string, unknown> {
  const audioDurationSec = params.whisper.durationSec;
  const whisperSegments = clampWhisperSegmentsToDuration(
    params.whisper.segments,
    audioDurationSec
  );
  return {
    ok: true,
    jobId: params.jobId,
    mode: "transcribe",
    status: params.status || "completed",
    async: params.async === true,
    whisperTranscript: appendTranscribeBuildMarker(params.whisper.text),
    whisperLanguage: params.whisperLang ?? params.whisper.language ?? null,
    whisperSegments,
    whisperDurationSec: audioDurationSec,
    whisperTimeline: appendTranscribeBuildMarker(params.whisper.whisperTimeline),
    whisperSource: "whisperx",
    transcribeBuild: WAVRICK_TRANSCRIBE_BUILD,
    whisperxBuild: params.whisper.whisperxBuild,
    silenceGapCount: params.whisper.silenceGapCount,
    timelineLineCount: whisperSegments.length,
    audioDurationSec,
    durationMs: params.durationMs,
    rawAudioUrl: params.rawAudioUrl ?? null,
    cleanedAudioUrl: params.cleanedAudioUrl ?? null
  };
}

function transcribeJsonResponseFromJob(
  job: PipelineJobRow,
  extras?: { rawAudioUrl?: string | null; cleanedAudioUrl?: string | null }
): Record<string, unknown> {
  const raw = (job.whisper_raw || {}) as Record<string, unknown>;
  const segments = Array.isArray(raw.timelineSegments)
    ? (raw.timelineSegments as LegacyWhisperSegment[])
    : [];
  const durationSec = Number(raw.duration) > 0 ? Number(raw.duration) : 0;
  const whisperSegments = clampWhisperSegmentsToDuration(segments, durationSec);
  const text = String(job.whisper_transcript || raw.text || "").trim();
  return {
    ok: true,
    jobId: job.id,
    mode: "transcribe",
    status: "completed",
    whisperTranscript: appendTranscribeBuildMarker(text),
    whisperLanguage: raw.language ?? null,
    whisperSegments,
    whisperDurationSec: durationSec,
    whisperTimeline: appendTranscribeBuildMarker(String(raw.whisperTimeline || "")),
    whisperSource: "whisperx",
    transcribeBuild: WAVRICK_TRANSCRIBE_BUILD,
    whisperxBuild: typeof raw.build === "number" ? raw.build : null,
    silenceGapCount: Array.isArray(raw.silenceGaps) ? raw.silenceGaps.length : null,
    timelineLineCount: whisperSegments.length,
    audioDurationSec: durationSec,
    durationMs: job.duration_ms ?? null,
    rawAudioUrl: extras?.rawAudioUrl ?? job.audio_url ?? null,
    cleanedAudioUrl: extras?.cleanedAudioUrl ?? null
  };
}

async function persistTranscribeJob(params: {
  admin: ReturnType<typeof createClient>;
  jobId: string;
  whisper: TranscribeResult;
  whisperLang?: string;
  audioSource: string;
  videoUrl: string;
  audioUrl: string;
  durationMs: number;
  models?: Record<string, unknown>;
}): Promise<void> {
  const trainingBundle = buildTrainingBundle({
    videoUrl: params.videoUrl || params.audioUrl,
    transcriptLen: params.whisper.text.length,
    audioSource: params.audioSource,
    whisperLanguage: params.whisperLang ?? params.whisper.language,
    segmentCount: params.whisper.segments.length
  });
  await params.admin
    .from("media_pipeline_jobs")
    .update({
      status: "completed",
      step: "transcribed",
      error: null,
      whisper_transcript: params.whisper.text,
      whisper_raw: params.whisper.raw,
      training_bundle: trainingBundle,
      models: {
        whisperx: params.whisper.raw.model ?? "whisperx",
        ...(params.models || {})
      },
      duration_ms: params.durationMs,
      updated_at: new Date().toISOString()
    })
    .eq("id", params.jobId);
}

async function finalizeRunpodTranscribeJob(params: {
  admin: ReturnType<typeof createClient>;
  job: PipelineJobRow;
  runpodJobId: string;
  startedMs: number;
}): Promise<Record<string, unknown>> {
  const rp = await getRunpodTranscribeStatus(params.runpodJobId);
  const st = String(rp.status || "").toUpperCase();
  if (st === "IN_QUEUE" || st === "IN_PROGRESS") {
    return {
      ok: true,
      jobId: params.job.id,
      mode: "transcribe",
      status: "running",
      step: params.job.step || "whisperx",
      runpodStatus: st
    };
  }
  if (st === "FAILED" || st === "CANCELLED" || st === "TIMED_OUT") {
    const msg = String(rp.error || `RunPod ジョブが ${st} になりました。`);
    await params.admin
      .from("media_pipeline_jobs")
      .update({
        status: "failed",
        step: "error",
        error: msg,
        updated_at: new Date().toISOString()
      })
      .eq("id", params.job.id);
    return { ok: false, jobId: params.job.id, status: "failed", error: msg };
  }
  if (st !== "COMPLETED" || !rp.output) {
    return {
      ok: true,
      jobId: params.job.id,
      mode: "transcribe",
      status: "running",
      step: params.job.step || "whisperx",
      runpodStatus: st || "UNKNOWN"
    };
  }

  const whisper = await buildTranscribeResult(rp.output);
  const durationMs = Date.now() - params.startedMs;
  const audioSource = String(params.job.audio_source || "audio_url");
  await persistTranscribeJob({
    admin: params.admin,
    jobId: params.job.id,
    whisper,
    whisperLang: whisper.language,
    audioSource,
    videoUrl: String(params.job.video_url || ""),
    audioUrl: String(params.job.audio_url || ""),
    durationMs,
    models: {
      ...(params.job.models || {}),
      runpodJobId: params.runpodJobId,
      whisperx: whisper.raw.model ?? "whisperx"
    }
  });
  return transcribeJsonResponseFromJob(
    {
      ...params.job,
      status: "completed",
      step: "transcribed",
      whisper_transcript: whisper.text,
      whisper_raw: whisper.raw,
      duration_ms: durationMs
    },
    { rawAudioUrl: params.job.audio_url }
  );
}

declare const EdgeRuntime: { waitUntil: (promise: Promise<unknown>) => void };

async function backgroundTranscribeJob(params: {
  admin: ReturnType<typeof createClient>;
  jobId: string;
  whisperPassthroughUrl: string | null;
  audio: Uint8Array | null;
  filename: string;
  audioSource: string;
  videoUrl: string;
  audioUrl: string;
  startedMs: number;
}): Promise<void> {
  try {
    const whisper = params.whisperPassthroughUrl
      ? await transcribeWhisperXFromUrl(params.whisperPassthroughUrl)
      : await transcribeWhisperX(params.audio!, params.filename);
    await persistTranscribeJob({
      admin: params.admin,
      jobId: params.jobId,
      whisper,
      whisperLang: whisper.language,
      audioSource: params.audioSource,
      videoUrl: params.videoUrl,
      audioUrl: params.audioUrl,
      durationMs: Date.now() - params.startedMs
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await params.admin
      .from("media_pipeline_jobs")
      .update({
        status: "failed",
        step: "error",
        error: msg,
        updated_at: new Date().toISOString()
      })
      .eq("id", params.jobId);
  }
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

function chunkPreviewLinesForGrok(
  previewLines: string[],
  maxLines = GROK_PREVIEW_LINES_BATCH_SIZE,
  maxChars = GROK_PREVIEW_LINES_BATCH_MAX_CHARS
): string[][] {
  const chunks: string[][] = [];
  let cur: string[] = [];
  let curChars = 0;
  for (const raw of previewLines) {
    const line = String(raw || "").trim();
    if (!line) continue;
    const len = line.length;
    if (
      cur.length >= maxLines ||
      (cur.length > 0 && curChars + len > maxChars)
    ) {
      chunks.push(cur);
      cur = [];
      curChars = 0;
    }
    cur.push(line);
    curChars += len;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

async function translatePreviewLinesBatchWithGrok(
  previewLines: string[],
  extraUserHint = ""
): Promise<{ translation: string; lines: string[] }> {
  const numbered = previewLines
    .map((line, i) => `${i + 1}. ${String(line || "").trim()}`)
    .join("\n");
  const userText = [
    "【話者別プレビューのセリフ（行数・順序厳守）】",
    "各行を必ず日本語の吹替に翻訳してください（原語のまま返さない）。",
    "タイムコード [ ] は出力しないでください。",
    "",
    numbered,
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
  let lines = Array.isArray(parsed.lines)
    ? parsed.lines.map((l) => String(l ?? "").trim())
    : [];
  if (lines.length > previewLines.length) {
    lines = lines.slice(0, previewLines.length);
  }
  while (lines.length < previewLines.length) {
    lines.push("");
  }
  const translation = typeof parsed.translation === "string" ? parsed.translation : "";
  return { translation, lines };
}

async function translatePreviewLinesWithGrok(
  previewLines: string[],
  extraUserHint = ""
): Promise<{ translation: string; lines: string[] }> {
  const lines = previewLines.map((l) => String(l ?? "").trim());
  if (!lines.length) {
    return { translation: "", lines: [] };
  }

  const chunks = chunkPreviewLinesForGrok(lines);
  if (chunks.length <= 1) {
    return translatePreviewLinesBatchWithGrok(trimmed, extraUserHint);
  }

  const allLines: string[] = [];
  const refParts: string[] = [];
  let offset = 0;
  for (let bi = 0; bi < chunks.length; bi++) {
    const chunk = chunks[bi];
    const batchHint = [
      extraUserHint,
      `（${offset + 1}〜${offset + chunk.length} 行目 / 全 ${lines.length} 行。行数・順序を変えないでください。）`
    ]
      .filter(Boolean)
      .join("\n");
    const { translation, lines } = await translatePreviewLinesBatchWithGrok(
      chunk,
      batchHint
    );
    if (translation) refParts.push(translation);
    allLines.push(...lines);
    offset += chunk.length;
  }
  return { translation: refParts.join("\n").trim(), lines: allLines };
}

async function translateWhisperTimelineWithGrok(
  whisperTimeline: string,
  extraUserHint = ""
): Promise<{ translation: string; lines: string[]; script: string }> {
  const userText = [
    "【WhisperX タイムコード付き書き起こし（行数・順序厳守）】",
    "各行のセリフを必ず日本語の吹替に翻訳してください（原語のまま返さない）。タイムコードは出力しないでください。",
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
  transcriptPlain?: string;
  speakerCount?: number;
  assignRanges?: {
    start: number;
    end: number;
    speakerIndex: number;
    startSec?: number;
    endSec?: number;
  }[];
}): Promise<{
  scriptsBySpeaker: Record<string, string>;
  referenceTranslation: string;
  translatedLines: string[];
  chronologicalScript: string;
}> {
  if (!params.whisperSegments.length) {
    throw new Error("whisperSegments が空です。");
  }

  const toneHint = (params.tone || "").trim() ? `希望トーン: ${params.tone.trim()}` : "";
  const dur = Number(params.durationSec) > 0 ? Number(params.durationSec) : 0;
  const assignRanges = Array.isArray(params.assignRanges) ? params.assignRanges : [];
  const transcriptPlain = String(params.transcriptPlain || "").trim();
  const maxAssignSpeaker = assignRanges.reduce(
    (m, r) => Math.max(m, Number(r.speakerIndex) || 0),
    0
  );
  const maxSpeakerId = params.speakers.reduce((m, s) => Math.max(m, s.id), 0);
  const speakerCount = Math.max(
    Number(params.speakerCount) || 0,
    params.speakers.length,
    maxAssignSpeaker,
    maxSpeakerId
  );
  const speakerMeta = params.speakers.map((s) => ({
    id: s.id,
    label: (s.label && String(s.label).trim()) || `話者${s.id}`,
    lines: s.lines
  }));
  const speakerPlain = speakerAssignmentsToPlainText(speakerMeta);

  if (assignRanges.length && transcriptPlain) {
    const chronoCues = buildChronologicalTimedCuesFromAssignRanges(
      transcriptPlain,
      assignRanges,
      speakerCount,
      speakerMeta.map(({ id, label }) => ({ id, label })),
      {
        whisperTimeline:
          params.whisperTimeline?.trim() ||
          whisperSegmentsToBracketTimelineText(params.whisperSegments, dur),
        whisperSegments: params.whisperSegments,
        durationSec: dur
      }
    );
    if (!chronoCues.length) {
      throw new Error("話者割り当てから時系列キューを組み立てられませんでした。");
    }

    const sourceLines = chronoCues.map((c) => c.text);
    const hint = [
      speakerPlain,
      "【重要】入力行は動画の時系列順です。行数・順序を変えないでください。",
      "各行はセリフ本文のみ。話者名 (てつや) などのラベルは付けないでください。",
      toneHint
    ]
      .filter(Boolean)
      .join("\n");
    const { translation: referenceTranslation, lines } =
      await translatePreviewLinesWithGrok(sourceLines, hint);
    const translatedCues = chronoCues.map((cue, i) => ({
      ...cue,
      text: (lines[i] || "").trim() || cue.text
    }));
    const chronologicalScript = chronologicalCuesToScript(translatedCues);
    const scriptsBySpeaker = scriptsBySpeakerFromChronologicalCues(translatedCues);

    if (!chronologicalScript.trim()) {
      throw new Error("話者割り当てから時系列台本を組み立てられませんでした。");
    }

    return {
      scriptsBySpeaker,
      referenceTranslation,
      translatedLines: lines,
      chronologicalScript
    };
  }

  const whisperTimeline =
    params.whisperTimeline?.trim() ||
    whisperSegmentsToBracketTimelineText(params.whisperSegments, dur);

  const { translation: referenceTranslation, lines, script: mergedScript } =
    await translateWhisperTimelineWithGrok(
      whisperTimeline,
      [speakerPlain, toneHint].filter(Boolean).join("\n")
    );

  let chronologicalScript = buildChronologicalScriptFromWhisperTimeline(
    whisperTimeline,
    speakerMeta,
    lines
  );
  if (!chronologicalScript.trim()) {
    chronologicalScript = mergedScript;
  }

  let scriptsBySpeaker = buildScriptsBySpeakerFromWhisperTimeline(
    whisperTimeline,
    speakerMeta.map((s) => ({ id: s.id, lines: s.lines })),
    lines,
    null
  );

  if (params.speakers.length === 1) {
    const key = String(params.speakers[0].id);
    if (!scriptsBySpeaker[key]?.trim()) {
      scriptsBySpeaker = { [key]: chronologicalScript };
    }
  }

  if (
    !chronologicalScript.trim() &&
    !Object.keys(scriptsBySpeaker).some((k) => scriptsBySpeaker[k]?.trim())
  ) {
    throw new Error("話者別台本の組み立てに失敗しました。");
  }

  return {
    scriptsBySpeaker,
    referenceTranslation,
    translatedLines: lines,
    chronologicalScript
  };
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
  const corsHeaders = corsHeadersForRequest(req);
  const jsonResponse = makeJsonResponse(corsHeaders);

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

  const mode =
    body.mode === "transcribe" ||
    body.mode === "prepare-audio" ||
    body.mode === "status" ||
    body.mode === "script" ||
    body.mode === "full"
      ? body.mode
      : "full";
  const videoUrl = (body.videoUrl || "").trim();
  const audioUrl = (body.audioUrl || "").trim();
  const requestId = (body.requestId || "").trim() || null;

  const userId = await resolveUserId(req);
  const admin = createClient(supabaseUrl, serviceKey);
  const started = Date.now();

  const clientKey = userId ? `user:${userId}` : `ip:${clientIpFromRequest(req)}`;
  const burst = await enforceRateLimit({
    admin,
    bucketPrefix: "media-pipeline:burst",
    clientKey: `ip:${clientIpFromRequest(req)}`,
    limit: burstLimitPerMinute(),
    windowSec: 60
  });
  if (!burst.ok) {
    return jsonResponse(
      { ok: false, error: "短時間のリクエストが多すぎます。しばらく待ってから再試行してください。", retryAfterSec: burst.retryAfterSec },
      429,
      rateLimitResponseHeaders(burst.retryAfterSec)
    );
  }

  const existingJobIdForRl = (body.existingJobId || body.jobId || "").trim();
  const skipTranscribeRl =
    (mode === "transcribe" && Boolean((body.existingJobId || "").trim())) ||
    mode === "status";

  if (!skipTranscribeRl) {
    const modeLimit = mediaPipelineLimits(mode);
    const modeRl = await enforceRateLimit({
      admin,
      bucketPrefix: `media-pipeline:${mode}`,
      clientKey,
      limit: modeLimit.limit,
      windowSec: modeLimit.windowSec
    });
    if (!modeRl.ok) {
      const waitMin = Math.max(1, Math.ceil(modeRl.retryAfterSec / 60));
      return jsonResponse(
        {
          ok: false,
          error:
            `この操作の利用上限（${modeLimit.limit}回/時間）に達しました。約${waitMin}分待ってから再試行してください。`,
          retryAfterSec: modeRl.retryAfterSec
        },
        429,
        rateLimitResponseHeaders(modeRl.retryAfterSec)
      );
    }
  }

  if (mode === "status") {
    const statusJobId = (body.jobId || "").trim();
    if (!statusJobId) {
      return jsonResponse({ ok: false, error: "status には jobId が必要です。" }, 400);
    }

    const statusLimit = mediaPipelineLimits("status");
    const statusRl = await enforceRateLimit({
      admin,
      bucketPrefix: "media-pipeline:status",
      clientKey,
      limit: statusLimit.limit,
      windowSec: statusLimit.windowSec
    });
    if (!statusRl.ok) {
      return jsonResponse(
        {
          ok: false,
          error: "ステータス確認が多すぎます。しばらく待ってから再試行してください。",
          retryAfterSec: statusRl.retryAfterSec
        },
        429,
        rateLimitResponseHeaders(statusRl.retryAfterSec)
      );
    }

    const { data: job, error: jobErr } = await admin
      .from("media_pipeline_jobs")
      .select(
        "id, user_id, video_url, audio_url, audio_source, status, step, error, whisper_transcript, whisper_raw, training_bundle, models, duration_ms"
      )
      .eq("id", statusJobId)
      .maybeSingle();

    if (jobErr || !job?.id) {
      return jsonResponse({ ok: false, error: "jobId が見つかりません。" }, 404);
    }
    if (userId && job.user_id && job.user_id !== userId) {
      return jsonResponse({ ok: false, error: "このジョブを参照する権限がありません。" }, 403);
    }

    const row = job as PipelineJobRow;
    if (row.status === "completed" && row.whisper_transcript) {
      return jsonResponse(transcribeJsonResponseFromJob(row));
    }
    if (row.status === "failed") {
      return jsonResponse(
        { ok: false, jobId: row.id, status: "failed", error: row.error || "文字起こしに失敗しました。" },
        422
      );
    }

    const runpodJobId = modelsRunpodJobId(row.models);
    if (runpodJobId) {
      try {
        const result = await finalizeRunpodTranscribeJob({
          admin,
          job: row,
          runpodJobId,
          startedMs: started
        });
        const httpStatus = result.ok === false ? 422 : 200;
        return jsonResponse(result, httpStatus);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return jsonResponse({ ok: false, jobId: row.id, status: "running", error: msg }, 200);
      }
    }

    return jsonResponse({
      ok: true,
      jobId: row.id,
      mode: "transcribe",
      status: row.status === "running" ? "running" : row.status || "running",
      step: row.step || "whisperx"
    });
  }

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
        whisperTimeline,
        transcriptPlain: String(body.transcriptPlain || "").trim() || undefined,
        speakerCount: Number(body.speakerCount) || speakers.length,
        assignRanges: Array.isArray(body.assignRanges) ? body.assignRanges : undefined
      });
      const combinedScript =
        grok.chronologicalScript?.trim() ||
        speakers
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
        translatedLines: grok.translatedLines,
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

  if (mode === "prepare-audio") {
    if (!videoUrl) {
      return jsonResponse({ ok: false, error: "prepare-audio には videoUrl が必要です。" }, 400);
    }
    if (!extractYouTubeVideoId(videoUrl)) {
      return jsonResponse({ ok: false, error: "YouTube の動画URLとして解釈できませんでした。" }, 400);
    }
    if (!isRunpodWhisperxMode()) {
      return jsonResponse(
        { ok: false, error: "prepare-audio は RunPod 設定時のみ利用できます。" },
        400
      );
    }

    const { data: prepJob, error: prepInsErr } = await admin
      .from("media_pipeline_jobs")
      .insert({
        user_id: userId,
        request_id: requestId,
        video_url: videoUrl,
        audio_url: null,
        audio_source: "youtube_proxy",
        status: "running",
        step: "extract"
      })
      .select("id")
      .single();

    if (prepInsErr || !prepJob?.id) {
      return jsonResponse({ ok: false, error: prepInsErr?.message || "ジョブの作成に失敗しました。" }, 500);
    }

    const prepJobId = prepJob.id as string;
    const prepVideoId = extractYouTubeVideoId(videoUrl) || "upload";
    const prepStoragePath = pipelineRawAudioPath(userId, prepJobId, prepVideoId);

    try {
      const extracted = await fetchProxyAudioToStorage(admin, videoUrl, prepStoragePath, false);
      const durationMs = Date.now() - started;
      await admin
        .from("media_pipeline_jobs")
        .update({
          status: "audio_ready",
          step: "audio_ready",
          audio_url: extracted.publicUrl,
          audio_source: "youtube_proxy_storage",
          error: null,
          duration_ms: durationMs,
          updated_at: new Date().toISOString()
        })
        .eq("id", prepJobId);

      return jsonResponse({
        ok: true,
        jobId: prepJobId,
        mode: "prepare-audio",
        rawAudioUrl: extracted.publicUrl,
        audioDurationSec: extracted.audioDurationSec ?? null,
        durationMs,
        transcribeBuild: WAVRICK_TRANSCRIBE_BUILD
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
        .eq("id", prepJobId);
      return jsonResponse({ ok: false, jobId: prepJobId, error: msg }, 422);
    }
  }

  if (!videoUrl && !audioUrl) {
    return jsonResponse({ ok: false, error: "videoUrl または audioUrl のどちらかが必要です。" }, 400);
  }

  if (videoUrl && !extractYouTubeVideoId(videoUrl)) {
    return jsonResponse({ ok: false, error: "YouTube の動画URLとして解釈できませんでした。" }, 400);
  }

  const existingJobId = (body.existingJobId || "").trim();
  let jobId: string;

  if (existingJobId) {
    const { data: existingJob, error: existingErr } = await admin
      .from("media_pipeline_jobs")
      .select("id, status, audio_url")
      .eq("id", existingJobId)
      .maybeSingle();
    if (existingErr || !existingJob?.id) {
      return jsonResponse({ ok: false, error: "existingJobId が見つかりません。" }, 404);
    }
    jobId = existingJob.id as string;
    if (!audioUrl && typeof existingJob.audio_url === "string") {
      body.audioUrl = existingJob.audio_url;
    }
    await admin
      .from("media_pipeline_jobs")
      .update({
        status: "running",
        step: "whisperx",
        updated_at: new Date().toISOString()
      })
      .eq("id", jobId);
  } else {
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
    jobId = inserted.id as string;
  }

  const resolvedAudioUrl = (body.audioUrl || audioUrl || "").trim();

  try {
    let audio: Uint8Array | null = null;
    let whisperPassthroughUrl: string | null = null;
    let audioSource: string;
    let filename = "audio.mp3";

    let rawAudioStorageUrl: string | null = null;
    let cleanedAudioStorageUrl: string | null = null;
    const videoId = extractYouTubeVideoId(videoUrl || "") || "upload";

    const rawStoragePath = pipelineRawAudioPath(userId, jobId, videoId);

    if (resolvedAudioUrl) {
      audioSource = "audio_url";
      if (isRunpodWhisperxMode()) {
        if (canPassthroughAudioUrlToWhisperx(resolvedAudioUrl)) {
          whisperPassthroughUrl = resolvedAudioUrl;
          rawAudioStorageUrl = resolvedAudioUrl;
        } else {
          rawAudioStorageUrl = await streamAudioUrlToStorage(admin, resolvedAudioUrl, rawStoragePath);
          whisperPassthroughUrl = rawAudioStorageUrl;
        }
      } else if (canPassthroughAudioUrlToWhisperx(resolvedAudioUrl)) {
        whisperPassthroughUrl = resolvedAudioUrl;
      } else {
        audio = await fetchAudioFromUrl(resolvedAudioUrl);
        filename = guessWhisperUploadFilename(audio, { url: resolvedAudioUrl });
      }
    } else {
      audioSource = Deno.env.get("YOUTUBE_AUDIO_PROXY_URL") ? "youtube_proxy" : "missing_proxy";
      if (audioSource === "missing_proxy") {
        throw new Error(
          "YouTube の videoUrl のみでは音声を取得できません。Supabase secrets に YOUTUBE_AUDIO_PROXY_URL を設定するか、抽出済み音声の audioUrl を指定してください。"
        );
      }
      await admin.from("media_pipeline_jobs").update({ step: "extract", audio_source: audioSource }).eq("id", jobId);

      if (isRunpodWhisperxMode()) {
        const streamed = await fetchProxyAudioToStorage(admin, videoUrl, rawStoragePath, false);
        rawAudioStorageUrl = streamed.publicUrl;
        whisperPassthroughUrl = streamed.publicUrl;
      } else {
        // Pod 直結など RunPod 以外のみバイト列を保持
        const audioResult = await fetchAudioFromProxy(videoUrl, false);
        audio = audioResult.buf;
        filename = guessWhisperUploadFilename(audio, { contentType: audioResult.contentType });
      }
    }

    await admin.from("media_pipeline_jobs").update({ step: "whisperx", audio_source: audioSource }).eq("id", jobId);

    if (isRunpodWhisperxMode()) {
      if (!whisperPassthroughUrl) {
        throw new Error("RunPod 用文字起こし URL を取得できませんでした（Storage 保存失敗）。");
      }
    } else if (!whisperPassthroughUrl && !audio) {
      throw new Error("音声データを取得できませんでした。");
    }

    if (mode === "transcribe" && isRunpodAsyncMode() && whisperPassthroughUrl) {
      let runpodJobId = "";
      try {
        const submitted = await submitRunpodTranscribeAsync(whisperPassthroughUrl);
        runpodJobId = submitted.id;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn("[media-pipeline] RunPod async submit failed, using background transcribe:", msg);
      }

      if (runpodJobId) {
        await admin
          .from("media_pipeline_jobs")
          .update({
            status: "running",
            step: "whisperx",
            audio_url: whisperPassthroughUrl,
            audio_source: audioSource,
            error: null,
            models: { runpodJobId, whisperxPending: true },
            updated_at: new Date().toISOString()
          })
          .eq("id", jobId);

        return jsonResponse({
          ok: true,
          jobId,
          mode: "transcribe",
          status: "running",
          async: true,
          runpodJobId,
          transcribeBuild: WAVRICK_TRANSCRIBE_BUILD,
          rawAudioUrl: rawAudioStorageUrl ?? whisperPassthroughUrl,
          cleanedAudioUrl: cleanedAudioStorageUrl
        });
      }

      EdgeRuntime.waitUntil(
        backgroundTranscribeJob({
          admin,
          jobId,
          whisperPassthroughUrl,
          audio,
          filename,
          audioSource,
          videoUrl: videoUrl || "",
          audioUrl: resolvedAudioUrl || whisperPassthroughUrl,
          startedMs: started
        })
      );

      await admin
        .from("media_pipeline_jobs")
        .update({
          status: "running",
          step: "whisperx",
          audio_url: whisperPassthroughUrl,
          audio_source: audioSource,
          error: null,
          updated_at: new Date().toISOString()
        })
        .eq("id", jobId);

      return jsonResponse({
        ok: true,
        jobId,
        mode: "transcribe",
        status: "running",
        async: true,
        transcribeBuild: WAVRICK_TRANSCRIBE_BUILD,
        rawAudioUrl: rawAudioStorageUrl ?? whisperPassthroughUrl,
        cleanedAudioUrl: cleanedAudioStorageUrl
      });
    }

    const whisper = whisperPassthroughUrl
      ? await transcribeWhisperXFromUrl(whisperPassthroughUrl)
      : await transcribeWhisperX(audio!, filename);
    const whisperLang = whisper.language;

    if (mode === "transcribe") {
      const durationMs = Date.now() - started;
      await persistTranscribeJob({
        admin,
        jobId,
        whisper,
        whisperLang,
        audioSource,
        videoUrl: videoUrl || audioUrl,
        audioUrl: resolvedAudioUrl || audioUrl,
        durationMs
      });

      return jsonResponse(
        buildTranscribeJsonResponse({
          jobId,
          whisper,
          whisperLang,
          durationMs,
          rawAudioUrl: rawAudioStorageUrl,
          cleanedAudioUrl: cleanedAudioStorageUrl
        })
      );
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
