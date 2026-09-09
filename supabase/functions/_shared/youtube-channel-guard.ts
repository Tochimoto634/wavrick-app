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
  title?: string;
  channelId?: string;
  channelKey?: string;
  channelTitle?: string;
  channelUrl?: string;
  durationSec?: number;
  uploaderId?: string;
  error?: string;
  /** どちらの経路で解決したか（観測用）。data_api は YouTube のボット判定を受けない。 */
  source?: "data_api" | "proxy";
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

const DATA_API_ENDPOINT = "https://www.googleapis.com/youtube/v3/videos";
const DATA_API_TIMEOUT_MS = 10_000;

export function youtubeDataApiKey(): string {
  return (Deno.env.get("YOUTUBE_DATA_API_KEY") || Deno.env.get("GOOGLE_API_KEY") || "").trim();
}

export function videoIdFromUrl(raw: string): string {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";
  if (/^[\w-]{11}$/.test(trimmed)) return trimmed;
  let u: URL;
  try {
    u = new URL(trimmed.startsWith("http") ? trimmed : `https://${trimmed}`);
  } catch {
    return "";
  }
  const host = (u.hostname || "").replace(/^www\./, "").toLowerCase();
  if (host === "youtu.be") {
    const id = u.pathname.replace(/^\//, "").split("/")[0] || "";
    return /^[\w-]{11}$/.test(id) ? id : "";
  }
  if (!/^(m\.|music\.)?youtube(-nocookie)?\.com$/.test(host)) return "";
  if (u.pathname === "/watch") {
    const v = u.searchParams.get("v") || "";
    return /^[\w-]{11}$/.test(v) ? v : "";
  }
  const path = u.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{11})/);
  return path?.[1] || "";
}

/** ISO 8601 duration (PT1H2M3S) → 秒 */
function iso8601DurationToSec(raw: unknown): number {
  const m = /^P(?:([\d.]+)D)?T?(?:([\d.]+)H)?(?:([\d.]+)M)?(?:([\d.]+)S)?$/.exec(String(raw || ""));
  if (!m) return 0;
  const [, d, h, min, s] = m;
  return (
    Number(d || 0) * 86400 + Number(h || 0) * 3600 + Number(min || 0) * 60 + Number(s || 0)
  );
}

/**
 * YouTube Data API v3 でチャンネル所有者を判定する。
 *
 * yt-dlp と違い datacenter IP からのボット判定を受けず、クォータは 1 動画 1 unit
 * （日次 10,000）。解決できない場合（キー未設定 / 非公開動画 / クォータ超過）は
 * null を返し、呼び出し側が従来の yt-dlp 経路へフォールバックする。
 */
export async function fetchVideoMetaFromDataApi(videoUrl: string): Promise<VideoMeta | null> {
  const key = youtubeDataApiKey();
  if (!key) return null;
  const videoId = videoIdFromUrl(videoUrl);
  if (!videoId) return null;

  const url = new URL(DATA_API_ENDPOINT);
  url.searchParams.set("part", "snippet,contentDetails");
  url.searchParams.set("id", videoId);
  url.searchParams.set("key", key);

  let r: Response;
  try {
    r = await fetch(url.toString(), { signal: AbortSignal.timeout(DATA_API_TIMEOUT_MS) });
  } catch (e) {
    console.warn("[youtube-channel-guard] data api fetch failed", String(e).slice(0, 200));
    return null;
  }
  if (!r.ok) {
    // 403 はクォータ超過かキーの制限。どちらも yt-dlp 経路に落とす。
    console.warn("[youtube-channel-guard] data api status", r.status, (await r.text()).slice(0, 200));
    return null;
  }

  let data: { items?: Array<Record<string, any>> };
  try {
    data = await r.json();
  } catch {
    return null;
  }
  // 非公開動画・削除済みは items が空。cookies 付き yt-dlp なら見える場合があるので
  // ここでは失敗にせず null（フォールバック）にする。
  const item = data?.items?.[0];
  if (!item) return null;

  const snippet = (item.snippet || {}) as Record<string, unknown>;
  const channelId = String(snippet.channelId || "");
  if (!channelId) return null;

  return {
    ok: true,
    source: "data_api",
    videoId,
    title: String(snippet.title || ""),
    channelId,
    channelKey: `channel:${channelId}`,
    channelTitle: String(snippet.channelTitle || ""),
    channelUrl: `https://www.youtube.com/channel/${channelId}`,
    durationSec: iso8601DurationToSec((item.contentDetails as Record<string, unknown>)?.duration)
  };
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
  return { ...data, source: "proxy" };
}

/**
 * メタ取得の本線。Data API を先に試し、解決できないときだけ yt-dlp プロキシに落ちる。
 *
 * 従来は常に yt-dlp を経由していたため、音声取得と無関係な所有者確認だけで
 * ボット判定・60 秒タイムアウトを食らっていた。
 */
export async function fetchVideoMeta(videoUrl: string): Promise<VideoMeta> {
  const viaApi = await fetchVideoMetaFromDataApi(videoUrl);
  if (viaApi) return viaApi;
  return await fetchVideoMetaFromProxy(videoUrl);
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
  | {
      ok: true;
      bypass: "admin" | "matched" | "test" | "cached";
      channelId?: string;
      userEmail: string;
    }
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
  videoUrl: string,
  opts?: { knownChannelId?: string }
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
      const meta = await fetchVideoMeta(videoUrl);
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

  // 抽出済みキャッシュに残っている channel_id が登録チャンネルと一致するなら、
  // 所有者は確定しているので YouTube には一切問い合わせない。
  // （一致しないときは古い値の可能性があるので通常の meta 取得に落とす）
  const knownChannelId = String(opts?.knownChannelId || "").trim();
  if (knownChannelId) {
    const knownMatch = videoUploaderMatchesChannels(
      { channelId: knownChannelId, channelKey: `channel:${knownChannelId}` },
      verified
    );
    if (knownMatch.ok) {
      return { ok: true, bypass: "cached", channelId: knownChannelId, userEmail };
    }
  }

  let meta: VideoMeta;
  try {
    meta = await fetchVideoMeta(videoUrl);
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
