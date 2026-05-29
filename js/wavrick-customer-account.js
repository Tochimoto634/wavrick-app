/**
 * 顧客アカウント: YouTube チャンネル登録・動画照合・音声アップロード
 */
(function initWavrickCustomerAccount(global) {
  const STORAGE_KEY = "wavrick_customer_youtube_channels";
  const MAX_AUDIO_BYTES = 24 * 1024 * 1024;

  function getChannelsMap() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  function saveChannelsMap(map) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  }

  function normalizeEmail(email) {
    return String(email || "")
      .toLowerCase()
      .trim();
  }

  function getChannelsForEmail(email) {
    const key = normalizeEmail(email);
    if (!key) return [];
    const map = getChannelsMap();
    const list = map[key];
    return Array.isArray(list) ? list : [];
  }

  function saveChannelsForEmail(email, channels) {
    const key = normalizeEmail(email);
    if (!key) return;
    const map = getChannelsMap();
    map[key] = channels;
    saveChannelsMap(map);
  }

  function channelEntryLabel(entry) {
    if (!entry) return "—";
    if (entry.label) return entry.label;
    if (entry.channelKey?.startsWith("handle:")) return entry.channelKey.slice(7);
    if (entry.channelKey?.startsWith("channel:")) return entry.channelKey.slice(8);
    return entry.channelId || "チャンネル";
  }

  function normalizeChannelEntry(raw) {
    const channelId = String(raw.channelId || "").trim();
    if (!channelId) return null;
    const channelKey =
      String(raw.channelKey || "").trim() ||
      (channelId.startsWith("UC") ? `channel:${channelId}` : "");
    return {
      channelId,
      channelKey,
      label: String(raw.label || "").trim() || channelEntryLabel({ channelId, channelKey }),
      addedAt: raw.addedAt || new Date().toISOString()
    };
  }

  function addChannelsForEmail(email, entries) {
    const key = normalizeEmail(email);
    if (!key) return [];
    const existing = getChannelsForEmail(key);
    const byId = new Map(existing.map((c) => [c.channelId.toLowerCase(), c]));
    for (const raw of entries) {
      const entry = normalizeChannelEntry(raw);
      if (!entry) continue;
      byId.set(entry.channelId.toLowerCase(), entry);
    }
    const next = [...byId.values()];
    saveChannelsForEmail(key, next);
    return next;
  }

  function removeChannelForEmail(email, channelId) {
    const key = normalizeEmail(email);
    const id = String(channelId || "").toLowerCase();
    const next = getChannelsForEmail(key).filter((c) => c.channelId.toLowerCase() !== id);
    saveChannelsForEmail(key, next);
    return next;
  }

  function channelIdsMatch(a, b) {
    return String(a || "").toLowerCase() === String(b || "").toLowerCase();
  }

  function videoUploaderMatchesChannels(meta, channels) {
    if (!meta || !channels?.length) return { ok: false, reason: "no_channels" };
    const uploadId = meta.channelId || meta.uploaderId || "";
    const uploadKey = meta.channelKey || "";
    for (const ch of channels) {
      if (uploadId && channelIdsMatch(uploadId, ch.channelId)) return { ok: true, matched: ch };
      if (uploadKey && ch.channelKey && uploadKey === ch.channelKey) return { ok: true, matched: ch };
    }
    return { ok: false, reason: "mismatch", uploadId, uploadKey };
  }

  async function fetchVideoMeta(videoUrl) {
    const res = await fetch("/api/youtube-video-meta", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videoUrl })
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = { ok: false, error: `HTTP ${res.status}` };
    }
    if (!res.ok || !data?.ok) {
      throw new Error(data?.error || `動画情報の取得に失敗しました (${res.status})`);
    }
    return data;
  }

  async function uploadCustomerAudio(file) {
    if (!file) throw new Error("音声ファイルを選択してください。");
    if (file.size > MAX_AUDIO_BYTES) {
      throw new Error(`ファイルが大きすぎます（上限 ${Math.round(MAX_AUDIO_BYTES / 1024 / 1024)}MB）。`);
    }
    const fd = new FormData();
    fd.append("audio", file, file.name || "upload.bin");
    const res = await fetch("/api/customer-audio/upload", { method: "POST", body: fd });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = { ok: false, error: `HTTP ${res.status}` };
    }
    if (!res.ok || !data?.ok) {
      throw new Error(data?.error || "音声のアップロードに失敗しました。");
    }
    return data;
  }

  global.WavrickCustomerAccount = {
    STORAGE_KEY,
    MAX_AUDIO_BYTES,
    getChannelsForEmail,
    saveChannelsForEmail,
    addChannelsForEmail,
    removeChannelForEmail,
    channelEntryLabel,
    videoUploaderMatchesChannels,
    fetchVideoMeta,
    uploadCustomerAudio
  };
})(typeof window !== "undefined" ? window : globalThis);
