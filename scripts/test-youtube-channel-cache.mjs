#!/usr/bin/env node
/**
 * Unit tests mirroring youtube-channel-guard + youtube-audio-cache helpers.
 * Run: node scripts/test-youtube-channel-cache.mjs
 */

import assert from "node:assert/strict";

function isUnverifiedMemoChannel(entry) {
  if (!entry) return false;
  if (entry.unverified === true || entry.memo === true || entry.verified === false) return true;
  const id = String(entry.channelId || "");
  return id.startsWith("memo:") || String(entry.channelKey || "").startsWith("memo:");
}

function channelIdsMatch(a, b) {
  return String(a || "").toLowerCase() === String(b || "").toLowerCase();
}

function videoUploaderMatchesChannels(meta, channels) {
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
  return { ok: false, reason: "mismatch" };
}

function cacheStemFromOpts(opts) {
  if (opts?.preferOriginalTrack) return "original";
  return "default";
}

function youtubeCacheStoragePath(videoId, targetLang, stem) {
  const langPart = (targetLang || "default").replace(/[^a-z0-9_-]/gi, "") || "default";
  const stemPart = stem === "original" ? "original" : "default";
  return `yt-cache/${videoId}/${langPart}_${stemPart}.mp3`;
}

function videoIdFromUrl(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";
  if (/^[\w-]{11}$/.test(trimmed)) return trimmed;
  let u;
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

function iso8601DurationToSec(raw) {
  const m = /^P(?:([\d.]+)D)?T?(?:([\d.]+)H)?(?:([\d.]+)M)?(?:([\d.]+)S)?$/.exec(String(raw || ""));
  if (!m) return 0;
  const [, d, h, min, s] = m;
  return Number(d || 0) * 86400 + Number(h || 0) * 3600 + Number(min || 0) * 60 + Number(s || 0);
}

/** guardYouTubeVideoExtract の cacheHit 判定（全キーが揃ったときだけ true） */
function allCacheKeysHit(keys, cachedSet) {
  if (!keys.length) return false;
  return keys.every((k) => cachedSet.has(`${(k.targetLang || "").trim()}|${k.stem || "default"}`));
}

const channels = [
  { channelId: "UCabc123", channelKey: "channel:UCabc123", verified: true },
  { channelId: "memo:test", channelKey: "memo:test", verified: false }
];

assert.equal(isUnverifiedMemoChannel({ channelId: "memo:foo", verified: false }), true);
assert.equal(
  videoUploaderMatchesChannels({ channelId: "UCabc123" }, channels).ok,
  true
);
assert.equal(
  videoUploaderMatchesChannels({ channelId: "UCother" }, channels).ok,
  false
);
assert.equal(
  videoUploaderMatchesChannels(
    { channelKey: "handle:@mychannel" },
    [{ channelId: "UCx", channelKey: "handle:@mychannel", verified: true }]
  ).ok,
  true
);
assert.deepEqual(
  videoUploaderMatchesChannels({ channelId: "UCabc123" }, [{ channelId: "memo:only", verified: false }]),
  { ok: false, reason: "no_channels" }
);

assert.equal(cacheStemFromOpts({ preferOriginalTrack: true }), "original");
assert.equal(
  youtubeCacheStoragePath("dQw4w9WgXcQ", "ja", "default"),
  "yt-cache/dQw4w9WgXcQ/ja_default.mp3"
);

// --- Data API 経路: URL → videoId ---
assert.equal(videoIdFromUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), "dQw4w9WgXcQ");
assert.equal(videoIdFromUrl("https://youtu.be/dQw4w9WgXcQ?t=30"), "dQw4w9WgXcQ");
assert.equal(videoIdFromUrl("https://m.youtube.com/shorts/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
assert.equal(videoIdFromUrl("https://www.youtube.com/live/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
assert.equal(videoIdFromUrl("https://youtube-nocookie.com/embed/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
assert.equal(videoIdFromUrl("dQw4w9WgXcQ"), "dQw4w9WgXcQ");
// 別ドメインを YouTube と誤認しない（所有者判定に使うため厳格に）
assert.equal(videoIdFromUrl("https://evil.com/watch?v=dQw4w9WgXcQ"), "");
assert.equal(videoIdFromUrl("https://notyoutube.com/watch?v=dQw4w9WgXcQ"), "");
assert.equal(videoIdFromUrl("https://www.youtube.com/watch?v=tooshort"), "");
assert.equal(videoIdFromUrl(""), "");

// --- Data API 経路: ISO8601 duration ---
assert.equal(iso8601DurationToSec("PT1H2M3S"), 3723);
assert.equal(iso8601DurationToSec("PT45S"), 45);
assert.equal(iso8601DurationToSec("PT10M"), 600);
assert.equal(iso8601DurationToSec("P1DT2H"), 93600);
assert.equal(iso8601DurationToSec("garbage"), 0);

// --- キャッシュ済み channel_id によるガードのバイパス ---
// 一致すれば YouTube に問い合わせず通す
assert.equal(
  videoUploaderMatchesChannels(
    { channelId: "UCabc123", channelKey: "channel:UCabc123" },
    channels
  ).ok,
  true
);
// 古い/誤った cached channel_id は通さず、通常の meta 取得に落とす
assert.equal(
  videoUploaderMatchesChannels(
    { channelId: "UCstale", channelKey: "channel:UCstale" },
    channels
  ).ok,
  false
);

// --- cacheHit は全キーが揃ったときだけ（ADR の吹替+原音） ---
const bothCached = new Set(["ja|default", "|default"]);
const dubOnly = new Set(["ja|default"]);
const adrKeys = [
  { targetLang: "ja", stem: "default" },
  { targetLang: "", stem: "default" }
];
assert.equal(allCacheKeysHit(adrKeys, bothCached), true);
// 原音が未抽出なら YouTube に触るので抽出枠を消費させる
assert.equal(allCacheKeysHit(adrKeys, dubOnly), false);
// キー未指定（非 RunPod 経路など）は常に false
assert.equal(allCacheKeysHit([], bothCached), false);

console.log("test-youtube-channel-cache: ok");
