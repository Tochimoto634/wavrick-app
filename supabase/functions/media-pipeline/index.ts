import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const MAX_WHISPER_BYTES = 24 * 1024 * 1024;
const GROK_MODEL = Deno.env.get("GROK_MODEL") || "grok-4.3";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

type PipelineBody = {
  videoUrl?: string;
  audioUrl?: string;
  requestId?: string;
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
    if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
      if (u.pathname === "/watch") {
        const v = u.searchParams.get("v");
        return v && /^[\w-]{11}$/.test(v) ? v : null;
      }
      const shorts = u.pathname.match(/^\/shorts\/([\w-]{11})/);
      if (shorts?.[1]) return shorts[1];
      const embed = u.pathname.match(/^\/embed\/([\w-]{11})/);
      if (embed?.[1]) return embed[1];
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

async function fetchAudioFromProxy(videoUrl: string): Promise<Uint8Array> {
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
      body: JSON.stringify({ videoUrl })
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/dns|lookup|trycloudflare|Name or service not known/i.test(msg)) {
      throw new Error(
        "YouTube音声プロキシ（Cloudflareトンネル）に接続できません。URLが期限切れの可能性があります。開発PCで ./scripts/cursor-ai-setup.sh を実行し、Supabase の YOUTUBE_AUDIO_PROXY_URL を更新してください。"
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
  return buf;
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

async function transcribeWhisper(audio: Uint8Array, filename: string): Promise<{ text: string; raw: unknown }> {
  const key = Deno.env.get("OPENAI_API_KEY");
  if (!key) throw new Error("OPENAI_API_KEY が未設定です。");

  const form = new FormData();
  form.append("file", new Blob([audio], { type: "application/octet-stream" }), filename);
  form.append("model", "whisper-1");
  form.append("response_format", "verbose_json");

  const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form
  });
  const raw = await r.json();
  if (!r.ok) {
    throw new Error(typeof raw?.error?.message === "string" ? raw.error.message : JSON.stringify(raw).slice(0, 400));
  }
  const text = typeof raw.text === "string" ? raw.text : "";
  if (!text.trim()) throw new Error("Whisper の結果が空でした。");
  return { text, raw };
}

async function translateAndScriptWithGrok(transcript: string): Promise<{ translation: string; script: string }> {
  const key = Deno.env.get("XAI_API_KEY");
  if (!key) throw new Error("XAI_API_KEY が未設定です（Grok / xAI）。");

  const system = [
    "あなたはプロの映像翻訳・吹替台本ライターです。",
    "入力は動画の文字起こし（元言語は問いません）。",
    "次のJSONだけを返してください（他の文字は一切含めない）:",
    '{"translation":"日本語訳（意味を保ちつつ自然な口語）","script":"声優が読み上げやすい日本語台本。適度に改行。ト書きは【】で短く入れてよい"}'
  ].join("");

  const r = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: GROK_MODEL,
      temperature: 0.35,
      messages: [
        { role: "system", content: system },
        { role: "user", content: transcript }
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

  let parsed: { translation?: string; script?: string };
  try {
    const cleaned = content.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`Grok の JSON 解析に失敗しました: ${content.slice(0, 400)}`);
  }
  const translation = typeof parsed.translation === "string" ? parsed.translation : "";
  const script = typeof parsed.script === "string" ? parsed.script : "";
  if (!translation && !script) throw new Error("Grok の JSON に translation / script がありません。");
  return { translation, script };
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

  const videoUrl = (body.videoUrl || "").trim();
  const audioUrl = (body.audioUrl || "").trim();
  const requestId = (body.requestId || "").trim() || null;

  if (!videoUrl && !audioUrl) {
    return jsonResponse({ ok: false, error: "videoUrl または audioUrl のどちらかが必要です。" }, 400);
  }

  if (videoUrl && !extractYouTubeVideoId(videoUrl)) {
    return jsonResponse({ ok: false, error: "YouTube の動画URLとして解釈できませんでした。" }, 400);
  }

  const userId = await resolveUserId(req);
  const admin = createClient(supabaseUrl, serviceKey);
  const started = Date.now();

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

    if (audioUrl) {
      audioSource = "audio_url";
      audio = await fetchAudioFromUrl(audioUrl);
      try {
        const ext = new URL(audioUrl).pathname.split(".").pop();
        if (ext && /^[a-z0-9]+$/i.test(ext) && ext.length <= 5) filename = `audio.${ext}`;
      } catch {
        /* keep default */
      }
    } else {
      audioSource = Deno.env.get("YOUTUBE_AUDIO_PROXY_URL") ? "youtube_proxy" : "missing_proxy";
      if (audioSource === "missing_proxy") {
        throw new Error(
          "YouTube の videoUrl のみでは音声を取得できません。Supabase secrets に YOUTUBE_AUDIO_PROXY_URL を設定するか、抽出済み音声の audioUrl を指定してください。"
        );
      }
      await admin.from("media_pipeline_jobs").update({ step: "extract", audio_source: audioSource }).eq("id", jobId);
      audio = await fetchAudioFromProxy(videoUrl);
    }

    await admin.from("media_pipeline_jobs").update({ step: "whisper", audio_source: audioSource }).eq("id", jobId);

    const whisper = await transcribeWhisper(audio, filename);
    const whisperLang =
      typeof (whisper.raw as { language?: string })?.language === "string"
        ? (whisper.raw as { language: string }).language
        : undefined;

    await admin.from("media_pipeline_jobs").update({ step: "grok" }).eq("id", jobId);

    const grok = await translateAndScriptWithGrok(whisper.text);

    const durationMs = Date.now() - started;
    const segments = Array.isArray((whisper.raw as { segments?: unknown[] })?.segments)
      ? (whisper.raw as { segments: unknown[] }).segments
      : [];
    const trainingBundle = buildTrainingBundle({
      videoUrl: videoUrl || audioUrl,
      transcriptLen: whisper.text.length,
      audioSource,
      whisperLanguage: whisperLang,
      segmentCount: segments.length
    });

    await admin
      .from("media_pipeline_jobs")
      .update({
        status: "completed",
        step: "done",
        error: null,
        whisper_transcript: whisper.text,
        whisper_raw: whisper.raw as Record<string, unknown>,
        translation: grok.translation,
        script: grok.script,
        training_bundle: trainingBundle,
        models: { whisper: "whisper-1", grok: GROK_MODEL },
        duration_ms: durationMs,
        updated_at: new Date().toISOString()
      })
      .eq("id", jobId);

    return jsonResponse({
      ok: true,
      jobId,
      whisperTranscript: whisper.text,
      translation: grok.translation,
      script: grok.script,
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
