import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeadersForRequest } from "../_shared/cors.ts";
import {
  clientIpFromRequest,
  enforceRateLimit,
  parsePositiveInt,
  rateLimitResponseHeaders
} from "../_shared/rate-limit.ts";

type Body = { videoUrl?: string; url?: string };

Deno.serve(async (req) => {
  const corsHeaders = corsHeadersForRequest(req);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" }
    });
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return new Response(JSON.stringify({ ok: false, error: "JSON body が不正です。" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" }
    });
  }

  const videoUrl = (body.videoUrl || body.url || "").trim();
  if (!videoUrl) {
    return new Response(JSON.stringify({ ok: false, error: "videoUrl が必要です。" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" }
    });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const admin =
    supabaseUrl && serviceKey ? createClient(supabaseUrl, serviceKey) : null;
  const metaRl = await enforceRateLimit({
    admin,
    bucketPrefix: "youtube-video-meta",
    clientKey: `ip:${clientIpFromRequest(req)}`,
    limit: parsePositiveInt(Deno.env.get("WAVRICK_RL_VIDEO_META_PER_MIN"), 40),
    windowSec: 60
  });
  if (!metaRl.ok) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: "短時間のリクエストが多すぎます。しばらく待ってから再試行してください。",
        retryAfterSec: metaRl.retryAfterSec
      }),
      {
        status: 429,
        headers: {
          ...corsHeaders,
          ...rateLimitResponseHeaders(metaRl.retryAfterSec),
          "Content-Type": "application/json; charset=utf-8"
        }
      }
    );
  }

  let proxyBase = (Deno.env.get("YOUTUBE_AUDIO_PROXY_URL") || "").trim().replace(/\/$/, "");
  // secrets では …/extract を指すことが多い。video-meta はルート直下。
  if (proxyBase.endsWith("/extract")) {
    proxyBase = proxyBase.slice(0, -"/extract".length);
  }
  if (!proxyBase) {
    return new Response(
      JSON.stringify({
        ok: false,
        error:
          "YOUTUBE_AUDIO_PROXY_URL が未設定です。音声プロキシをデプロイし Supabase secrets に URL を設定してください。"
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" }
      }
    );
  }

  const secret = (Deno.env.get("YOUTUBE_AUDIO_PROXY_SECRET") || Deno.env.get("PROXY_SECRET") || "").trim();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret) headers.Authorization = `Bearer ${secret}`;

  try {
    const r = await fetch(`${proxyBase}/video-meta`, {
      method: "POST",
      headers,
      body: JSON.stringify({ videoUrl })
    });
    const text = await r.text();
    return new Response(text, {
      status: r.status,
      headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" }
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return new Response(
      JSON.stringify({
        ok: false,
        error: `音声プロキシに接続できません: ${msg}`
      }),
      {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" }
      }
    );
  }
});
