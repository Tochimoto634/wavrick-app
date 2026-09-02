import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  buildGrokTranslateLinesSystem,
  buildGrokTranslateUserPreamble,
  buildTranslateFidelityHint,
  normalizeScriptLanguageCode,
  type ScriptLanguageCode
} from "../_shared/script-languages.ts";
import {
  buildChronologicalScriptFromWhisperTimeline,
  buildChronologicalTimedCuesFromAssignRanges,
  buildPlainFromWhisperTimeline,
  buildScriptsBySpeakerFromWhisperTimeline,
  chronologicalCuesToScript,
  GROK_TRANSLATE_LINES_SYSTEM,
  mergeTranslationsIntoWhisperTimeline,
  normalizePreviewTextForCompare,
  normalizeWhisperSegsForGrok,
  parseBracketTimelineText,
  scriptsBySpeakerFromChronologicalCues,
  speakerAssignmentsToPlainText,
  speakerAssignmentToPlainTextSingle,
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
import { transcribeWithOpenAIWhisperFromUrl } from "../_shared/openai-whisper.ts";
import {
  buildBracketTimelineFromTimelineSegments,
  collapseExcessiveTextRepetition,
  joinWordTexts,
  normalizeAlignWords,
  normalizeSilenceGapsFromRaw,
  normalizeWhisperSegmentsFromRaw,
  sanitizeAlignWordsForTranscript,
  TRANSCRIPT_PHRASE_MAX_RUN,
  timelineCuesToLegacySegments,
  type AlignWord,
  type LegacyWhisperSegment,
  type SilenceGap,
  type WhisperSeg
} from "../_shared/whisperx-timeline-rules.ts";
import {
  adlibMarkersPreserved,
  ADLIB_CLOSE,
  ADLIB_OPEN,
  buildAssignRangeDraftPipeline,
  buildReconciledScriptPipeline,
  extractAdlibTextsFromTranslatedLine,
  formatScriptRowsBlock,
  GROK_ADLIB_TRANSLATE_RULES,
  rowToGrokLine,
  stripAdlibMarkers,
  type ReconcileTimingOptions,
  type ScriptRow,
} from "../_shared/transcript-edit-reconcile.ts";
import {
  joinAlignWordsCompactText,
  joinAlignWordsDisplayText,
} from "../_shared/word-timestamp-align.ts";
import { corsHeadersForRequest } from "../_shared/cors.ts";
import {
  burstLimitPerMinute,
  clientIpFromRequest,
  enforceRateLimit,
  mediaPipelineLimits,
  rateLimitResponseHeaders,
  youtubeExtractUserLimits
} from "../_shared/rate-limit.ts";
import {
  assertYouTubeExtractAllowed,
  classifyYouTubeMetaError,
  isYouTubeExtractTestMode,
  logYouTubeExtractEvent
} from "../_shared/youtube-channel-guard.ts";
import {
  cacheStemFromOpts,
  lookupYouTubeAudioCache,
  saveYouTubeAudioCache,
  youtubeCacheStoragePath,
  type CacheStem
} from "../_shared/youtube-audio-cache.ts";
import {
  buildAdrSpeakersAndCues,
  diarizeJsonResponseFromJob,
  diarizeWithServiceFromUrl,
  getRunpodDiarizeStatus,
  isDiarizeAsyncCapable,
  normalizeDiarizeResponse,
  redactRunpodHtmlError,
  resolveAdrDiarizeAudioUrl,
  submitRunpodDiarizeAsync,
  type DiarizeResponse,
  type DiarizeSegment
} from "../_shared/diarize-client.ts";
import {
  notifyCaseRecipients,
  resolveCustomerEmailForRequest
} from "../_shared/case-notify.ts";

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
  /** transcribe = Whisperのみ / prepare-audio = YouTube音声をStorageへ / adr-prepare = v3 ADR / status = ジョブ確認 / script / script-reconcile / full */
  mode?: "transcribe" | "prepare-audio" | "adr-prepare" | "status" | "script" | "script-reconcile" | "full";
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
  /** status / script で参照する文字起こしジョブ ID（単語タイムコード取得用） */
  transcribeJobId?: string;
  /** 文字起こし時の Whisper 原文（表示用・編集 diff の基準） */
  transcriptPlainAtWhisper?: string;
  /** 話者割り当て範囲（ドラッグ選択） */
  assignRanges?: {
    start: number;
    end: number;
    speakerIndex: number;
    startSec?: number;
    endSec?: number;
  }[];
  /** 吹替台本の出力言語（ja / en / ko / zh / es） */
  scriptLanguage?: string;
  /** v3 ADR: 抽出する吹替トラックの言語（現状 ja のみ） */
  targetLang?: string;
  customerEmail?: string;
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
    ? `${userId}/${jobId}_${videoId}_raw.mp3`
    : `pipeline-temp/${jobId}_${videoId}_raw.mp3`;
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

function isProxyStorageUploadFailure(err: string): boolean {
  return /supabase storage upload|storage upload HTTP/i.test(err);
}

async function fetchProxyAudioToStorage(
  admin: ReturnType<typeof createClient>,
  videoUrl: string,
  storagePath: string,
  vocalSeparate = false,
  targetLang?: string,
  opts?: { requireDubTrack?: boolean; preferOriginalTrack?: boolean }
): Promise<{
  publicUrl: string;
  vocalSeparated: boolean;
  audioDurationSec?: number;
  byteLength?: number;
  selectedFormatId?: string | null;
  targetLang?: string | null;
  selectedLang?: string | null;
  langConfirmed?: boolean;
  trackRole?: string | null;
}> {
  const proxyUrl = Deno.env.get("YOUTUBE_AUDIO_PROXY_URL");
  if (!proxyUrl) {
    throw new Error("YOUTUBE_AUDIO_PROXY_URL が未設定です。");
  }
  const lang = (targetLang || "").trim() || undefined;

  const callProxy = async (delivery: "storage" | "bytes"): Promise<Response> => {
    const payload: Record<string, unknown> = {
      videoUrl,
      vocalSeparate: Boolean(vocalSeparate) && !opts?.preferOriginalTrack,
      targetLang: lang,
      requireDubTrack: Boolean(opts?.requireDubTrack && lang),
      preferOriginalTrack: Boolean(opts?.preferOriginalTrack && !lang)
    };
    if (delivery === "storage") {
      payload.delivery = "storage";
      payload.storagePath = storagePath;
    }
    try {
      // Dual extract in adr-prepare can take minutes; cap each call so Edge
      // waitUntil / gateway walls fail the job cleanly instead of hanging forever.
      return await fetch(proxyUrl, {
        method: "POST",
        headers: proxyAuthHeaders(),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(180_000)
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/abort|timeout/i.test(msg)) {
        throw new Error(
          `音声プロキシがタイムアウトしました（180秒）。動画が長すぎるか、プロキシが混雑しています。しばらくして再試行してください。`
        );
      }
      throw new Error(`音声プロキシへの接続に失敗しました: ${msg}`);
    }
  };

  const ingestProxyBytes = async (r: Response) => {
    const contentType = (r.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
    if (!r.ok) {
      const t = await r.text();
      let detail = t.slice(0, 500);
      try {
        const parsed = JSON.parse(t) as { error?: string };
        if (parsed?.error) detail = String(parsed.error);
      } catch {
        /* keep */
      }
      throw new Error(`音声プロキシが失敗しました (${r.status}): ${detail}`);
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
      vocalSeparated: r.headers.get("X-Wavrick-Vocal-Separated") === "1",
      byteLength: contentLength > 0 ? contentLength : undefined,
      selectedFormatId: r.headers.get("X-Wavrick-Selected-Format") || null,
      targetLang: r.headers.get("X-Wavrick-Target-Lang") || lang || null,
      selectedLang: r.headers.get("X-Wavrick-Target-Lang") || lang || null,
      langConfirmed: Boolean(lang && r.headers.get("X-Wavrick-Selected-Format")),
      trackRole: r.headers.get("X-Wavrick-Track-Role") || null
    };
  };

  let r = await callProxy("storage");
  const contentType = (r.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
  if (contentType.includes("application/json")) {
    const j = await r.json() as {
      ok?: boolean;
      error?: string;
      errorCode?: string;
      audioUrl?: string;
      vocalSeparated?: boolean;
      audioDurationSec?: number;
      byteLength?: number;
      selectedFormatId?: string | null;
      targetLang?: string | null;
      selectedLang?: string | null;
      langConfirmed?: boolean | null;
      trackRole?: string | null;
    };
    if (!r.ok || j.ok === false) {
      const code = String(j.errorCode || "").trim();
      const err = String(j.error || "unknown");
      if (
        code === "NO_LANGUAGE_TRACK" ||
        code === "NO_ORIGINAL_TRACK" ||
        code === "SAME_AS_ORIGINAL" ||
        code === "WRONG_LANGUAGE_TRACK" ||
        code === "YT_EXTRACT_BLOCKED"
      ) {
        throw new Error(`[${code}] ${err}`);
      }
      if (isProxyStorageUploadFailure(err)) {
        console.warn(
          "[media-pipeline] proxy delivery=storage failed; retrying as bytes:",
          err.slice(0, 240)
        );
        return await ingestProxyBytes(await callProxy("bytes"));
      }
      throw new Error(
        code
          ? `音声プロキシが失敗しました (${r.status}/${code}): ${err}`
          : `音声プロキシが失敗しました (${r.status}): ${err}`
      );
    }
    const publicUrl = String(j.audioUrl || "").trim();
    if (!publicUrl) throw new Error("音声プロキシが audioUrl を返しませんでした。");
    if (!canPassthroughAudioUrlToWhisperx(publicUrl)) {
      throw new Error("Storage URL を RunPod に渡せません。");
    }
    return {
      publicUrl,
      vocalSeparated: Boolean(j.vocalSeparated),
      audioDurationSec: Number(j.audioDurationSec) > 0 ? Number(j.audioDurationSec) : undefined,
      byteLength: Number(j.byteLength) > 0 ? Number(j.byteLength) : undefined,
      selectedFormatId: j.selectedFormatId != null ? String(j.selectedFormatId) : null,
      targetLang: j.targetLang != null ? String(j.targetLang) : lang || null,
      selectedLang: j.selectedLang != null ? String(j.selectedLang) : (j.targetLang != null ? String(j.targetLang) : lang || null),
      langConfirmed: j.langConfirmed == null ? Boolean(j.selectedFormatId && lang) : Boolean(j.langConfirmed),
      trackRole: j.trackRole != null ? String(j.trackRole) : null
    };
  }

  // Proxy already fell back to raw bytes (or older build without delivery=storage JSON).
  return await ingestProxyBytes(r);
}

function classifyYouTubeExtractError(msg: string): string | undefined {
  if (msg.includes("NO_LANGUAGE_TRACK")) return "NO_LANGUAGE_TRACK";
  if (msg.includes("NO_ORIGINAL_TRACK")) return "NO_ORIGINAL_TRACK";
  if (msg.includes("WRONG_LANGUAGE_TRACK")) return "WRONG_LANGUAGE_TRACK";
  if (msg.includes("CHANNEL_MISMATCH")) return "CHANNEL_MISMATCH";
  if (msg.includes("NO_REGISTERED_CHANNELS")) return "NO_REGISTERED_CHANNELS";
  if (msg.includes("AUTH_REQUIRED")) return "AUTH_REQUIRED";
  if (msg.includes("RATE_LIMIT")) return "RATE_LIMIT";
  const classified = classifyYouTubeMetaError(msg);
  return classified.errorCode;
}

async function enforceYouTubeExtractRateLimits(
  admin: ReturnType<typeof createClient>,
  userId: string | null
): Promise<{ ok: true } | { ok: false; retryAfterSec: number }> {
  if (!userId) return { ok: true };
  const limits = youtubeExtractUserLimits();
  const clientKey = `user:${userId}`;
  for (const [label, cfg] of [
    ["hour", limits.hour] as const,
    ["day", limits.day] as const
  ]) {
    const rl = await enforceRateLimit({
      admin,
      bucketPrefix: `youtube-extract:${label}`,
      clientKey,
      limit: cfg.limit,
      windowSec: cfg.windowSec
    });
    if (!rl.ok) return { ok: false, retryAfterSec: rl.retryAfterSec };
  }
  return { ok: true };
}

type ProxyStorageResult = Awaited<ReturnType<typeof fetchProxyAudioToStorage>>;

async function fetchProxyAudioToStorageCached(
  admin: ReturnType<typeof createClient>,
  videoUrl: string,
  storagePath: string,
  vocalSeparate = false,
  targetLang?: string,
  opts?: { requireDubTrack?: boolean; preferOriginalTrack?: boolean },
  audit?: {
    userId?: string | null;
    channelId?: string | null;
    videoId?: string;
  }
): Promise<ProxyStorageResult & { cached?: boolean }> {
  const videoId = audit?.videoId || extractYouTubeVideoId(videoUrl) || "";
  const langKey = (targetLang || "").trim();
  const stem: CacheStem = cacheStemFromOpts(opts);
  const useCache = Boolean(videoId) && Deno.env.get("WAVRICK_YT_CACHE_DISABLE") !== "1";

  if (useCache && videoId) {
    const hit = await lookupYouTubeAudioCache(admin, videoId, langKey, stem);
    if (hit) {
      await logYouTubeExtractEvent(admin, {
        userId: audit?.userId,
        videoId,
        channelId: hit.channelId || audit?.channelId,
        targetLang: langKey,
        stem,
        success: true,
        cached: true
      });
      return {
        publicUrl: hit.publicUrl,
        vocalSeparated: false,
        audioDurationSec: hit.durationSec,
        byteLength: hit.byteLength,
        selectedFormatId: null,
        targetLang: langKey || null,
        selectedLang: langKey || null,
        langConfirmed: Boolean(langKey),
        trackRole: stem === "original" ? "original" : langKey ? "dub" : "default",
        cached: true
      };
    }
  }

  const cachePath = videoId ? youtubeCacheStoragePath(videoId, langKey, stem) : storagePath;
  const destPath = useCache && videoId ? cachePath : storagePath;

  let lastErr: Error | null = null;
  let result: ProxyStorageResult | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
    try {
      result = await fetchProxyAudioToStorage(
        admin,
        videoUrl,
        destPath,
        vocalSeparate,
        targetLang,
        opts
      );
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      const code = classifyYouTubeExtractError(lastErr.message);
      if (code === "YT_EXTRACT_BLOCKED" && attempt === 0) continue;
      throw lastErr;
    }
  }
  if (!result) throw lastErr || new Error("YouTube 音声の取得に失敗しました。");

  if (useCache && videoId) {
    await saveYouTubeAudioCache(admin, {
      videoId,
      targetLang: langKey,
      stem,
      storagePath: destPath,
      byteLength: result.byteLength,
      durationSec: result.audioDurationSec,
      channelId: audit?.channelId || undefined
    });
  }

  await logYouTubeExtractEvent(admin, {
    userId: audit?.userId,
    videoId,
    channelId: audit?.channelId,
    targetLang: langKey,
    stem,
    success: true,
    cached: false
  });

  return { ...result, cached: false };
}

async function guardYouTubeVideoExtract(
  req: Request,
  admin: ReturnType<typeof createClient>,
  videoUrl: string,
  userId: string | null
): Promise<
  | { ok: true; channelId?: string }
  | { ok: false; status: number; body: Record<string, unknown>; retryAfterSec?: number }
> {
  const guard = await assertYouTubeExtractAllowed(req, admin, videoUrl);
  if (!guard.ok) {
    await logYouTubeExtractEvent(admin, {
      userId,
      videoId: extractYouTubeVideoId(videoUrl) || "",
      channelId: guard.channelId,
      success: false,
      errorCode: guard.errorCode
    });
    return {
      ok: false,
      status: guard.status,
      body: { ok: false, error: guard.error, errorCode: guard.errorCode }
    };
  }

  if (!isYouTubeExtractTestMode()) {
    const ytRl = await enforceYouTubeExtractRateLimits(admin, userId);
    if (!ytRl.ok) {
      return {
        ok: false,
        status: 429,
        retryAfterSec: ytRl.retryAfterSec,
        body: {
          ok: false,
          error: `YouTube 音声取得の利用上限に達しました。約${Math.max(1, Math.ceil(ytRl.retryAfterSec / 60))}分待ってから再試行してください。`,
          errorCode: "RATE_LIMIT",
          retryAfterSec: ytRl.retryAfterSec
        }
      };
    }
  }

  return { ok: true, channelId: guard.channelId };
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
  const roughSegmentsRaw = Array.isArray(wx.roughSegments)
    ? normalizeWhisperSegmentsFromRaw(wx.roughSegments)
    : [];
  const words = sanitizeAlignWordsForTranscript(
    normalizeAlignWords(wx.words),
    roughSegmentsRaw
  );
  const durationSec =
    Number(wx.duration) > 0
      ? Number(wx.duration)
      : words.length
        ? Math.max(...words.map((w) => w.end))
        : 0;

  let displayText = "";
  let compactText = "";
  let silenceGapCount = 0;

  if (words.length) {
    displayText = joinAlignWordsDisplayText(words);
    compactText = joinAlignWordsCompactText(words);
    displayText = collapseExcessiveTextRepetition(displayText, TRANSCRIPT_PHRASE_MAX_RUN);
    compactText = collapseExcessiveTextRepetition(compactText, TRANSCRIPT_PHRASE_MAX_RUN);
    for (let i = 1; i < words.length; i++) {
      const gap = words[i].start - words[i - 1].end;
      if (gap >= 2.0 - 0.05) silenceGapCount++;
    }
  } else {
    const wxSegments: WhisperSeg[] = Array.isArray(wx.segments)
      ? wx.segments
          .map((s) => ({
            start: Number(s.start) || 0,
            end: Number(s.end) || 0,
            text: String(s.text || "").trim()
          }))
          .filter((s) => s.text)
      : [];
    compactText =
      wxSegments.map((s) => s.text).join("").trim() ||
      wxSegments.map((s) => s.text).join(" ").trim();
    displayText = compactText;
  }

  if (!displayText.trim() && !compactText.trim()) {
    throw new Error("WhisperX の結果が空でした。");
  }
  if (!displayText.trim()) displayText = compactText;
  if (!compactText.trim()) compactText = displayText.replace(/\r?\n/g, "");

  const silenceGaps = Array.isArray(wx.silenceGaps) ? wx.silenceGaps : [];
  if (silenceGaps.length) silenceGapCount = silenceGaps.length;
  const roughSegments = roughSegmentsRaw.map((s) => ({
    ...s,
    text: collapseExcessiveTextRepetition(s.text),
  }));
  const wxSegments = Array.isArray(wx.segments)
    ? normalizeWhisperSegmentsFromRaw(wx.segments).map((s) => ({
        ...s,
        text: collapseExcessiveTextRepetition(s.text),
      }))
    : [];

  const raw: Record<string, unknown> = {
    source: "whisperx",
    model: wx.model ?? null,
    language: wx.language ?? null,
    duration: durationSec,
    text: compactText,
    displayText,
    wordCount: words.length,
    alignWords: words,
    silenceGaps,
    roughSegments,
    segments: wxSegments,
    segmentCount: wxSegments.length,
    timelineSegments: [],
    whisperTimeline: ""
  };

  return {
    text: displayText,
    raw,
    whisperTimeline: "",
    segments: [],
    durationSec,
    language: typeof wx.language === "string" ? wx.language : undefined,
    whisperxBuild: typeof wx.build === "number" ? wx.build : null,
    silenceGapCount
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
  pipeline_kind?: string | null;
  target_lang?: string | null;
  diarization_raw?: Record<string, unknown> | null;
  request_id?: string | null;
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
    await notifyPipelineFailed({
      admin: params.admin,
      requestId: params.job.request_id,
      jobId: params.job.id,
      userId: params.job.user_id
    });
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

function normalizeTargetLang(raw: string | undefined): string {
  const code = String(raw || "ja").trim().toLowerCase().split("-")[0];
  return code || "ja";
}

function targetLangDisplayName(code: string): string {
  const map: Record<string, string> = {
    ja: "日本語",
    en: "英語",
    ko: "韓国語",
    zh: "中国語",
    es: "スペイン語"
  };
  return map[code] || code;
}

type ProxyExtractedAudio = {
  publicUrl: string;
  vocalSeparated: boolean;
  audioDurationSec?: number;
  byteLength?: number;
  selectedFormatId?: string | null;
  targetLang?: string | null;
  selectedLang?: string | null;
  langConfirmed?: boolean | null;
};

/**
 * ADR: when a target language is requested, the proxy must return a locked
 * format id that it confirmed as that language. Never proceed on missing proof.
 */
function assertTargetLangExtractProven(
  targetLang: string,
  extracted: ProxyExtractedAudio
): void {
  const name = targetLangDisplayName(targetLang);
  const want = String(targetLang || "").trim().toLowerCase().split("-")[0];
  const got = String(extracted.selectedLang || extracted.targetLang || "")
    .trim()
    .toLowerCase()
    .split("-")[0];
  const fmt = String(extracted.selectedFormatId || "").trim();
  if (!fmt || fmt.startsWith("ba[") || fmt.includes("/") || fmt === "140") {
    throw new Error(
      `${name}の吹替トラックを確定できませんでした（format ID がありません）。\n` +
        `他言語音声での続行はできません。YouTube 上で${name}トラックが公開されているか、` +
        `音声プロキシ（extractBuild 19+）を確認して再試行してください。`
    );
  }
  if (extracted.langConfirmed === false) {
    throw new Error(
      `${name}の吹替トラック言語を確定できませんでした。\n` +
        `他言語音声での続行はできません。`
    );
  }
  if (got && want && got !== want) {
    throw new Error(
      `指定した翻訳先は${name}ですが、取得結果の言語が「${got}」でした（format ${fmt}）。\n` +
        `他言語音声での続行はできません。`
    );
  }
}

/**
 * ADR: 翻訳先吹替トラックは必ず原盤と別物でなければならない。
 * 同一バイト長・同一尺・同一 format なら「吹替が取れていない」とみなして失敗させる。
 */
function assertDistinctTargetLangAudio(
  targetLang: string,
  extracted: ProxyExtractedAudio,
  original: ProxyExtractedAudio
): void {
  assertTargetLangExtractProven(targetLang, extracted);
  const name = targetLangDisplayName(targetLang);
  if (!extracted.publicUrl) {
    throw new Error(
      `${name}の吹替トラックを取得できませんでした。\n` +
        `YouTube Studio で${name}の音声トラックを追加・公開してから再度お試しください。`
    );
  }
  if (extracted.publicUrl === original.publicUrl) {
    throw new Error(
      `${name}の吹替トラックを取得できませんでした（オリジナルと同じ音声 URL でした）。\n` +
        `YouTube Studio で${name}の AI 吹替／追加音声トラックを公開してから再度お試しください。`
    );
  }

  const tBytes = Number(extracted.byteLength) || 0;
  const oBytes = Number(original.byteLength) || 0;
  const tDur = Number(extracted.audioDurationSec) || 0;
  const oDur = Number(original.audioDurationSec) || 0;
  const sameBytes = tBytes > 0 && oBytes > 0 && tBytes === oBytes;
  const sameDuration = tDur > 0 && oDur > 0 && Math.abs(tDur - oDur) < 0.15;
  const tFmt = String(extracted.selectedFormatId || "").trim();
  const oFmt = String(original.selectedFormatId || "").trim();
  const sameFormat = Boolean(tFmt && oFmt && tFmt === oFmt);

  if (sameBytes || (sameDuration && sameFormat) || (sameDuration && sameBytes)) {
    throw new Error(
      `選択した翻訳先言語（${name}）の吹替トラックを正しく取得できませんでした。\n` +
        `抽出結果がオリジナル音声と同じでした。\n` +
        `他言語／原盤での続行はできません。` +
        ` YouTube Studio で${name}トラックの公開状態と、音声プロキシ cookies を確認して再試行してください。`
    );
  }
}

async function persistDiarizeJob(params: {
  admin: ReturnType<typeof createClient>;
  jobId: string;
  diarize: DiarizeResponse;
  audioSource: string;
  videoUrl: string;
  audioUrl: string;
  targetLang: string;
  durationMs: number;
  models?: Record<string, unknown>;
}): Promise<void> {
  await params.admin
    .from("media_pipeline_jobs")
    .update({
      status: "completed",
      step: "diarized",
      error: null,
      pipeline_kind: "v3_diarize",
      target_lang: params.targetLang,
      diarization_raw: params.diarize,
      models: {
        diarize: params.diarize.source ?? "pyannote",
        ...(params.models || {})
      },
      duration_ms: params.durationMs,
      updated_at: new Date().toISOString()
    })
    .eq("id", params.jobId);
}

function originalAudioFromJobModels(models: unknown): string {
  if (!models || typeof models !== "object") return "";
  const m = models as Record<string, unknown>;
  return String(m.originalAudioUrl || m.original_audio_url || "").trim();
}

async function ensureAdrProjectStub(params: {
  admin: ReturnType<typeof createClient>;
  requestId: string;
  customerUserId: string | null;
  customerEmail: string | null;
  videoUrl: string;
  targetLang: string;
  audioUrl: string;
  originalAudioUrl?: string | null;
  extractMeta?: Record<string, unknown> | null;
  audioDurationSec?: number | null;
  pipelineJobId: string;
}): Promise<void> {
  const originalAudioUrl = String(params.originalAudioUrl || "").trim() || null;
  const extractMeta = params.extractMeta || {
    targetLang: params.targetLang,
    targetAudioUrl: params.audioUrl,
    originalAudioUrl,
    audioDurationSec: params.audioDurationSec ?? null
  };
  const { error } = await params.admin.from("adr_projects").upsert(
    {
      request_id: params.requestId,
      customer_user_id: params.customerUserId,
      customer_email: params.customerEmail,
      video_url: params.videoUrl,
      target_lang: params.targetLang,
      audio_url: params.audioUrl,
      original_audio_url: originalAudioUrl,
      extract_meta: extractMeta,
      audio_duration_sec:
        params.audioDurationSec != null && Number(params.audioDurationSec) > 0
          ? Number(params.audioDurationSec)
          : null,
      pipeline_job_id: params.pipelineJobId,
      speakers: [],
      cues: [],
      status: "processing",
      whisper_status: "pending",
      whisper_error: null,
      updated_at: new Date().toISOString()
    },
    { onConflict: "request_id" }
  );
  if (error) {
    console.error("[media-pipeline] adr_projects stub upsert failed", error.message);
  }
}

async function persistAdrWhisper(params: {
  admin: ReturnType<typeof createClient>;
  requestId: string;
  status: "running" | "ready" | "failed";
  transcript?: string | null;
  segments?: { start: number; end: number; text: string }[] | null;
  language?: string | null;
  error?: string | null;
}): Promise<void> {
  const patch: Record<string, unknown> = {
    whisper_status: params.status,
    whisper_updated_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  if (params.status === "ready") {
    patch.whisper_transcript = String(params.transcript || "").trim() || null;
    patch.whisper_segments = Array.isArray(params.segments) ? params.segments : [];
    patch.whisper_language = params.language != null ? String(params.language) : null;
    patch.whisper_error = null;
  } else if (params.status === "failed") {
    patch.whisper_error = String(params.error || "Whisper failed").slice(0, 800);
  } else if (params.status === "running") {
    patch.whisper_error = null;
  }
  const { error } = await params.admin
    .from("adr_projects")
    .update(patch)
    .eq("request_id", params.requestId);
  if (error) {
    console.error("[media-pipeline] adr whisper persist failed", error.message);
  }
}

async function failAdrProject(params: {
  admin: ReturnType<typeof createClient>;
  requestId: string;
  error: string;
}): Promise<void> {
  const requestId = String(params.requestId || "").trim();
  if (!requestId) return;
  const msg = redactRunpodHtmlError(String(params.error || "failed")).slice(0, 800);
  const { error } = await params.admin
    .from("adr_projects")
    .update({
      status: "failed",
      whisper_status: "failed",
      whisper_error: msg,
      whisper_updated_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq("request_id", requestId);
  if (error) {
    console.error("[media-pipeline] adr_projects fail update failed", error.message);
  }
}

/**
 * Content-level language lock: Whisper auto-detect MUST match targetLang
 * before diarize/editing. Metadata/format_id alone is not trusted.
 * On success, captions are persisted (same Whisper call).
 */
async function gateAdrTargetAudioLanguage(params: {
  admin: ReturnType<typeof createClient>;
  requestId: string;
  audioUrl: string;
  targetLang: string;
  selectedFormatId?: string | null;
}): Promise<void> {
  const name = targetLangDisplayName(params.targetLang);
  await persistAdrWhisper({
    admin: params.admin,
    requestId: params.requestId,
    status: "running"
  });
  try {
    const result = await transcribeWithOpenAIWhisperFromUrl(params.audioUrl, {
      requireLanguage: params.targetLang || null
    });
    await persistAdrWhisper({
      admin: params.admin,
      requestId: params.requestId,
      status: "ready",
      transcript: result.text,
      segments: result.segments,
      language: result.language
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const fmt = String(params.selectedFormatId || "").trim();
    const enriched =
      msg.includes("WRONG_LANGUAGE_TRACK") || msg.includes("指定言語")
        ? msg
        : `WRONG_LANGUAGE_TRACK: ${name}吹替として検証できませんでした` +
          (fmt ? `（format ${fmt}）` : "") +
          `。${msg}`;
    await persistAdrWhisper({
      admin: params.admin,
      requestId: params.requestId,
      status: "failed",
      error: enriched
    });
    await failAdrProject({
      admin: params.admin,
      requestId: params.requestId,
      error: enriched
    });
    throw new Error(enriched);
  }
}

async function upsertAdrProject(params: {
  admin: ReturnType<typeof createClient>;
  requestId: string;
  customerUserId: string | null;
  customerEmail: string | null;
  videoUrl: string;
  targetLang: string;
  audioUrl: string;
  originalAudioUrl?: string | null;
  extractMeta?: Record<string, unknown> | null;
  audioDurationSec?: number | null;
  pipelineJobId: string;
  segments: DiarizeSegment[];
}): Promise<string | null> {
  const { speakers, cues } = buildAdrSpeakersAndCues(params.segments);
  const originalAudioUrl = String(params.originalAudioUrl || "").trim() || null;
  const extractMeta = params.extractMeta || {
    targetLang: params.targetLang,
    targetAudioUrl: params.audioUrl,
    originalAudioUrl,
    audioDurationSec: params.audioDurationSec ?? null
  };
  // Diarize fields only — do not wipe whisper_* written by the parallel job.
  const row = {
    request_id: params.requestId,
    customer_user_id: params.customerUserId,
    customer_email: params.customerEmail,
    video_url: params.videoUrl,
    target_lang: params.targetLang,
    audio_url: params.audioUrl,
    original_audio_url: originalAudioUrl,
    extract_meta: extractMeta,
    audio_duration_sec:
      params.audioDurationSec != null && Number(params.audioDurationSec) > 0
        ? Number(params.audioDurationSec)
        : null,
    pipeline_job_id: params.pipelineJobId,
    speakers,
    cues,
    status: "editing",
    updated_at: new Date().toISOString()
  };
  const { data, error } = await params.admin
    .from("adr_projects")
    .upsert(row, { onConflict: "request_id" })
    .select("id")
    .maybeSingle();
  if (error) {
    console.error("[media-pipeline] adr_projects upsert failed", error.message);
    return null;
  }
  return (data?.id as string) || null;
}

async function notifyAdrReady(params: {
  admin: ReturnType<typeof createClient>;
  requestId: string;
  customerEmail: string | null;
  targetLang: string;
}): Promise<void> {
  const email = (params.customerEmail || "").trim().toLowerCase();
  if (!email) return;
  const editorUrl = `./adr-region-editor.html?requestId=${encodeURIComponent(params.requestId)}`;
  const notificationId = `ntf_adr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const storedText = `[notify:work.notify_adr_ready]\n${JSON.stringify({
    lang: params.targetLang,
    url: editorUrl
  })}`;
  await params.admin.from("notifications_public").insert({
    id: notificationId,
    requestid: params.requestId,
    text: storedText,
    kind: "system",
    target_role: "customer",
    target_emails: [email],
    category: "case",
    target_mode: "users",
    admin_sent: false,
    read: false,
    created_at: new Date().toISOString()
  });
}

async function resolveEmailFromUserId(
  admin: ReturnType<typeof createClient>,
  userId: string | null | undefined
): Promise<string> {
  const id = String(userId || "").trim();
  if (!id) return "";
  try {
    const { data, error } = await admin.auth.admin.getUserById(id);
    if (error) {
      console.warn("[media-pipeline] getUserById failed", id, error.message);
      return "";
    }
    return String(data?.user?.email || "")
      .trim()
      .toLowerCase();
  } catch (e) {
    console.warn("[media-pipeline] getUserById threw", id, e);
    return "";
  }
}

async function notifyPipelineFailed(params: {
  admin: ReturnType<typeof createClient>;
  requestId: string | null | undefined;
  customerEmail?: string | null | undefined;
  jobId?: string | null;
  userId?: string | null;
}): Promise<void> {
  const requestId = String(params.requestId || "").trim();
  if (!requestId) return;
  try {
    let email = String(params.customerEmail || "")
      .trim()
      .toLowerCase();
    if (!email) {
      email = (await resolveCustomerEmailForRequest(params.admin, requestId)) || "";
    }
    if (!email) {
      email = await resolveEmailFromUserId(params.admin, params.userId);
    }
    if (!email) {
      console.warn("[media-pipeline] pipeline_failed skipped: no customer email", requestId);
      return;
    }
    const jobKey = String(params.jobId || "job").trim() || "job";
    await notifyCaseRecipients(params.admin, {
      requestId,
      messageKey: "pipeline_failed",
      emails: [email],
      targetRole: "customer",
      batchPrefix: `pipeline_fail_${jobKey}`
    });
  } catch (e) {
    console.warn("[media-pipeline] failure notify failed", e);
  }
}

async function finalizeRunpodDiarizeJob(params: {
  admin: ReturnType<typeof createClient>;
  job: PipelineJobRow;
  runpodJobId: string;
  startedMs: number;
  customerEmail: string | null;
}): Promise<Record<string, unknown>> {
  const rp = await getRunpodDiarizeStatus(params.runpodJobId);
  const st = String(rp.status || "").toUpperCase();
  if (st === "IN_QUEUE" || st === "IN_PROGRESS") {
    return {
      ok: true,
      jobId: params.job.id,
      mode: "diarize",
      status: "running",
      step: params.job.step || "diarize",
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
    await notifyPipelineFailed({
      admin: params.admin,
      requestId: params.job.request_id,
      customerEmail: params.customerEmail,
      jobId: params.job.id,
      userId: params.job.user_id
    });
    return { ok: false, jobId: params.job.id, status: "failed", error: msg };
  }
  if (st !== "COMPLETED" || !rp.output) {
    return {
      ok: true,
      jobId: params.job.id,
      mode: "diarize",
      status: "running",
      step: params.job.step || "diarize",
      runpodStatus: st || "UNKNOWN"
    };
  }

  let diarize: DiarizeResponse;
  try {
    diarize = normalizeDiarizeResponse(rp.output);
  } catch (normErr) {
    const msg = normErr instanceof Error ? normErr.message : String(normErr);
    await params.admin
      .from("media_pipeline_jobs")
      .update({ status: "failed", step: "error", error: msg, updated_at: new Date().toISOString() })
      .eq("id", params.job.id);
    await notifyPipelineFailed({
      admin: params.admin,
      requestId: params.job.request_id,
      customerEmail: params.customerEmail,
      jobId: params.job.id,
      userId: params.job.user_id
    });
    return { ok: false, jobId: params.job.id, status: "failed", error: msg };
  }
  const segments = Array.isArray(diarize.segments) ? diarize.segments : [];

  const durationMs = Date.now() - params.startedMs;
  const targetLang = normalizeTargetLang(params.job.target_lang || "ja");
  await persistDiarizeJob({
    admin: params.admin,
    jobId: params.job.id,
    diarize,
    audioSource: String(params.job.audio_source || "audio_url"),
    videoUrl: String(params.job.video_url || ""),
    audioUrl: String(params.job.audio_url || ""),
    targetLang,
    durationMs,
    models: {
      ...(params.job.models || {}),
      runpodJobId: params.runpodJobId
    }
  });

  let adrProjectId: string | null = null;
  const reqId = String(params.job.request_id || "").trim();
  if (reqId) {
    const jobModels = (params.job.models || {}) as Record<string, unknown>;
    const originalAudioUrl = originalAudioFromJobModels(jobModels);
    const storedMeta =
      jobModels.extractMeta && typeof jobModels.extractMeta === "object"
        ? (jobModels.extractMeta as Record<string, unknown>)
        : {};
    const extractMeta = {
      ...storedMeta,
      targetLang,
      targetAudioUrl: String(params.job.audio_url || storedMeta.targetAudioUrl || ""),
      originalAudioUrl: originalAudioUrl || storedMeta.originalAudioUrl || null,
      diarizeAudioSource: storedMeta.diarizeAudioSource || "original",
      diarizeAudioUrl:
        storedMeta.diarizeAudioUrl || jobModels.diarizeAudioUrl || originalAudioUrl || null
    };
    const audioDurationSec = Number(extractMeta.audioDurationSec);
    adrProjectId = await upsertAdrProject({
      admin: params.admin,
      requestId: reqId,
      customerUserId: params.job.user_id,
      customerEmail: params.customerEmail,
      videoUrl: String(params.job.video_url || ""),
      targetLang,
      audioUrl: String(params.job.audio_url || ""),
      originalAudioUrl,
      extractMeta,
      audioDurationSec: audioDurationSec > 0 ? audioDurationSec : null,
      pipelineJobId: params.job.id,
      segments
    });
    await notifyAdrReady({
      admin: params.admin,
      requestId: reqId,
      customerEmail: params.customerEmail,
      targetLang
    });
  }

  return diarizeJsonResponseFromJob(
    {
      ...params.job,
      status: "completed",
      step: "diarized",
      target_lang: targetLang,
      diarization_raw: diarize,
      duration_ms: durationMs
    },
    adrProjectId
  );
}

async function backgroundDiarizeJob(params: {
  admin: ReturnType<typeof createClient>;
  jobId: string;
  audioUrl: string;
  diarizeAudioUrl: string;
  originalAudioUrl?: string | null;
  extractMeta?: Record<string, unknown> | null;
  audioDurationSec?: number | null;
  videoUrl: string;
  targetLang: string;
  audioSource: string;
  requestId: string | null;
  customerEmail: string | null;
  customerUserId: string | null;
  startedMs: number;
}): Promise<void> {
  try {
    const diarizeAudioUrl = resolveAdrDiarizeAudioUrl({
      originalAudioUrl: params.diarizeAudioUrl || params.originalAudioUrl,
      targetAudioUrl: params.audioUrl
    });
    const diarize = await diarizeWithServiceFromUrl(diarizeAudioUrl);
    const segments = Array.isArray(diarize.segments) ? diarize.segments : [];
    if (!segments.length) throw new Error("話者分離の結果が空でした。");
    await persistDiarizeJob({
      admin: params.admin,
      jobId: params.jobId,
      diarize,
      audioSource: params.audioSource,
      videoUrl: params.videoUrl,
      audioUrl: params.audioUrl,
      targetLang: params.targetLang,
      durationMs: Date.now() - params.startedMs,
      models: {
        originalAudioUrl: params.originalAudioUrl || null,
        extractMeta: params.extractMeta || null,
        diarizeAudioSource: "original",
        diarizeAudioUrl
      }
    });
    if (params.requestId) {
      await upsertAdrProject({
        admin: params.admin,
        requestId: params.requestId,
        customerUserId: params.customerUserId,
        customerEmail: params.customerEmail,
        videoUrl: params.videoUrl,
        targetLang: params.targetLang,
        audioUrl: params.audioUrl,
        originalAudioUrl: params.originalAudioUrl,
        extractMeta: params.extractMeta,
        audioDurationSec: params.audioDurationSec,
        pipelineJobId: params.jobId,
        segments
      });
      await notifyAdrReady({
        admin: params.admin,
        requestId: params.requestId,
        customerEmail: params.customerEmail,
        targetLang: params.targetLang
      });
    }
  } catch (e) {
    const msg = redactRunpodHtmlError(e instanceof Error ? e.message : String(e));
    await params.admin
      .from("media_pipeline_jobs")
      .update({
        status: "failed",
        step: "error",
        error: msg,
        updated_at: new Date().toISOString()
      })
      .eq("id", params.jobId);
    await notifyPipelineFailed({
      admin: params.admin,
      requestId: params.requestId,
      customerEmail: params.customerEmail,
      jobId: params.jobId,
      userId: params.customerUserId
    });
  }
}

async function callGrokJson<T>(
  system: string,
  userText: string,
  temperature = 0.1
): Promise<T> {
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
      temperature,
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
  "行の追加・削除・順序変更は禁止。",
  "各行の意味内容を省略・要約しない（忠実翻訳）。"
].join("\n");

const GROK_TRANSLATE_USER_PREAMBLE = buildGrokTranslateUserPreamble("ja");

function resolveScriptLanguage(body?: PipelineBody | null): ScriptLanguageCode {
  return normalizeScriptLanguageCode(body?.scriptLanguage);
}

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
  extraUserHint = "",
  options: { includeAdlibRules?: boolean; scriptLanguage?: ScriptLanguageCode } = {}
): Promise<{ translation: string; lines: string[] }> {
  const lang = options.scriptLanguage ?? "ja";
  const numbered = previewLines
    .map((line, i) => `${i + 1}. ${String(line || "").trim()}`)
    .join("\n");
  const userText = [
    buildGrokTranslateUserPreamble(lang),
    numbered,
    extraUserHint ? `\n${extraUserHint}` : ""
  ]
    .filter(Boolean)
    .join("\n");

  const systemParts = [
    buildGrokTranslateLinesSystem(lang),
    "",
    "次の JSON のみを返してください:",
    '{"translation":"参考訳","lines":["1行目の吹替のみ","2行目…"]}',
    GROK_JSON_OUTPUT_RULES
  ];
  if (options.includeAdlibRules) {
    systemParts.push("", GROK_ADLIB_TRANSLATE_RULES);
  }
  const system = systemParts.join("\n");

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

async function translateSingleScriptRowWithGrok(
  sourceLine: string,
  lineNumber: number,
  totalLines: number,
  extraUserHint = "",
  scriptLanguage: ScriptLanguageCode = "ja"
): Promise<string> {
  const userText = [
    buildGrokTranslateUserPreamble(scriptLanguage),
    `1. ${String(sourceLine || "").trim()}`,
    `（全 ${totalLines} 行中 ${lineNumber} 行目。追加台詞マーカー \\uE000 \\uE001 を必ず保持してください。）`,
    extraUserHint ? `\n${extraUserHint}` : ""
  ]
    .filter(Boolean)
    .join("\n");

  const system = [
    buildGrokTranslateLinesSystem(scriptLanguage),
    "",
    GROK_ADLIB_TRANSLATE_RULES,
    "",
    "次の JSON のみを返してください:",
    '{"lines":["訳文1行のみ"]}',
    "lines は1要素のみ。\\uE000 と \\uE001 マーカーの数と順序を入力と同じにする。"
  ].join("\n");

  const parsed = await callGrokJson<{ lines?: string[] }>(system, userText, 0.05);
  const lines = Array.isArray(parsed.lines) ? parsed.lines : [];
  return String(lines[0] ?? "").trim();
}

async function translateScriptRowPartsWithGrok(
  row: ScriptRow,
  lineNumber: number,
  totalLines: number,
  extraUserHint = "",
  scriptLanguage: ScriptLanguageCode = "ja"
): Promise<string> {
  const chunks: string[] = [];
  for (const part of row.parts) {
    const src = part.kind === "adlib" ? part.text : part.text;
    if (!String(src || "").trim()) continue;
    const translated = await translateSingleScriptRowWithGrok(
      src,
      lineNumber,
      totalLines,
      extraUserHint,
      scriptLanguage
    );
    const body = stripAdlibMarkers(translated);
    if (part.kind === "adlib") {
      chunks.push(`${ADLIB_OPEN}${body}${ADLIB_CLOSE}`);
    } else {
      chunks.push(body);
    }
  }
  return chunks.join("");
}

async function translateScriptRowsWithGrok(
  sourceLines: string[],
  extraUserHint = "",
  scriptLanguage: ScriptLanguageCode = "ja"
): Promise<{ translation: string; lines: string[] }> {
  const hasAdlib = sourceLines.some((l) => /\uE000|【ADLIB】/.test(l));
  const { translation, lines } = await translatePreviewLinesWithGrok(sourceLines, extraUserHint, {
    includeAdlibRules: hasAdlib,
    scriptLanguage
  });

  if (!hasAdlib) return { translation, lines };

  const out = [...lines];
  for (let i = 0; i < sourceLines.length; i++) {
    if (adlibMarkersPreserved(sourceLines[i], out[i] || "")) continue;
    const retried = await translateSingleScriptRowWithGrok(
      sourceLines[i],
      i + 1,
      sourceLines.length,
      extraUserHint,
      scriptLanguage
    );
    if (retried && adlibMarkersPreserved(sourceLines[i], retried)) {
      out[i] = retried;
      continue;
    }
    throw new Error(
      `行 ${i + 1} の追加台詞マーカーを翻訳後も保持できませんでした。入力行: ${sourceLines[i].slice(0, 80)}`
    );
  }
  return { translation, lines: out };
}

async function translatePreviewLinesWithGrok(
  previewLines: string[],
  extraUserHint = "",
  options: { includeAdlibRules?: boolean; scriptLanguage?: ScriptLanguageCode } = {}
): Promise<{ translation: string; lines: string[] }> {
  const lines = previewLines.map((l) => String(l ?? "").trim());
  if (!lines.length) {
    return { translation: "", lines: [] };
  }

  const chunks = chunkPreviewLinesForGrok(lines);
  if (chunks.length <= 1) {
    return translatePreviewLinesBatchWithGrok(lines, extraUserHint, options);
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
    const { translation, lines: batchLines } = await translatePreviewLinesBatchWithGrok(
      chunk,
      batchHint,
      options
    );
    if (translation) refParts.push(translation);
    allLines.push(...batchLines);
    offset += chunk.length;
  }
  return { translation: refParts.join("\n").trim(), lines: allLines };
}

async function translateWhisperTimelineWithGrok(
  whisperTimeline: string,
  extraUserHint = ""
): Promise<{ translation: string; lines: string[]; script: string }> {
  const canon = parseBracketTimelineText(whisperTimeline);
  const sourceLines = canon.map((r) => r.text);
  const numbered = sourceLines
    .map((line, i) => `${i + 1}. ${String(line || "").trim()}`)
    .join("\n");
  const userText = [
    GROK_TRANSLATE_USER_PREAMBLE,
    numbered,
    extraUserHint ? `\n${extraUserHint}` : ""
  ]
    .filter(Boolean)
    .join("\n");

  const system = [
    GROK_TRANSLATE_LINES_SYSTEM,
    "",
    "次の JSON のみを返してください:",
    '{"translation":"参考訳","lines":["1行目の吹替のみ","2行目…"]}',
    GROK_JSON_OUTPUT_RULES
  ].join("\n");

  const parsed = await callGrokJson<{ translation?: string; lines?: string[] }>(
    system,
    userText
  );
  let lines = Array.isArray(parsed.lines)
    ? parsed.lines.map((l) => String(l ?? "").trim())
    : [];
  if (lines.length > sourceLines.length) {
    lines = lines.slice(0, sourceLines.length);
  }
  while (lines.length < sourceLines.length) {
    lines.push("");
  }
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

function loadAlignWordsFromJobRaw(raw: Record<string, unknown> | null | undefined): AlignWord[] {
  if (!raw) return [];
  const fromAlign = normalizeAlignWords(raw.alignWords);
  if (fromAlign.length) return fromAlign;
  return normalizeAlignWords(raw.words);
}

async function loadAlignWordsFromTranscribeJob(
  admin: ReturnType<typeof createClient>,
  jobId: string,
  opts?: { alignWordsOnly?: boolean }
): Promise<{
  words: AlignWord[];
  durationSec: number;
  displayText: string;
  silenceGaps: SilenceGap[];
  roughSegments: WhisperSeg[];
  segments: WhisperSeg[];
}> {
  const { data: row, error } = await admin
    .from("media_pipeline_jobs")
    .select("whisper_raw, whisper_transcript")
    .eq("id", jobId)
    .maybeSingle();
  if (error || !row) {
    throw new Error("文字起こしジョブが見つかりません。先に WhisperX で文字起こししてください。");
  }
  const raw = (row.whisper_raw || {}) as Record<string, unknown>;
  const words = loadAlignWordsFromJobRaw(raw);
  if (!words.length) {
    throw new Error(
      "単語タイムコードがありません。文字起こしからやり直してください（WhisperX alignWords が必要です）。"
    );
  }
  const durationSec = Number(raw.duration) > 0 ? Number(raw.duration) : Math.max(...words.map((w) => w.end));
  const displayText =
    typeof raw.displayText === "string" && raw.displayText.trim()
      ? String(raw.displayText).trim()
      : String(row.whisper_transcript || raw.text || "").trim();
  if (opts?.alignWordsOnly) {
    return {
      words,
      durationSec,
      displayText,
      silenceGaps: [],
      roughSegments: [],
      segments: [],
    };
  }
  return {
    words,
    durationSec,
    displayText,
    silenceGaps: normalizeSilenceGapsFromRaw(raw.silenceGaps),
    roughSegments: normalizeWhisperSegmentsFromRaw(raw.roughSegments),
    segments: normalizeWhisperSegmentsFromRaw(raw.segments),
  };
}

async function loadScriptReconcileInputs(
  body: PipelineBody,
  admin: ReturnType<typeof createClient>,
  opts?: { alignWordsOnly?: boolean }
): Promise<{
  speakers: SpeakerInput[];
  alignWords: AlignWord[];
  transcribeDurationSec: number;
  transcriptPlainAtWhisper: string;
  reconcileTiming: ReconcileTimingOptions | undefined;
  whisperSegments: WhisperSeg[];
}> {
  const speakers = normalizeSpeakers(body);
  if (!speakers.length) {
    throw new Error("speakers に、話者 id と lines（1行以上）が必要です。");
  }

  const transcribeJobId = String(body.transcribeJobId || "").trim();
  let alignWords: AlignWord[] = [];
  let transcribeDurationSec = Number(body.whisperDurationSec) > 0 ? Number(body.whisperDurationSec) : 0;
  let transcriptPlainAtWhisper = String(body.transcriptPlainAtWhisper || "").trim();
  let reconcileTiming: ReconcileTimingOptions | undefined;

  if (transcribeJobId) {
    const loaded = await loadAlignWordsFromTranscribeJob(admin, transcribeJobId, {
      alignWordsOnly: Boolean(opts?.alignWordsOnly),
    });
    alignWords = loaded.words;
    if (!transcribeDurationSec) transcribeDurationSec = loaded.durationSec;
    if (!transcriptPlainAtWhisper) transcriptPlainAtWhisper = loaded.displayText;
    reconcileTiming = opts?.alignWordsOnly
      ? { durationSec: loaded.durationSec }
      : {
          durationSec: loaded.durationSec,
          silenceGaps: loaded.silenceGaps,
          roughSegments: loaded.roughSegments,
          segments: loaded.segments,
        };
  }

  const whisperSegments = normalizeWhisperSegsForGrok(body.whisperSegments);
  if (!alignWords.length && !whisperSegments.length) {
    throw new Error(
      "transcribeJobId（単語タイムコード付き文字起こしジョブ）が必要です。先に WhisperX で文字起こししてください。"
    );
  }

  return {
    speakers,
    alignWords,
    transcribeDurationSec,
    transcriptPlainAtWhisper,
    reconcileTiming,
    whisperSegments,
  };
}

function plainLineFromRow(row: ScriptRow): string {
  return stripAdlibMarkers(rowToGrokLine(row));
}

function adlibSegmentsFromRows(rows: ScriptRow[]): Array<{ speakerIndex: number; text: string }> {
  const out: Array<{ speakerIndex: number; text: string }> = [];
  for (const row of rows) {
    const sp = Number(row.speakerIndex) || 0;
    for (const part of row.parts) {
      if (part.kind === "adlib" && String(part.text || "").trim()) {
        out.push({ speakerIndex: sp, text: String(part.text).trim() });
      }
    }
  }
  return out;
}

function formatReconciledScriptsFromPipeline(
  pipeline: ReturnType<typeof buildReconciledScriptPipeline>,
  speakerMeta: { id: number; label: string }[]
): {
  scriptsBySpeaker: Record<string, string>;
  chronologicalScript: string;
  grokSourceLinesBySpeaker: Record<number, string[]>;
  adlibSegments: Array<{ speakerIndex: number; text: string }>;
  adlibSpans: ReturnType<typeof buildReconciledScriptPipeline>["adlibSpans"];
} {
  const labelById = Object.fromEntries(
    speakerMeta.map((s) => [s.id, (s.label && String(s.label).trim()) || `話者${s.id}`])
  );

  const speakerIds = Object.keys(pipeline.rowsBySpeaker)
    .map((k) => Number(k))
    .filter((n) => Number.isFinite(n) && n >= 1)
    .sort((a, b) => a - b);

  const scriptsBySpeaker: Record<string, string> = {};
  const chronoPairs: { row: ScriptRow; line: string }[] = [];
  const grokSourceLinesBySpeaker: Record<number, string[]> = {};
  const adlibSegments: Array<{ speakerIndex: number; text: string }> = [];

  for (const sp of speakerIds) {
    const rows = pipeline.rowsBySpeaker[sp] || [];
    const plainLines = rows.map(plainLineFromRow);
    const sourceLines = pipeline.grokSourceLinesBySpeaker[sp] || rows.map(rowToGrokLine);
    grokSourceLinesBySpeaker[sp] = sourceLines;
    scriptsBySpeaker[String(sp)] = formatScriptRowsBlock(rows, plainLines);
    adlibSegments.push(...adlibSegmentsFromRows(rows));
    rows.forEach((row, i) => {
      chronoPairs.push({ row, line: plainLines[i] || plainLineFromRow(row) });
    });
  }

  chronoPairs.sort((a, b) => {
    const ta = a.row.startSec ?? 0;
    const tb = b.row.startSec ?? 0;
    if (Math.abs(ta - tb) > 0.001) return ta - tb;
    return (a.row.speakerIndex ?? 0) - (b.row.speakerIndex ?? 0);
  });

  const chronologicalScript = formatScriptRowsBlock(
    chronoPairs.map((p) => p.row),
    chronoPairs.map((p) => p.line),
    labelById
  );

  if (!chronologicalScript.trim()) {
    throw new Error("話者割り当てから時系列台本を組み立てられませんでした。");
  }

  return {
    scriptsBySpeaker,
    chronologicalScript,
    grokSourceLinesBySpeaker,
    adlibSegments,
    adlibSpans: pipeline.adlibSpans ?? [],
  };
}

function reconcileScriptBySpeakers(params: {
  speakers: SpeakerInput[];
  durationSec?: number;
  transcriptPlain?: string;
  transcriptPlainAtWhisper?: string;
  speakerCount?: number;
  assignRanges?: {
    start: number;
    end: number;
    speakerIndex: number;
    text?: string;
    startSec?: number;
    endSec?: number;
  }[];
  alignWords?: AlignWord[];
  reconcileTiming?: ReconcileTimingOptions;
  /** assign-plain = 顧客下書き（割当テキストそのまま） / full = Grok 用 reconcile */
  draftMode?: "assign-plain" | "full";
}): ReturnType<typeof formatReconciledScriptsFromPipeline> & {
  pipeline: ReturnType<typeof buildReconciledScriptPipeline>;
} {
  const assignRanges = Array.isArray(params.assignRanges) ? params.assignRanges : [];
  const transcriptPlain = String(params.transcriptPlain || "").trim();
  const hasAlignWords = Array.isArray(params.alignWords) && params.alignWords.length > 0;

  if (!hasAlignWords) {
    throw new Error("単語タイムコード付き台本の下書きには、話者割り当てと編集テキストが必要です。");
  }
  if (!assignRanges.length || !transcriptPlain) {
    throw new Error("話者割り当てと編集済み文字起こしが必要です。");
  }

  const dur = Number(params.durationSec) > 0 ? Number(params.durationSec) : 0;
  const speakerMeta = params.speakers.map((s) => ({
    id: s.id,
    label: (s.label && String(s.label).trim()) || `話者${s.id}`,
  }));

  const originalPlain =
    joinAlignWordsCompactText(params.alignWords!) ||
    String(params.transcriptPlainAtWhisper || "").trim() ||
    joinAlignWordsDisplayText(params.alignWords!);

  const pipeline =
    params.draftMode === "assign-plain"
      ? buildAssignRangeDraftPipeline({
          words: params.alignWords!,
          editedPlain: transcriptPlain,
          assignRanges,
        })
      : buildReconciledScriptPipeline({
          words: params.alignWords!,
          originalPlain,
          editedPlain: transcriptPlain,
          assignRanges,
          timing: {
            durationSec: dur,
            silenceGaps: params.reconcileTiming?.silenceGaps,
            roughSegments: params.reconcileTiming?.roughSegments,
            segments: params.reconcileTiming?.segments,
            clipWords: params.reconcileTiming?.clipWords,
          },
        });

  if (!pipeline.rows.length) {
    throw new Error("編集テキストと単語タイムコードの照合に失敗しました。");
  }

  return {
    pipeline,
    ...formatReconciledScriptsFromPipeline(pipeline, speakerMeta),
  };
}

async function scriptBySpeakersWithGrok(params: {
  whisperSegments: WhisperSeg[];
  speakers: SpeakerInput[];
  tone?: string;
  durationSec?: number;
  whisperTimeline?: string;
  transcriptPlain?: string;
  transcriptPlainAtWhisper?: string;
  speakerCount?: number;
  assignRanges?: {
    start: number;
    end: number;
    speakerIndex: number;
    startSec?: number;
    endSec?: number;
  }[];
  alignWords?: AlignWord[];
  reconcileTiming?: ReconcileTimingOptions;
  scriptLanguage?: ScriptLanguageCode;
}): Promise<{
  scriptsBySpeaker: Record<string, string>;
  referenceTranslation: string;
  translatedLines: string[];
  chronologicalScript: string;
  adlibSegments: Array<{ speakerIndex: number; text: string }>;
}> {
  const scriptLanguage = params.scriptLanguage ?? "ja";
  const assignRanges = Array.isArray(params.assignRanges) ? params.assignRanges : [];
  const transcriptPlain = String(params.transcriptPlain || "").trim();
  const hasAlignWords = Array.isArray(params.alignWords) && params.alignWords.length > 0;
  const hasWhisperSegments =
    Array.isArray(params.whisperSegments) && params.whisperSegments.length > 0;

  if (!hasAlignWords && !hasWhisperSegments) {
    throw new Error("whisperSegments が空です。");
  }

  const toneHint = (params.tone || "").trim() ? `希望トーン: ${params.tone.trim()}` : "";
  const dur = Number(params.durationSec) > 0 ? Number(params.durationSec) : 0;
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

  if (assignRanges.length && transcriptPlain && params.alignWords?.length) {
    const { pipeline } = reconcileScriptBySpeakers({
      speakers: params.speakers,
      durationSec: dur,
      transcriptPlain,
      transcriptPlainAtWhisper: params.transcriptPlainAtWhisper,
      speakerCount,
      assignRanges,
      alignWords: params.alignWords,
      reconcileTiming: params.reconcileTiming,
    });

    const labelById = Object.fromEntries(
      speakerMeta.map((s) => [
        s.id,
        (s.label && String(s.label).trim()) || `話者${s.id}`
      ])
    );

    const speakerIds = Object.keys(pipeline.rowsBySpeaker)
      .map((k) => Number(k))
      .filter((n) => Number.isFinite(n) && n >= 1)
      .sort((a, b) => a - b);

    const linesBySpeaker: Record<number, string[]> = {};
    const translationParts: string[] = [];
    const adlibSegments: Array<{ speakerIndex: number; text: string }> = [];

    for (const sp of speakerIds) {
      const rows = pipeline.rowsBySpeaker[sp] || [];
      const sourceLines = pipeline.grokSourceLinesBySpeaker[sp] || [];
      if (!sourceLines.length) continue;
      const spLabel = labelById[sp] || `話者${sp}`;
      const spMeta = speakerMeta.find((s) => s.id === sp);
      const spHintOnly = spMeta
        ? speakerAssignmentToPlainTextSingle(spMeta)
        : `話者${sp}（${spLabel}）`;
      const hint = [
        spHintOnly,
        `【翻訳対象】話者${sp}（${spLabel}）に割り当てられた行だけです。`,
        "入力行に存在しない他話者のセリフ・単語は一切出力しないでください。",
        `話者${sp}の行だけを、入力順のまま1行ずつ翻訳してください（行の統合・分割・順序変更禁止）。`,
        "各行はセリフ本文のみ。話者名 (てつや) などのラベルは付けないでください。",
        buildTranslateFidelityHint(scriptLanguage),
        `${GROK_ADLIB_TRANSLATE_RULES}`,
        toneHint
      ]
        .filter(Boolean)
        .join("\n");

      const { translation, lines } = await translateScriptRowsWithGrok(sourceLines, hint, scriptLanguage);
      const finalLines: string[] = [];

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const src = sourceLines[i] || rowToGrokLine(row);
        let line = String(lines[i] ?? "").trim();

        if (row.parts.some((p) => p.kind === "adlib")) {
          if (!adlibMarkersPreserved(src, line)) {
            line = await translateScriptRowPartsWithGrok(row, i + 1, rows.length, hint, scriptLanguage);
          }
          for (const t of extractAdlibTextsFromTranslatedLine(line)) {
            if (t.trim()) adlibSegments.push({ speakerIndex: sp, text: t.trim() });
          }
        }

        finalLines.push(line || rowToGrokLine(row));
      }

      linesBySpeaker[sp] = finalLines;
      if (translation?.trim()) {
        translationParts.push(`【話者${sp} ${spLabel}】\n${translation.trim()}`);
      }
    }

    const referenceTranslation = translationParts.join("\n\n");

    const scriptsBySpeaker: Record<string, string> = {};
    const chronoPairs: { row: ScriptRow; line: string }[] = [];

    for (const sp of speakerIds) {
      const rows = pipeline.rowsBySpeaker[sp] || [];
      const lines = linesBySpeaker[sp] || rows.map(rowToGrokLine);
      scriptsBySpeaker[String(sp)] = formatScriptRowsBlock(rows, lines);
      rows.forEach((row, i) => {
        chronoPairs.push({
          row,
          line: String(lines[i] ?? rowToGrokLine(row)).trim() || rowToGrokLine(row)
        });
      });
    }

    chronoPairs.sort((a, b) => {
      const ta = a.row.startSec ?? 0;
      const tb = b.row.startSec ?? 0;
      if (Math.abs(ta - tb) > 0.001) return ta - tb;
      return (a.row.speakerIndex ?? 0) - (b.row.speakerIndex ?? 0);
    });

    const chronologicalScript = formatScriptRowsBlock(
      chronoPairs.map((p) => p.row),
      chronoPairs.map((p) => p.line),
      labelById
    );

    const translatedLines = chronoPairs.map((p) => p.line);

    if (!chronologicalScript.trim()) {
      throw new Error("話者割り当てから時系列台本を組み立てられませんでした。");
    }

    return {
      scriptsBySpeaker,
      referenceTranslation,
      translatedLines,
      chronologicalScript,
      adlibSegments
    };
  }

  if (hasAlignWords) {
    throw new Error(
      "単語タイムコード付き台本生成には、話者割り当てと編集テキストが必要です。"
    );
  }

  if (assignRanges.length && transcriptPlain) {
    const whisperTimeline =
      params.whisperTimeline?.trim() ||
      whisperSegmentsToBracketTimelineText(params.whisperSegments, dur);
    if (!whisperTimeline.trim()) {
      throw new Error(
        "Whisper タイムラインがありません。文字起こしからやり直してください。"
      );
    }

    const chronoCues = buildChronologicalTimedCuesFromAssignRanges(
      transcriptPlain,
      assignRanges,
      speakerCount,
      speakerMeta.map(({ id, label }) => ({ id, label })),
      {
        whisperTimeline,
        whisperSegments: params.whisperSegments,
        durationSec: dur
      }
    );
    if (!chronoCues.length) {
      throw new Error("話者割り当てから時系列キューを組み立てられませんでした。");
    }

    const timelinePlain = buildPlainFromWhisperTimeline(whisperTimeline);
    const plainNorm = normalizePreviewTextForCompare(transcriptPlain);
    const timelineNorm = normalizePreviewTextForCompare(timelinePlain);
    if (timelinePlain && plainNorm !== timelineNorm) {
      console.warn("[wavrick] transcriptPlain と whisperTimeline の本文が一致しません", {
        transcriptLen: plainNorm.length,
        timelineLen: timelineNorm.length
      });
    }

    const sourceLines = chronoCues.map((c) => c.text);
    const hint = [
      speakerPlain,
      "【重要】入力行は動画の時系列順です。行数・順序を変えないでください。",
      "各行はセリフ本文のみ。話者名 (てつや) などのラベルは付けないでください。",
      buildTranslateFidelityHint(scriptLanguage),
      toneHint
    ]
      .filter(Boolean)
      .join("\n");
    const { translation: referenceTranslation, lines } =
      await translatePreviewLinesWithGrok(sourceLines, hint, { scriptLanguage });
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
      chronologicalScript,
      adlibSegments: []
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
    chronologicalScript,
    adlibSegments: []
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
    body.mode === "adr-prepare" ||
    body.mode === "status" ||
    body.mode === "script" ||
    body.mode === "script-reconcile" ||
    body.mode === "full"
      ? body.mode
      : "full";
  const videoUrl = (body.videoUrl || "").trim();
  const audioUrl = (body.audioUrl || "").trim();
  const requestId = (body.requestId || "").trim() || null;
  const targetLang = normalizeTargetLang(body.targetLang || body.scriptLanguage);
  const customerEmail = (body.customerEmail || "").trim().toLowerCase() || null;

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
        "id, user_id, request_id, video_url, audio_url, audio_source, status, step, error, whisper_transcript, whisper_raw, training_bundle, models, duration_ms, pipeline_kind, target_lang, diarization_raw"
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
    const isV3Diarize = String(row.pipeline_kind || "") === "v3_diarize";

    if (isV3Diarize && row.status === "completed" && row.diarization_raw) {
      let adrProjectId: string | null = null;
      if (row.request_id) {
        const { data: adrRow } = await admin
          .from("adr_projects")
          .select("id")
          .eq("request_id", row.request_id)
          .maybeSingle();
        adrProjectId = (adrRow?.id as string) || null;
      }
      try {
        return jsonResponse(diarizeJsonResponseFromJob(row, adrProjectId));
      } catch (normErr) {
        const msg = normErr instanceof Error ? normErr.message : String(normErr);
        return jsonResponse(
          { ok: false, jobId: row.id, status: "failed", error: msg, pipelineKind: "v3_diarize" },
          422
        );
      }
    }

    if (!isV3Diarize && row.status === "completed" && row.whisper_transcript) {
      return jsonResponse(transcribeJsonResponseFromJob(row));
    }
    if (row.status === "failed") {
      return jsonResponse(
        {
          ok: false,
          jobId: row.id,
          status: "failed",
          error: isV3Diarize
            ? redactRunpodHtmlError(row.error || "話者分離に失敗しました。")
            : (row.error || "文字起こしに失敗しました。")
        },
        422
      );
    }

    const runpodJobId = modelsRunpodJobId(row.models);
    // v3 diarize uses Load Balancer POST /diarize by default. Queue /status is only
    // valid when RUNPOD_WHISPERX_QUEUE_DIARIZE is explicitly enabled on a Queue endpoint.
    if (runpodJobId && isV3Diarize && isDiarizeAsyncCapable()) {
      try {
        const result = await finalizeRunpodDiarizeJob({
          admin,
          job: row,
          runpodJobId,
          startedMs: started,
          customerEmail
        });
        const httpStatus = result.ok === false ? 422 : 200;
        return jsonResponse(result, httpStatus);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return jsonResponse({ ok: false, jobId: row.id, status: "running", error: msg }, 200);
      }
    }

    if (runpodJobId && !isV3Diarize) {
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
      mode: isV3Diarize ? "diarize" : "transcribe",
      status: row.status === "running" ? "running" : row.status || "running",
      step: row.step || (isV3Diarize ? "diarize" : "whisperx")
    });
  }

  if (mode === "adr-prepare") {
    if (!videoUrl) {
      return jsonResponse({ ok: false, error: "adr-prepare には videoUrl が必要です。" }, 400);
    }
    if (!extractYouTubeVideoId(videoUrl)) {
      return jsonResponse({ ok: false, error: "YouTube の動画URLとして解釈できませんでした。", errorCode: "INVALID_VIDEO_URL" }, 400);
    }
    if (!requestId) {
      return jsonResponse({ ok: false, error: "adr-prepare には requestId が必要です。" }, 400);
    }
    if (!targetLang) {
      return jsonResponse(
        { ok: false, error: "翻訳先言語（吹替トラック）を選択してください。" },
        400
      );
    }
    if (!isRunpodWhisperxMode() && !Deno.env.get("WHISPERX_SERVICE_URL")) {
      return jsonResponse(
        { ok: false, error: "v3 ADR には WhisperX サービス（話者分離）の設定が必要です。" },
        400
      );
    }

    const adrGuard = await guardYouTubeVideoExtract(req, admin, videoUrl, userId);
    if (!adrGuard.ok) {
      const extra =
        adrGuard.retryAfterSec != null ? rateLimitResponseHeaders(adrGuard.retryAfterSec) : {};
      return jsonResponse(adrGuard.body, adrGuard.status, extra);
    }

    const { data: adrJob, error: adrInsErr } = await admin
      .from("media_pipeline_jobs")
      .insert({
        user_id: userId,
        request_id: requestId,
        video_url: videoUrl,
        audio_url: null,
        audio_source: "youtube_proxy",
        status: "running",
        step: "extract",
        pipeline_kind: "v3_diarize",
        target_lang: targetLang,
        models: customerEmail ? { customerEmail } : {}
      })
      .select("id")
      .single();

    if (adrInsErr || !adrJob?.id) {
      return jsonResponse({ ok: false, error: adrInsErr?.message || "ジョブの作成に失敗しました。" }, 500);
    }

    const adrJobId = adrJob.id as string;
    const adrVideoId = extractYouTubeVideoId(videoUrl) || "upload";
    const adrTargetPath = pipelineRawAudioPath(userId, adrJobId, `${adrVideoId}_${targetLang}`);
    const adrOriginalPath = pipelineRawAudioPath(userId, adrJobId, `${adrVideoId}_original`);

    const adrPrepareErrorCode = (msg: string): string | undefined => {
      if (msg.includes("WRONG_LANGUAGE_TRACK")) return "WRONG_LANGUAGE_TRACK";
      if (msg.includes("NO_ORIGINAL_TRACK")) return "NO_ORIGINAL_TRACK";
      if (msg.includes("SAME_AS_ORIGINAL")) return "SAME_AS_ORIGINAL";
      if (msg.includes("NO_LANGUAGE_TRACK")) return "NO_LANGUAGE_TRACK";
      return undefined;
    };

    // Dual YouTube extract often exceeds Edge HTTP wall-clock. Return jobId
    // immediately and finish extract → language gate → diarize in waitUntil.
    const runAdrPrepareBackground = async (): Promise<void> => {
      try {
        const dubAudit = {
          userId,
          channelId: adrGuard.channelId,
          videoId: adrVideoId
        };

        // Yesterday-style: dub first, then lightweight default audio (no parallel heavy original probe).
        let extracted: ProxyStorageResult & { cached?: boolean };
        try {
          extracted = await fetchProxyAudioToStorageCached(
            admin,
            videoUrl,
            adrTargetPath,
            false,
            targetLang,
            { requireDubTrack: true },
            dubAudit
          );
        } catch (firstErr) {
          const firstMsg =
            firstErr instanceof Error ? firstErr.message : String(firstErr);
          if (
            isYouTubeExtractTestMode() &&
            firstMsg.includes("NO_LANGUAGE_TRACK")
          ) {
            console.warn(
              "[media-pipeline] test mode — retry adr dub extract without requireDubTrack"
            );
            extracted = await fetchProxyAudioToStorageCached(
              admin,
              videoUrl,
              adrTargetPath,
              false,
              targetLang,
              { requireDubTrack: false },
              dubAudit
            );
          } else {
            throw firstErr;
          }
        }

        const originalExtracted = await fetchProxyAudioToStorageCached(
          admin,
          videoUrl,
          adrOriginalPath,
          false,
          undefined,
          undefined,
          {
            userId,
            channelId: adrGuard.channelId,
            videoId: adrVideoId
          }
        );
        if (!originalExtracted.publicUrl) {
          throw new Error(
            "[NO_ORIGINAL_TRACK] オリジナル（原盤）音声の抽出に失敗しました。URL が空です。"
          );
        }
        assertDistinctTargetLangAudio(targetLang, extracted, originalExtracted);

        const originalAudioUrl =
          originalExtracted.publicUrl && originalExtracted.publicUrl !== extracted.publicUrl
            ? originalExtracted.publicUrl
            : null;
        if (!originalAudioUrl) {
          throw new Error(
            "[NO_ORIGINAL_TRACK] オリジナル音声 URL が翻訳先音声と同じでした。原盤トラックの取得に失敗しています。"
          );
        }
        const diarizeAudioUrl = resolveAdrDiarizeAudioUrl({
          originalAudioUrl,
          targetAudioUrl: extracted.publicUrl
        });
        const extractMeta = {
          targetLang,
          targetAudioUrl: extracted.publicUrl,
          originalAudioUrl,
          diarizeAudioSource: "original",
          diarizeAudioUrl,
          audioDurationSec: extracted.audioDurationSec ?? null,
          originalAudioDurationSec: originalExtracted.audioDurationSec ?? null,
          targetByteLength: extracted.byteLength ?? null,
          originalByteLength: originalExtracted.byteLength ?? null,
          targetFormatId: extracted.selectedFormatId ?? null,
          originalFormatId: originalExtracted.selectedFormatId ?? null
        };

        await admin
          .from("media_pipeline_jobs")
          .update({
            status: "audio_ready",
            step: "audio_ready",
            audio_url: extracted.publicUrl,
            audio_source: "youtube_proxy_storage",
            error: null,
            models: {
              originalAudioUrl,
              extractMeta,
              dualExtract: true
            },
            updated_at: new Date().toISOString()
          })
          .eq("id", adrJobId);

        await ensureAdrProjectStub({
          admin,
          requestId,
          customerUserId: userId,
          customerEmail,
          videoUrl,
          targetLang,
          audioUrl: extracted.publicUrl,
          originalAudioUrl,
          extractMeta,
          audioDurationSec: extracted.audioDurationSec ?? null,
          pipelineJobId: adrJobId
        });
        await admin
          .from("media_pipeline_jobs")
          .update({
            status: "running",
            step: "language_gate",
            updated_at: new Date().toISOString()
          })
          .eq("id", adrJobId);

        await gateAdrTargetAudioLanguage({
          admin,
          requestId,
          audioUrl: extracted.publicUrl,
          targetLang,
          selectedFormatId: extracted.selectedFormatId
        });

        if (isDiarizeAsyncCapable()) {
          const submitted = await submitRunpodDiarizeAsync(diarizeAudioUrl);
          await admin
            .from("media_pipeline_jobs")
            .update({
              status: "running",
              step: "diarize",
              models: {
                runpodJobId: submitted.id,
                diarizeMode: "async",
                diarizeAudioSource: "original",
                diarizeAudioUrl,
                originalAudioUrl,
                extractMeta,
                dualExtract: true,
                languageGate: "passed"
              },
              updated_at: new Date().toISOString()
            })
            .eq("id", adrJobId);
          return;
        }

        await admin
          .from("media_pipeline_jobs")
          .update({ step: "diarize", updated_at: new Date().toISOString() })
          .eq("id", adrJobId);

        await backgroundDiarizeJob({
          admin,
          jobId: adrJobId,
          audioUrl: extracted.publicUrl,
          diarizeAudioUrl,
          originalAudioUrl,
          extractMeta,
          audioDurationSec: extracted.audioDurationSec ?? null,
          videoUrl,
          targetLang,
          audioSource: "youtube_proxy_storage",
          requestId,
          customerEmail,
          customerUserId: userId,
          startedMs: started
        });
      } catch (e) {
        const msg = redactRunpodHtmlError(e instanceof Error ? e.message : String(e));
        console.error("[media-pipeline] adr-prepare background failed", msg);
        await admin
          .from("media_pipeline_jobs")
          .update({
            status: "failed",
            step: "error",
            error: msg,
            updated_at: new Date().toISOString()
          })
          .eq("id", adrJobId);
        await failAdrProject({ admin, requestId, error: msg });
        await notifyPipelineFailed({
          admin,
          requestId,
          customerEmail,
          jobId: adrJobId,
          userId
        });
      }
    };

    if (typeof EdgeRuntime !== "undefined") {
      EdgeRuntime.waitUntil(runAdrPrepareBackground());
      return jsonResponse({
        ok: true,
        jobId: adrJobId,
        mode: "adr-prepare",
        pipelineKind: "v3_diarize",
        status: "running",
        step: "extract",
        async: true,
        targetLang,
        requestId
      });
    }

    await runAdrPrepareBackground();
    const { data: doneJob } = await admin
      .from("media_pipeline_jobs")
      .select(
        "id, status, step, error, audio_url, video_url, target_lang, diarization_raw, duration_ms, models"
      )
      .eq("id", adrJobId)
      .maybeSingle();
    if (!doneJob || doneJob.status === "failed") {
      const msg = String(doneJob?.error || "ADR 準備に失敗しました。");
      const errorCode = adrPrepareErrorCode(msg);
      return jsonResponse(
        { ok: false, jobId: adrJobId, error: msg, ...(errorCode ? { errorCode } : {}) },
        422
      );
    }
    const models = (doneJob.models || {}) as Record<string, unknown>;
    const originalAudioUrl = String(models.originalAudioUrl || "").trim() || null;
    const extractMeta = (models.extractMeta as Record<string, unknown> | undefined) || undefined;
    if (doneJob.status === "completed" && doneJob.diarization_raw) {
      const { data: proj } = await admin
        .from("adr_projects")
        .select("id")
        .eq("request_id", requestId)
        .maybeSingle();
      return jsonResponse({
        ...diarizeJsonResponseFromJob(doneJob as PipelineJobRow, (proj?.id as string) || null),
        originalAudioUrl,
        extractMeta
      });
    }
    return jsonResponse({
      ok: true,
      jobId: adrJobId,
      mode: "adr-prepare",
      pipelineKind: "v3_diarize",
      status: doneJob.status || "running",
      step: doneJob.step || "extract",
      async: true,
      targetLang,
      rawAudioUrl: doneJob.audio_url || null,
      originalAudioUrl,
      requestId
    });
  }

  if (mode === "script-reconcile") {
    try {
      const {
        speakers,
        alignWords,
        transcribeDurationSec,
        transcriptPlainAtWhisper,
        reconcileTiming,
      } = await loadScriptReconcileInputs(body, admin, { alignWordsOnly: true });
      const scriptDur =
        transcribeDurationSec > 0
          ? transcribeDurationSec
          : Number(body.whisperDurationSec) > 0
            ? Number(body.whisperDurationSec)
            : 0;
      const reconciled = reconcileScriptBySpeakers({
        speakers,
        durationSec: scriptDur,
        transcriptPlain: String(body.transcriptPlain || "").trim() || undefined,
        transcriptPlainAtWhisper: transcriptPlainAtWhisper || undefined,
        speakerCount: Number(body.speakerCount) || speakers.length,
        assignRanges: Array.isArray(body.assignRanges) ? body.assignRanges : undefined,
        alignWords,
        reconcileTiming,
        draftMode: "assign-plain",
      });
      const durationMs = Date.now() - started;
      return jsonResponse({
        ok: true,
        mode: "script-reconcile",
        scriptsBySpeaker: reconciled.scriptsBySpeaker,
        script: reconciled.chronologicalScript,
        chronologicalScript: reconciled.chronologicalScript,
        adlibSegments: reconciled.adlibSegments,
        adlibSpans: reconciled.adlibSpans,
        timecodedByWhisper: true,
        sourceOnly: true,
        durationMs,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return jsonResponse({ ok: false, error: msg }, 422);
    }
  }

  if (mode === "script") {
    let speakers: SpeakerInput[];
    let alignWords: AlignWord[];
    let transcribeDurationSec: number;
    let transcriptPlainAtWhisper: string;
    let reconcileTiming: ReconcileTimingOptions | undefined;
    let whisperSegments: WhisperSeg[];
    try {
      const loaded = await loadScriptReconcileInputs(body, admin);
      speakers = loaded.speakers;
      alignWords = loaded.alignWords;
      transcribeDurationSec = loaded.transcribeDurationSec;
      transcriptPlainAtWhisper = loaded.transcriptPlainAtWhisper;
      reconcileTiming = loaded.reconcileTiming;
      whisperSegments = loaded.whisperSegments;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return jsonResponse({ ok: false, error: msg }, 400);
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
        transcribeDurationSec > 0
          ? transcribeDurationSec
          : Number(body.whisperDurationSec) > 0
            ? Number(body.whisperDurationSec)
            : whisperAudioDurationSec(null, whisperSegments);
      const whisperTimeline = resolveWhisperTimeline(body, whisperSegments, scriptDur);
      const scriptLanguage = resolveScriptLanguage(body);
      const grok = await scriptBySpeakersWithGrok({
        whisperSegments,
        speakers,
        tone: body.tone,
        durationSec: scriptDur,
        whisperTimeline,
        transcriptPlain: String(body.transcriptPlain || "").trim() || undefined,
        transcriptPlainAtWhisper: transcriptPlainAtWhisper || undefined,
        speakerCount: Number(body.speakerCount) || speakers.length,
        assignRanges: Array.isArray(body.assignRanges) ? body.assignRanges : undefined,
        alignWords: alignWords.length ? alignWords : undefined,
        reconcileTiming,
        scriptLanguage
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
        adlibSegments: grok.adlibSegments ?? [],
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
      return jsonResponse({ ok: false, error: "YouTube の動画URLとして解釈できませんでした。", errorCode: "INVALID_VIDEO_URL" }, 400);
    }
    if (!isRunpodWhisperxMode()) {
      return jsonResponse(
        { ok: false, error: "prepare-audio は RunPod 設定時のみ利用できます。" },
        400
      );
    }

    const prepGuard = await guardYouTubeVideoExtract(req, admin, videoUrl, userId);
    if (!prepGuard.ok) {
      const extra =
        prepGuard.retryAfterSec != null
          ? rateLimitResponseHeaders(prepGuard.retryAfterSec)
          : {};
      return jsonResponse(prepGuard.body, prepGuard.status, extra);
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
      const preferOriginal = Boolean(body.preferOriginalTrack || body.preferOriginal);
      let extracted: ProxyStorageResult & { cached?: boolean };
      try {
        extracted = await fetchProxyAudioToStorageCached(
          admin,
          videoUrl,
          prepStoragePath,
          false,
          undefined,
          preferOriginal ? { preferOriginalTrack: true } : undefined,
          {
            userId,
            channelId: prepGuard.channelId,
            videoId: prepVideoId
          }
        );
      } catch (firstErr) {
        const firstMsg = firstErr instanceof Error ? firstErr.message : String(firstErr);
        if (
          preferOriginal &&
          isYouTubeExtractTestMode() &&
          firstMsg.includes("NO_ORIGINAL_TRACK")
        ) {
          console.warn(
            "[media-pipeline] test mode — retry prepare-audio without preferOriginalTrack"
          );
          extracted = await fetchProxyAudioToStorageCached(
            admin,
            videoUrl,
            prepStoragePath,
            false,
            undefined,
            undefined,
            {
              userId,
              channelId: prepGuard.channelId,
              videoId: prepVideoId
            }
          );
        } else {
          throw firstErr;
        }
      }
      if (preferOriginal && String(extracted.trackRole || "") !== "original") {
        if (isYouTubeExtractTestMode() && extracted.publicUrl) {
          console.warn(
            "[media-pipeline] test mode — accepting non-original trackRole",
            extracted.trackRole
          );
        } else {
          throw new Error(
            `[NO_ORIGINAL_TRACK] オリジナル音声を確定できませんでした` +
              `（role=${extracted.trackRole || "?"} format=${extracted.selectedFormatId || "?"}）。`
          );
        }
      }
      const durationMs = Date.now() - started;
      const updatePayload: Record<string, unknown> = {
        status: "audio_ready",
        step: "audio_ready",
        audio_url: extracted.publicUrl,
        audio_source: preferOriginal ? "youtube_proxy_original" : "youtube_proxy_storage",
        error: null,
        duration_ms: durationMs,
        updated_at: new Date().toISOString()
      };
      if (preferOriginal) {
        updatePayload.models = {
          trackRole: "original",
          selectedFormatId: extracted.selectedFormatId || null
        };
      }
      await admin
        .from("media_pipeline_jobs")
        .update(updatePayload)
        .eq("id", prepJobId);

      return jsonResponse({
        ok: true,
        jobId: prepJobId,
        mode: "prepare-audio",
        rawAudioUrl: extracted.publicUrl,
        audioDurationSec: extracted.audioDurationSec ?? null,
        durationMs,
        trackRole: extracted.trackRole || (preferOriginal ? "original" : null),
        selectedFormatId: extracted.selectedFormatId ?? null,
        cached: Boolean(extracted.cached),
        transcribeBuild: WAVRICK_TRANSCRIBE_BUILD
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const errorCode = classifyYouTubeExtractError(msg);
      await logYouTubeExtractEvent(admin, {
        userId,
        videoId: prepVideoId,
        channelId: prepGuard.channelId,
        success: false,
        errorCode: errorCode || "EXTRACT_FAILED"
      });
      await admin
        .from("media_pipeline_jobs")
        .update({
          status: "failed",
          step: "error",
          error: msg,
          updated_at: new Date().toISOString()
        })
        .eq("id", prepJobId);
      return jsonResponse(
        {
          ok: false,
          jobId: prepJobId,
          error: msg,
          errorCode: errorCode || undefined
        },
        errorCode === "YT_EXTRACT_BLOCKED" ? 502 : 422
      );
    }
  }

  if (!videoUrl && !audioUrl) {
    return jsonResponse({ ok: false, error: "videoUrl または audioUrl のどちらかが必要です。" }, 400);
  }

  if (videoUrl && !extractYouTubeVideoId(videoUrl)) {
    return jsonResponse({ ok: false, error: "YouTube の動画URLとして解釈できませんでした。", errorCode: "INVALID_VIDEO_URL" }, 400);
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

      const fullGuard = await guardYouTubeVideoExtract(req, admin, videoUrl, userId);
      if (!fullGuard.ok) {
        await admin
          .from("media_pipeline_jobs")
          .update({
            status: "failed",
            step: "error",
            error: String(fullGuard.body.error || "YouTube 取得が拒否されました。"),
            updated_at: new Date().toISOString()
          })
          .eq("id", jobId);
        const extra =
          fullGuard.retryAfterSec != null
            ? rateLimitResponseHeaders(fullGuard.retryAfterSec)
            : {};
        return jsonResponse(fullGuard.body, fullGuard.status, extra);
      }

      await admin.from("media_pipeline_jobs").update({ step: "extract", audio_source: audioSource }).eq("id", jobId);

      if (isRunpodWhisperxMode()) {
        const streamed = await fetchProxyAudioToStorageCached(
          admin,
          videoUrl,
          rawStoragePath,
          false,
          undefined,
          undefined,
          {
            userId,
            channelId: fullGuard.channelId,
            videoId
          }
        );
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
