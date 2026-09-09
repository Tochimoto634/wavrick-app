import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const DEFAULT_TTL_DAYS = 30;

export type CacheStem = "default" | "original";

export type CacheLookup = {
  publicUrl: string;
  storagePath: string;
  byteLength?: number;
  durationSec?: number;
  channelId?: string;
};

export function cacheStemFromOpts(opts?: {
  preferOriginalTrack?: boolean;
}): CacheStem {
  if (opts?.preferOriginalTrack) return "original";
  return "default";
}

export function youtubeCacheStoragePath(
  videoId: string,
  targetLang: string,
  stem: CacheStem
): string {
  const langPart = (targetLang || "default").replace(/[^a-z0-9_-]/gi, "") || "default";
  const stemPart = stem === "original" ? "original" : "default";
  return `yt-cache/${videoId}/${langPart}_${stemPart}.mp3`;
}

function cacheTtlDays(): number {
  const raw = Deno.env.get("WAVRICK_YT_CACHE_TTL_DAYS");
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_TTL_DAYS;
}

function cacheLooksLikePlaylist(bytes: Uint8Array): boolean {
  const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.slice(0, 16)).trimStart();
  return head.startsWith("#EXTM3U");
}

function cacheRowLooksUnusable(row: {
  byte_length?: number | null;
  duration_sec?: number | null;
}): boolean {
  const bytes = Number(row.byte_length) || 0;
  const dur = Number(row.duration_sec) || 0;
  if (bytes > 0 && bytes < 2048) return true;
  if (dur <= 0) return true;
  return false;
}

/**
 * 過去に抽出済みの動画なら、その所有チャンネルはキャッシュ行に記録されている。
 * これを使うとチャンネルガードが YouTube に一切問い合わせずに済む。
 * lang/stem は問わない（同一動画なら所有者は同じ）。
 */
export async function lookupCachedChannelId(
  admin: SupabaseClient,
  videoId: string
): Promise<string> {
  if (!videoId) return "";
  const { data, error } = await admin
    .from("youtube_audio_cache")
    .select("channel_id, expires_at")
    .eq("video_id", videoId)
    .not("channel_id", "is", null)
    .gt("expires_at", new Date().toISOString())
    .limit(1)
    .maybeSingle();
  if (error) {
    console.warn("[youtube-audio-cache] channel lookup failed", error.message);
    return "";
  }
  return data?.channel_id ? String(data.channel_id) : "";
}

export async function lookupYouTubeAudioCache(
  admin: SupabaseClient,
  videoId: string,
  targetLang: string,
  stem: CacheStem
): Promise<CacheLookup | null> {
  const langKey = (targetLang || "").trim();
  const nowIso = new Date().toISOString();
  const { data, error } = await admin
    .from("youtube_audio_cache")
    .select("storage_path, byte_length, duration_sec, channel_id, expires_at")
    .eq("video_id", videoId)
    .eq("target_lang", langKey)
    .eq("stem", stem)
    .maybeSingle();

  if (error) {
    console.warn("[youtube-audio-cache] lookup failed", error.message);
    return null;
  }
  if (!data?.storage_path) return null;
  if (data.expires_at && String(data.expires_at) < nowIso) return null;
  if (cacheRowLooksUnusable(data)) {
    console.warn("[youtube-audio-cache] skip unusable row", videoId, langKey, stem, data.byte_length, data.duration_sec);
    return null;
  }

  const storagePath = String(data.storage_path);
  const { data: pub } = admin.storage.from("customer-uploads").getPublicUrl(storagePath);
  const publicUrl = String(pub?.publicUrl || "").trim();
  if (!publicUrl) return null;

  try {
    const peek = await fetch(publicUrl, {
      headers: { Range: "bytes=0-31" }
    });
    if (peek.ok || peek.status === 206) {
      const head = new Uint8Array(await peek.arrayBuffer());
      if (cacheLooksLikePlaylist(head)) {
        console.warn("[youtube-audio-cache] skip HLS playlist blob", videoId, storagePath);
        return null;
      }
    }
  } catch (e) {
    console.warn("[youtube-audio-cache] peek failed", e);
  }

  return {
    publicUrl,
    storagePath,
    byteLength: Number(data.byte_length) > 0 ? Number(data.byte_length) : undefined,
    durationSec: Number(data.duration_sec) > 0 ? Number(data.duration_sec) : undefined,
    channelId: data.channel_id ? String(data.channel_id) : undefined
  };
}

export async function saveYouTubeAudioCache(
  admin: SupabaseClient,
  row: {
    videoId: string;
    targetLang: string;
    stem: CacheStem;
    storagePath: string;
    byteLength?: number;
    durationSec?: number;
    channelId?: string;
  }
): Promise<void> {
  const ttlDays = cacheTtlDays();
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString();
  const langKey = (row.targetLang || "").trim();
  const bytes = Number(row.byteLength) || 0;
  const dur = Number(row.durationSec) || 0;
  if (bytes < 2048 || dur <= 0) {
    console.warn(
      "[youtube-audio-cache] skip save of unusable audio",
      row.videoId,
      langKey,
      row.stem,
      bytes,
      dur
    );
    return;
  }
  const { error } = await admin.from("youtube_audio_cache").upsert(
    {
      video_id: row.videoId,
      target_lang: langKey,
      stem: row.stem,
      storage_path: row.storagePath,
      byte_length: row.byteLength ?? null,
      duration_sec: row.durationSec ?? null,
      channel_id: row.channelId ?? null,
      extracted_at: new Date().toISOString(),
      expires_at: expiresAt
    },
    { onConflict: "video_id,target_lang,stem" }
  );
  if (error) {
    console.warn("[youtube-audio-cache] upsert failed", error.message);
  }
}
