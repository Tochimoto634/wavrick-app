import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

type RateLimitResult =
  | { ok: true }
  | { ok: false; retryAfterSec: number; reason: string };

type MemoryBucket = { count: number; windowStartMs: number };

const memoryStore = new Map<string, MemoryBucket>();

export function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function clientIpFromRequest(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first.slice(0, 64);
  }
  const candidates = [
    req.headers.get("cf-connecting-ip"),
    req.headers.get("x-real-ip"),
    req.headers.get("x-client-ip")
  ];
  for (const c of candidates) {
    const v = (c || "").trim();
    if (v) return v.slice(0, 64);
  }
  return "unknown";
}

function memoryCheck(
  bucketKey: string,
  limit: number,
  windowSec: number
): RateLimitResult {
  const now = Date.now();
  const windowStartMs = Math.floor(now / (windowSec * 1000)) * windowSec * 1000;
  const existing = memoryStore.get(bucketKey);

  if (!existing || existing.windowStartMs !== windowStartMs) {
    memoryStore.set(bucketKey, { count: 1, windowStartMs });
    return { ok: true };
  }

  if (existing.count >= limit) {
    const retryAfterSec = Math.max(
      1,
      Math.ceil((windowStartMs + windowSec * 1000 - now) / 1000)
    );
    return {
      ok: false,
      retryAfterSec,
      reason: "rate_limit_exceeded"
    };
  }

  existing.count += 1;
  return { ok: true };
}

async function dbCheck(
  admin: SupabaseClient,
  bucketKey: string,
  limit: number
): Promise<boolean | null> {
  try {
    const { data, error } = await admin.rpc("wavrick_rate_limit_check", {
      p_bucket: bucketKey,
      p_max: limit
    });
    if (error) return null;
    return data === true;
  } catch {
    return null;
  }
}

export async function enforceRateLimit(opts: {
  admin?: SupabaseClient | null;
  bucketPrefix: string;
  clientKey: string;
  limit: number;
  windowSec: number;
}): Promise<RateLimitResult> {
  const limit = Math.max(1, Math.floor(opts.limit));
  const windowSec = Math.max(1, Math.floor(opts.windowSec));
  const windowEpoch = Math.floor(Date.now() / 1000 / windowSec);
  const bucketKey = `${opts.bucketPrefix}:${opts.clientKey}:${windowEpoch}`;

  if (opts.admin) {
    const allowed = await dbCheck(opts.admin, bucketKey, limit);
    if (allowed === true) return { ok: true };
    if (allowed === false) {
      const retryAfterSec = Math.max(
        1,
        windowSec - (Math.floor(Date.now() / 1000) % windowSec)
      );
      return { ok: false, retryAfterSec, reason: "rate_limit_exceeded" };
    }
  }

  return memoryCheck(bucketKey, limit, windowSec);
}

export function rateLimitResponseHeaders(retryAfterSec: number): Record<string, string> {
  return { "Retry-After": String(Math.max(1, retryAfterSec)) };
}

export function mediaPipelineLimits(mode: string): { limit: number; windowSec: number } {
  const hour = 3600;
  switch (mode) {
    case "transcribe":
      return {
        limit: parsePositiveInt(Deno.env.get("WAVRICK_RL_TRANSCRIBE_HOUR"), 8),
        windowSec: hour
      };
    case "script":
      return {
        limit: parsePositiveInt(Deno.env.get("WAVRICK_RL_SCRIPT_HOUR"), 24),
        windowSec: hour
      };
    case "full":
      return {
        limit: parsePositiveInt(Deno.env.get("WAVRICK_RL_FULL_HOUR"), 4),
        windowSec: hour
      };
    default:
      return {
        limit: parsePositiveInt(Deno.env.get("WAVRICK_RL_FULL_HOUR"), 4),
        windowSec: hour
      };
  }
}

export function burstLimitPerMinute(): number {
  return parsePositiveInt(Deno.env.get("WAVRICK_RL_BURST_PER_MIN"), 30);
}
