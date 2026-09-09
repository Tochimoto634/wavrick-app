import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { resolveAuthEmail } from "./admin-auth.ts";
import { fetchYoutubeProxy, PROXY_META_TIMEOUT_MS } from "./youtube-proxy-timeout.ts";

export type ChannelEntry = {
  channelId?: string;
  channelKey?: string;
  label?: string;
  verified?: boolean;
  unverified?: boolean;
  memo?: boolean;
};

export type VideoMeta = {
  ok?: boolean;
  videoId?: string;
  channelId?: string;
  channelKey?: string;
  channelTitle?: string;
  uploaderId?: string;
  error?: string;
};

function normalizeEmail(email: string): string {
  return String(email || "")
    .toLowerCase()
    .trim();
}

function channelIdsMatch(a: string, b: string): boolean {
  return String(a || "").toLowerCase() === String(b || "").toLowerCase();
}

export function isUnverifiedMemoChannel(entry: ChannelEntry | null | undefined): boolean {
  if (!entry) return false;
  if (entry.unverified === true || entry.memo === true || entry.verified === false) return true;
  const id = String(entry.channelId || "");
  return id.startsWith("memo:") || String(entry.channelKey || "").startsWith("memo:");
}

export function videoUploaderMatchesChannels(
  meta: VideoMeta | null | undefined,
  channels: ChannelEntry[]
): { ok: boolean; reason?: string; matched?: ChannelEntry } {
  if (!meta || !channels?.length) return { ok: false, reason: "no_channels" };
  const uploadId = String(meta.channelId || meta.uploaderId || "");
  const uploadKey = String(meta.channelKey || "");
  const verified = (channels || []).filter((ch) => !isUnverifiedMemoChannel(ch));
  if (!verified.length) return { ok: false, reason: "no_channels" };
  for (const ch of verified) {
    if (uploadId && ch.channelId && channelIdsMatch(uploadId, ch.channelId)) {
      return { ok: true, matched: ch };
    }
    if (uploadKey && ch.channelKey && uploadKey === ch.channelKey) {
      return { ok: true, matched: ch };
    }
  }
  return { ok: false, reason: "mismatch", ...(uploadId ? { uploadId } : {}), ...(uploadKey ? { uploadKey } : {}) };
}

function proxyAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const secret = (Deno.env.get("YOUTUBE_AUDIO_PROXY_SECRET") || "").trim();
  if (secret) headers.Authorization = `Bearer ${secret}`;
  return headers;
}

export async function fetchVideoMetaFromProxy(videoUrl: string): Promise<VideoMeta> {
  let proxyBase = (Deno.env.get("YOUTUBE_AUDIO_PROXY_URL") || "").trim().replace(/\/$/, "");
  if (proxyBase.endsWith("/extract")) {
    proxyBase = proxyBase.slice(0, -"/extract".length);
  }
  if (!proxyBase) {
    throw new Error("YOUTUBE_AUDIO_PROXY_URL が未設定です。");
  }
  const r = await fetchYoutubeProxy(
    `${proxyBase}/video-meta`,
    {
      method: "POST",
      headers: proxyAuthHeaders(),
      body: JSON.stringify({ videoUrl })
    },
    { timeoutMs: PROXY_META_TIMEOUT_MS, busyRetryMs: 30_000 }
  );
  const text = await r.text();
  let data: VideoMeta = {};
  try {
    data = JSON.parse(text) as VideoMeta;
  } catch {
    throw new Error(`動画メタデータの取得に失敗しました (${r.status})`);
  }
  if (!r.ok || data.ok === false) {
    throw new Error(String(data.error || `動画メタデータの取得に失敗しました (${r.status})`));
  }
  return data;
}

export async function isWavrickAdmin(
  admin: SupabaseClient,
  email: string
): Promise<boolean> {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;
  const { data, error } = await admin
    .from("admin_users_public")
    .select("email")
    .ilike("email", normalized)
    .limit(1);
  if (error) {
    console.warn("[youtube-channel-guard] admin lookup failed", error.message);
    return false;
  }
  return Array.isArray(data) && data.length > 0;
}

export async function loadVerifiedCustomerChannels(
  admin: SupabaseClient,
  email: string
): Promise<ChannelEntry[]> {
  const normalized = normalizeEmail(email);
  if (!normalized) return [];
  const { data, error } = await admin
    .from("customer_youtube_channels_public")
    .select("channels")
    .ilike("email", normalized)
    .maybeSingle();
  if (error) {
    console.warn("[youtube-channel-guard] channels lookup failed", error.message);
    return [];
  }
  const raw = data?.channels;
  return Array.isArray(raw) ? (raw as ChannelEntry[]) : [];
}

export type ChannelGuardResult =
  | { ok: true; bypass: "admin" | "matched" | "test"; channelId?: string; userEmail: string }
  | { ok: false; status: 401 | 403; error: string; errorCode: string; channelId?: string };

/** テスト段階: チャンネル一致・meta ゲートをスキップ（Supabase secrets で明示 opt-in） */
export function isYouTubeChannelGuardDisabled(): boolean {
  const testMode = (Deno.env.get("WAVRICK_YT_TEST_MODE") || "").trim().toLowerCase();
  if (testMode in { "1": 1, true: 1, yes: 1, on: 1, test: 1 }) return true;

  const guard = (Deno.env.get("WAVRICK_YT_CHANNEL_GUARD") || "").trim().toLowerCase();
  if (guard in { "0": 1, false: 1, no: 1, off: 1, disable: 1, disabled: 1 }) return true;
  return false;
}

export function isYouTubeExtractTestMode(): boolean {
  return isYouTubeChannelGuardDisabled();
}

export type YouTubeExtractErrorCode =
  | "AUTH_REQUIRED"
  | "NO_REGISTERED_CHANNELS"
  | "YT_EXTRACT_BLOCKED"
  | "VIDEO_UNAVAILABLE"
  | "INVALID_VIDEO_URL"
  | "VIDEO_META_FAILED"
  | "CHANNEL_MISMATCH";

/** yt-dlp / proxy の生エラーをユーザー向け code + 短文に分類 */
export function classifyYouTubeMetaError(raw: string): {
  errorCode: YouTubeExtractErrorCode;
  error: string;
} {
  const msg = String(raw || "");
  const m = msg.toLowerCase();
  if (
    /sign in to confirm|not a bot|ボット判定|use --cookies-from-browser|extractors#exporting-youtube-cookies/.test(
      m
    )
  ) {
    return {
      errorCode: "YT_EXTRACT_BLOCKED",
      error:
        "YouTube がサーバーからの自動取得をブロックしています（ボット判定）。音声ファイル（mp3/m4a）をアップロードして続行できます。"
    };
  }
  if (
    /private video|members.only|join this channel|login required|age.restricted|members-only|members only|適切ではない|この動画は非公開/.test(
      m
    )
  ) {
    return {
      errorCode: "VIDEO_UNAVAILABLE",
      error:
        "この動画は非公開・限定公開・年齢制限などのため、サーバーから情報を取得できません。"
    };
  }
  if (
    /video unavailable|removed by|has been removed|deleted|copyright|著作権|存在しません|could not find|invalid.*id|unable to extract|unsupported url|url.*invalid|404|not found|解釈できません/.test(
      m
    )
  ) {
    return {
      errorCode: "INVALID_VIDEO_URL",
      error:
        "YouTube の動画 URL として認識できないか、動画が削除・非公開になっています。watch?v=… / youtu.be/… 形式の URL を確認してください。"
    };
  }
  return {
    errorCode: "VIDEO_META_FAILED",
    error:
      "動画情報の取得に失敗しました。URL を確認するか、音声ファイル（mp3/m4a）を直接アップロードしてください。"
  };
}

/**
 * Server-side gate: JWT required, channel ownership verified before YouTube extract.
 * Admins bypass channel check (production customer bypass remains disabled on front).
 */
export async function assertYouTubeExtractAllowed(
  req: Request,
  admin: SupabaseClient,
  videoUrl: string
): Promise<ChannelGuardResult> {
  const userEmail = await resolveAuthEmail(req, admin);
  if (!userEmail) {
    return {
      ok: false,
      status: 401,
      error: "YouTube 音声の取得にはログインが必要です。",
      errorCode: "AUTH_REQUIRED"
    };
  }

  if (isYouTubeChannelGuardDisabled()) {
    console.warn("[youtube-channel-guard] test mode — channel guard disabled for", userEmail);
    return { ok: true, bypass: "test", userEmail };
  }

  if (await isWavrickAdmin(admin, userEmail)) {
    let channelId = "";
    try {
      const meta = await fetchVideoMetaFromProxy(videoUrl);
      channelId = String(meta.channelId || "");
    } catch {
      /* admin may proceed even if meta probe fails */
    }
    return { ok: true, bypass: "admin", channelId: channelId || undefined, userEmail };
  }

  const channels = await loadVerifiedCustomerChannels(admin, userEmail);
  const verified = channels.filter((ch) => !isUnverifiedMemoChannel(ch));
  if (!verified.length) {
    return {
      ok: false,
      status: 403,
      error:
        "YouTube チャンネルが未登録です。マイページから OAuth でチャンネルを追加してから再度お試しください。",
      errorCode: "NO_REGISTERED_CHANNELS"
    };
  }

  let meta: VideoMeta;
  try {
    meta = await fetchVideoMetaFromProxy(videoUrl);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const classified = classifyYouTubeMetaError(msg);
    console.warn("[youtube-channel-guard] video-meta failed", classified.errorCode, msg.slice(0, 240));
    return {
      ok: false,
      status: 403,
      error: classified.error,
      errorCode: classified.errorCode
    };
  }

  const match = videoUploaderMatchesChannels(meta, verified);
  if (!match.ok) {
    return {
      ok: false,
      status: 403,
      error:
        "この動画は、マイページで登録したご自身のチャンネルの動画ではありません。別アカウントのチャンネル URL は利用できません。",
      errorCode: "CHANNEL_MISMATCH",
      channelId: String(meta.channelId || "")
    };
  }

  return {
    ok: true,
    bypass: "matched",
    channelId: String(meta.channelId || ""),
    userEmail
  };
}

export async function logYouTubeExtractEvent(
  admin: SupabaseClient,
  row: {
    userId?: string | null;
    videoId: string;
    channelId?: string | null;
    targetLang?: string | null;
    stem?: string | null;
    success: boolean;
    errorCode?: string | null;
    cached?: boolean;
  }
): Promise<void> {
  try {
    await admin.from("youtube_extract_events").insert({
      user_id: row.userId || null,
      video_id: row.videoId,
      channel_id: row.channelId || null,
      target_lang: row.targetLang || "",
      stem: row.stem || "default",
      success: row.success,
      error_code: row.errorCode || null,
      cached: Boolean(row.cached)
    });
  } catch (e) {
    console.warn("[youtube-channel-guard] extract event log failed", e);
  }
}
