const pageMap = {
  home: "page-home",
  voice: "page-voice",
  yt: "page-yt",
  talents: "page-talents",
  login: "page-login",
  work: "page-work",
  admin: "page-admin"
};

const SUPABASE_CONFIG_KEY = "wavrick_supabase_config";
const ADMIN_CREDENTIAL_KEY = "wavrick_admin_credentials";
const TABLES = {
  voiceProfiles: "voice_profiles_public",
  voiceAccounts: "voice_accounts_public",
  customerAccounts: "customer_accounts_public",
  youtubeRequests: "youtube_requests_public",
  adminUsers: "admin_users_public",
  requestWorkflows: "request_workflows_public",
  notifications: "notifications_public"
};
const REQUEST_STATUS_FLOW = ["募集中", "選定中", "進行中", "納品", "検収", "完了"];

let supabaseClient = null;
let remoteVoiceProfiles = [];
let adminDataState = {
  requests: [],
  youtubers: [],
  voices: []
};
let isWorkPageBound = false;

function generateRequestId() {
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function getCurrentSession() {
  return JSON.parse(localStorage.getItem("wavrick_session") || "null");
}

function getWorkflows() {
  return JSON.parse(localStorage.getItem("wavrick_request_workflows") || "{}");
}

function saveWorkflows(payload) {
  localStorage.setItem("wavrick_request_workflows", JSON.stringify(payload));
}

function getNotifications() {
  return JSON.parse(localStorage.getItem("wavrick_notifications") || "[]");
}

function saveNotifications(rows) {
  localStorage.setItem("wavrick_notifications", JSON.stringify(rows));
}

async function hydrateRemoteWorkData() {
  if (!isSupabaseEnabled()) return;

  const remoteWorkflows = await fetchRemoteWorkflows();
  if (remoteWorkflows.length) {
    const local = getWorkflows();
    for (const wf of remoteWorkflows) {
      if (!wf.requestId) continue;
      local[wf.requestId] = wf;
    }
    saveWorkflows(local);
  }

  const remoteNotifications = await fetchRemoteNotifications();
  if (remoteNotifications.length) {
    const map = new Map();
    for (const n of [...remoteNotifications, ...getNotifications()]) {
      map.set(n.id, n);
    }
    const merged = [...map.values()].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 200);
    saveNotifications(merged);
  }
}

function pushNotification(text, requestId) {
  const rows = getNotifications();
  const item = {
    id: `ntf_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    text,
    requestId,
    read: false,
    createdAt: new Date().toISOString()
  };
  rows.unshift(item);
  saveNotifications(rows.slice(0, 200));
  if (isSupabaseEnabled()) {
    upsertRemote(TABLES.notifications, mapNotificationToRemote(item), "id");
  }
}

const mockTalents = [
  {
    displayName: "山本 あかり",
    firstName: "あかり",
    lastName: "山本",
    bio: "明るく親しみやすい声。旅行・料理Vlogの吹替が得意です。",
    genres: "旅行, 料理, Vlog",
    rateFrom: 8000,
    jobCount: 42,
    sampleUrl: "https://example.com/akari-sample.mp3",
    avatar: "🌸"
  },
  {
    displayName: "田中 美咲",
    firstName: "美咲",
    lastName: "田中",
    bio: "落ち着いたナレーション向き。教育・ドキュメンタリー案件に対応。",
    genres: "教育, ドキュメンタリー",
    rateFrom: 12000,
    jobCount: 78,
    sampleUrl: "https://example.com/misaki-sample.mp3",
    avatar: "🎙️"
  },
  {
    displayName: "鈴木 健太",
    firstName: "健太",
    lastName: "鈴木",
    bio: "エネルギッシュな声質。ゲーム実況やエンタメ系に相性が良いです。",
    genres: "ゲーム実況, エンタメ",
    rateFrom: 7000,
    jobCount: 56,
    sampleUrl: "https://example.com/kenta-sample.mp3",
    avatar: "🎮"
  },
  {
    displayName: "佐藤 りな",
    firstName: "りな",
    lastName: "佐藤",
    bio: "かわいめ〜清楚系まで幅広く対応。アニメ調の演技も得意です。",
    genres: "アニメ, 美容, ライフスタイル",
    rateFrom: 5000,
    jobCount: 18,
    sampleUrl: "https://example.com/rina-sample.mp3",
    avatar: "✨"
  }
];

function getTalentId(profile) {
  const email = (profile.email || "").toLowerCase().trim();
  if (email) return `voice:${email}`;
  const name = (profile.displayName || "").toLowerCase().trim();
  if (name) return `mock:${name}`;
  return `mock:${Math.random().toString(16).slice(2)}`;
}

function parseGenres(genresString) {
  return (genresString || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function computeGenreOverlapScore(profile, desiredGenres) {
  const pGenres = parseGenres(profile.genres).map((g) => g.toLowerCase());
  const dGenres = parseGenres(desiredGenres).map((g) => g.toLowerCase());
  if (!dGenres.length) return 0;
  const set = new Set(pGenres);
  let score = 0;
  for (const dg of dGenres) if (set.has(dg)) score += 1;
  return score;
}

function showPage(name) {
  if (name === "admin") {
    const session = JSON.parse(localStorage.getItem("wavrick_session") || "null");
    if (!session || session.role !== "admin") {
      setMessage("loginMessage", "運営ダッシュボードは運営ログイン後に利用できます。", "err");
      name = "login";
    }
  }
  const pageId = pageMap[name];
  if (!pageId) return;
  document.querySelectorAll(".page").forEach((page) => page.classList.remove("active"));
  const target = document.getElementById(pageId);
  if (target) target.classList.add("active");
  if (name === "admin") {
    loadAdminData();
  }
  if (name === "work") {
    hydrateRemoteWorkData().then(() => {
      window.dispatchEvent(new Event("wavrick-workdata-updated"));
      const session = getCurrentSession();
      if (!session) {
        setMessage("workMessage", "案件管理を使うには、先にログインしてください。", "err");
      }
    });
  }
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function bindNavigation() {
  document.querySelectorAll("[data-go]").forEach((node) => {
    node.addEventListener("click", (event) => {
      event.preventDefault();
      const target = node.getAttribute("data-go");
      showPage(target);
    });
  });

  document.querySelectorAll('nav a[href="#how"]').forEach((node) => {
    node.addEventListener("click", (event) => {
      event.preventDefault();
      showPage("home");
      window.setTimeout(() => {
        const section = document.getElementById("how");
        if (section) section.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 80);
    });
  });
}

function isYouTubeUrl(value) {
  const raw = String(value || "").trim().replace(/[\r\n]+/g, "");
  if (!raw) return false;
  try {
    const normalized = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    const u = new URL(normalized);
    const host = u.hostname.toLowerCase();
    const base = host.startsWith("www.") ? host.slice(4) : host;
    if (base === "youtu.be") return u.pathname.replace(/^\//, "").length >= 6;
    if (
      base === "youtube.com" ||
      base === "m.youtube.com" ||
      base === "music.youtube.com" ||
      base === "youtube-nocookie.com"
    ) {
      return true;
    }
    return false;
  } catch {
    return /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\//i.test(raw);
  }
}

function decodeUriComponentSafe(value) {
  try {
    return decodeURIComponent(String(value).replace(/\+/g, " "));
  } catch (_) {
    return String(value);
  }
}

function channelKeyToBase64(channelKey) {
  const bytes = new TextEncoder().encode(channelKey);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function channelKeyFromBase64(b64) {
  const std = String(b64 || "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const pad = std + "=".repeat((4 - (std.length % 4)) % 4);
  const bin = atob(pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes).trim();
}

/** postMessage から channel_key を復元（ASCII の channelKeyB64 優先） */
function channelKeyFromOAuthMessage(d) {
  if (d.channelKeyB64) {
    try {
      return channelKeyFromBase64(d.channelKeyB64);
    } catch (_) {
      /* legacy */
    }
  }
  return d.channelKey || "";
}

function channelKeysMatch(a, b) {
  const norm = (s) => {
    let x = String(s || "").trim();
    for (let i = 0; i < 3; i++) {
      if (!/%[0-9A-Fa-f]{2}/.test(x)) break;
      const next = decodeUriComponentSafe(x);
      if (next === x) break;
      x = next;
    }
    return x.toLowerCase();
  };
  return norm(a) === norm(b);
}

function normalizeYoutubeChannelKey(urlValue) {
  try {
    const raw = urlValue.trim();
    if (!raw) return "";
    const parsed = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
    if (host !== "youtube.com" && host !== "m.youtube.com") return "";

    const path = decodeUriComponentSafe(parsed.pathname.replace(/\/+$/, ""));
    if (!path || path === "/") return "";
    const parts = path.split("/").filter(Boolean);
    const first = parts[0] || "";
    const second = parts[1] || "";

    if (first.startsWith("@")) return `handle:${first.toLowerCase()}`;
    if (first === "channel" && second) return `channel:${second}`;
    if (first === "user" && second) return `user:${second.toLowerCase()}`;
    if (first === "c" && second) return `custom:${second.toLowerCase()}`;
    return "";
  } catch (_) {
    return "";
  }
}

function getStoredSupabaseConfig() {
  const fromLocal = JSON.parse(localStorage.getItem(SUPABASE_CONFIG_KEY) || "null");
  if (fromLocal && fromLocal.supabaseUrl && fromLocal.supabaseAnonKey) return fromLocal;
  const fromWindow = window.WAVRICK_CONFIG || {};
  if (fromWindow.supabaseUrl && fromWindow.supabaseAnonKey) {
    return {
      supabaseUrl: fromWindow.supabaseUrl,
      supabaseAnonKey: fromWindow.supabaseAnonKey
    };
  }
  return null;
}

/** index.html #wavrickI18n から日本語を取得（app.js 直書きより文字化けしにくい） */
function wavrickI18n(key) {
  const el = document.querySelector(`#wavrickI18n [data-i18n="${key}"]`);
  return el ? el.textContent.trim() : key;
}

function youtubeOAuthMessageFromCode(code) {
  const k = `oauth_${code}`;
  const text = wavrickI18n(k);
  return text === k ? wavrickI18n("yt_oauth_fail") : text;
}

/** ローカル開発: localhost / 127.0.0.1 の postMessage ずれを防ぐ */
const WAVRICK_YT_OAUTH_STORAGE_KEY = "wavrick_yt_oauth_v1";

function normalizeOAuthParentOrigin(origin) {
  const raw = (origin || window.location.origin || "").trim();
  if (!raw || raw === "null") return "";
  try {
    const u = new URL(raw);
    const port = u.port || (u.protocol === "https:" ? "443" : "80");
    if (
      (u.hostname === "localhost" || u.hostname === "127.0.0.1") &&
      (port === "8889" || port === "80")
    ) {
      return `http://127.0.0.1:8889`;
    }
  } catch (_) {
    /* keep */
  }
  return raw;
}

/** 本番 https://wavrick.com/wavrick/ などサブフォルダ配置向け */
function getWavrickAppBase() {
  const origin = normalizeOAuthParentOrigin(window.location.origin);
  if (!origin) return "";
  let path = window.location.pathname || "/";
  if (path.endsWith("/")) path = path.slice(0, -1);
  else {
    const last = path.split("/").pop() || "";
    if (last.includes(".")) path = path.slice(0, path.lastIndexOf("/"));
  }
  if (!path || path === "/") return origin;
  return `${origin}${path}`;
}

function buildYoutubeOAuthStartUrl(channelKey, parentBase) {
  const cfg = getStoredSupabaseConfig();
  if (!cfg?.supabaseUrl) return "";
  const base = String(cfg.supabaseUrl).replace(/\/+$/, "");
  const u = new URL(`${base}/functions/v1/youtube-oauth-start`);
  u.searchParams.set("channel_key_b64", channelKeyToBase64(channelKey));
  u.searchParams.set(
    "parent_origin",
    parentBase || getWavrickAppBase() || normalizeOAuthParentOrigin(window.location.origin)
  );
  // ブラウザの window.open では Authorization ヘッダを付けられないため（anon は公開前提）
  if (cfg.supabaseAnonKey) {
    u.searchParams.set("apikey", cfg.supabaseAnonKey);
  }
  return u.toString();
}

function getSupabaseOriginForPostMessage() {
  const cfg = getStoredSupabaseConfig();
  if (!cfg?.supabaseUrl) return "";
  try {
    return new URL(cfg.supabaseUrl).origin;
  } catch (_) {
    return "";
  }
}

function initSupabaseClient() {
  const config = getStoredSupabaseConfig();
  if (!config || !window.supabase || !window.supabase.createClient) {
    supabaseClient = null;
    return false;
  }
  supabaseClient = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);
  return true;
}

function isSupabaseEnabled() {
  return Boolean(supabaseClient);
}

async function insertRemote(table, payload) {
  if (!isSupabaseEnabled()) return { ok: false, skipped: true };
  const { error } = await supabaseClient.from(table).insert({
    ...payload,
    created_at: new Date().toISOString()
  });
  if (error) return { ok: false, error };
  return { ok: true };
}

async function upsertRemote(table, payload, onConflict) {
  if (!isSupabaseEnabled()) return { ok: false, skipped: true };
  const query = supabaseClient.from(table).upsert(payload, onConflict ? { onConflict } : undefined);
  const { error } = await query;
  if (error) return { ok: false, error };
  return { ok: true };
}

async function fetchRemoteVoiceProfiles() {
  if (!isSupabaseEnabled()) return [];
  const { data, error } = await supabaseClient
    .from(TABLES.voiceProfiles)
    .select("*")
    .order("created_at", { ascending: false });
  if (error) return [];
  return Array.isArray(data) ? data.map(mapVoiceProfileFromRemote) : [];
}

async function fetchRemoteCustomerAccounts() {
  if (!isSupabaseEnabled()) return [];
  const { data, error } = await supabaseClient
    .from(TABLES.customerAccounts)
    .select("*")
    .order("created_at", { ascending: false });
  if (error) return [];
  return Array.isArray(data) ? data.map(mapCustomerAccountFromRemote) : [];
}

async function fetchRemoteVoiceAccounts() {
  if (!isSupabaseEnabled()) return [];
  const { data, error } = await supabaseClient
    .from(TABLES.voiceAccounts)
    .select("*")
    .order("created_at", { ascending: false });
  if (error) return [];
  return Array.isArray(data) ? data.map(mapVoiceAccountFromRemote) : [];
}

async function fetchRemoteYoutubeRequests() {
  if (!isSupabaseEnabled()) return [];
  const { data, error } = await supabaseClient
    .from(TABLES.youtubeRequests)
    .select("*")
    .order("created_at", { ascending: false });
  if (error) return [];
  return Array.isArray(data) ? data.map(mapYoutubeRequestFromRemote) : [];
}

async function fetchRemoteWorkflows() {
  if (!isSupabaseEnabled()) return [];
  const { data, error } = await supabaseClient
    .from(TABLES.requestWorkflows)
    .select("*")
    .order("updated_at", { ascending: false });
  if (error) return [];
  return Array.isArray(data) ? data.map(mapWorkflowFromRemote) : [];
}

async function fetchRemoteNotifications() {
  if (!isSupabaseEnabled()) return [];
  const { data, error } = await supabaseClient
    .from(TABLES.notifications)
    .select("*")
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) return [];
  return Array.isArray(data) ? data.map(mapNotificationFromRemote) : [];
}

async function findRemoteAccount(role, email) {
  if (!isSupabaseEnabled()) return null;
  const table = role === "voice" ? TABLES.voiceAccounts : TABLES.customerAccounts;
  const { data, error } = await supabaseClient
    .from(table)
    .select("*")
    .ilike("email", email)
    .limit(1);
  if (error || !Array.isArray(data) || !data.length) return null;
  return data[0];
}

async function refreshRemoteVoiceProfiles() {
  remoteVoiceProfiles = await fetchRemoteVoiceProfiles();
  renderTalents();
}

function mapVoiceProfileToRemote(data) {
  return {
    lastname: data.lastName || "",
    firstname: data.firstName || "",
    displayname: data.displayName || "",
    email: data.email || "",
    bio: data.bio || "",
    genres: data.genres || "",
    ratefrom: data.rateFrom ? Number(data.rateFrom) : null,
    jobcount: data.jobCount ? Number(data.jobCount) : null,
    sampleurl: data.sampleUrl || "",
    avatarurl: data.avatarUrl || ""
  };
}

function mapVoiceProfileFromRemote(row) {
  return {
    lastName: row.lastname || "",
    firstName: row.firstname || "",
    displayName: row.displayname || "",
    email: row.email || "",
    bio: row.bio || "",
    genres: row.genres || "",
    rateFrom: row.ratefrom ?? "",
    jobCount: row.jobcount ?? "",
    sampleUrl: row.sampleurl || "",
    avatarUrl: row.avatarurl || row.avatarUrl || ""
  };
}

function mapVoiceAccountToRemote(data) {
  return {
    role: "voice",
    email: data.email || "",
    displayname: data.displayName || ""
  };
}

function mapCustomerAccountToRemote(data) {
  return {
    role: "customer",
    email: data.email || "",
    name: data.name || "",
    channelurl: data.channelUrl || ""
  };
}

function mapYoutubeRequestToRemote(data) {
  return {
    name: data.name || "",
    email: data.email || "",
    channelurl: data.channelUrl || "",
    videourl: data.videoUrl || "",
    videochannelurl: data.videoChannelUrl || "",
    tone: data.tone || "",
    deadline: data.deadline || "",
    castmode: data.castMode || "",
    selectedtalentid: data.selectedTalentId || "",
    selectedtalentname: data.selectedTalentName || "",
    recgenres: data.recGenres || "",
    recbudgetmax: data.recBudgetMax || "",
    recjobmin: data.recJobMin || "",
    script: data.script || "",
    identityprooftext: data.identityProofText || ""
  };
}

function mapCustomerAccountFromRemote(row) {
  return {
    email: row.email || "",
    name: row.name || "",
    channelUrl: row.channelurl || row.channelUrl || "",
    role: row.role || "customer",
    createdAt: row.created_at || ""
  };
}

function mapVoiceAccountFromRemote(row) {
  return {
    email: row.email || "",
    displayName: row.displayname || row.displayName || "",
    role: row.role || "voice",
    createdAt: row.created_at || ""
  };
}

function mapYoutubeRequestFromRemote(row) {
  return {
    name: row.name || "",
    email: row.email || "",
    channelUrl: row.channelurl || "",
    videoUrl: row.videourl || "",
    videoChannelUrl: row.videochannelurl || "",
    selectedTalentName: row.selectedtalentname || "",
    castMode: row.castmode || "",
    createdAt: row.created_at || "",
    script: row.script || "",
    identityProofText: row.identityprooftext || row.identityProofText || ""
  };
}

function mapWorkflowToRemote(wf) {
  return {
    requestid: wf.requestId,
    status: wf.status || REQUEST_STATUS_FLOW[0],
    messages: wf.messages || [],
    quoteamount: wf.quoteAmount || "",
    paymentstatus: wf.paymentStatus || "unpaid",
    stripeurl: wf.stripeUrl || "",
    deliveries: wf.deliveries || [],
    revisioncount: Number(wf.revisionCount || 0),
    updated_at: wf.updatedAt || new Date().toISOString()
  };
}

function mapWorkflowFromRemote(row) {
  return {
    requestId: row.requestid || "",
    status: row.status || REQUEST_STATUS_FLOW[0],
    messages: Array.isArray(row.messages) ? row.messages : [],
    quoteAmount: row.quoteamount || "",
    paymentStatus: row.paymentstatus || "unpaid",
    stripeUrl: row.stripeurl || "",
    deliveries: Array.isArray(row.deliveries) ? row.deliveries : [],
    revisionCount: Number(row.revisioncount || 0),
    updatedAt: row.updated_at || row.created_at || new Date().toISOString()
  };
}

function mapNotificationToRemote(n) {
  return {
    id: n.id,
    requestid: n.requestId || "",
    text: n.text || "",
    read: Boolean(n.read),
    created_at: n.createdAt || new Date().toISOString()
  };
}

function mapNotificationFromRemote(row) {
  return {
    id: row.id || `ntf_${Date.now()}`,
    requestId: row.requestid || "",
    text: row.text || "",
    read: Boolean(row.read),
    createdAt: row.created_at || new Date().toISOString()
  };
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}

const MAX_VOICE_AVATAR_BYTES = 2 * 1024 * 1024;

function getTalentAvatarSrc(profile) {
  if (!profile) return "";
  return profile.avatarUrl || profile.avatarurl || profile.avatar || "";
}

function isImageAvatarSrc(src) {
  return Boolean(src && (String(src).startsWith("data:image/") || /^https?:\/\//i.test(String(src))));
}

function renderTalentAvatarHtml(profile, className = "talent-avatar", elementId = "") {
  const idAttr = elementId ? ` id="${escapeAttr(elementId)}"` : "";
  const src = getTalentAvatarSrc(profile);
  if (isImageAvatarSrc(src)) {
    return `<div class="${className} talent-avatar-img-wrap"${idAttr}><img class="talent-avatar-img" src="${escapeAttr(src)}" alt="" loading="lazy"></div>`;
  }
  const emoji = src || "🎤";
  return `<div class="${className} talent-avatar-emoji"${idAttr}>${escapeHtml(emoji)}</div>`;
}

function truncateText(text, max = 48) {
  const s = String(text || "");
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

function updateSelectedTalentUi(payload) {
  const nameEl = document.getElementById("selectedTalentName");
  const metaEl = document.getElementById("selectedTalentMeta");
  const avatarEl = document.getElementById("selectedTalentAvatar");
  if (!nameEl) return;

  if (!payload || !payload.talentId) {
    nameEl.textContent = "未選択";
    if (metaEl) metaEl.textContent = "声優一覧から選択してください";
    if (avatarEl) avatarEl.outerHTML = renderTalentAvatarHtml({}, "talent-avatar", "selectedTalentAvatar");
    return;
  }

  nameEl.textContent = payload.displayName || "未選択";
  if (metaEl) {
    const rate = payload.rateFrom ? `¥${Number(payload.rateFrom).toLocaleString()}/分〜` : "料金未設定";
    const jobs =
      payload.jobCount !== undefined && payload.jobCount !== null && payload.jobCount !== ""
        ? `経験 ${Number(payload.jobCount)}件`
        : "経験 未入力";
    metaEl.textContent = `${rate} / ${jobs}`;
  }
  if (avatarEl) {
    avatarEl.outerHTML = renderTalentAvatarHtml(payload, "talent-avatar", "selectedTalentAvatar");
  }
}

function bindVoiceAvatarPicker() {
  const fileInput = document.getElementById("voiceAvatarFile");
  const hidden = document.getElementById("voiceAvatarUrl");
  const previewHost = document.getElementById("voiceAvatarPreview");
  const clearBtn = document.getElementById("voiceAvatarClearBtn");
  if (!fileInput || !hidden || !previewHost) return;

  const setPreview = (src) => {
    hidden.value = src || "";
    previewHost.outerHTML = renderTalentAvatarHtml(
      { avatarUrl: src },
      "talent-avatar talent-avatar-preview",
      "voiceAvatarPreview"
    );
  };

  fileInput.addEventListener("change", () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setMessage("voiceMessage", "画像ファイル（JPG / PNG / WebP など）を選んでください。", "err");
      fileInput.value = "";
      return;
    }
    if (file.size > MAX_VOICE_AVATAR_BYTES) {
      setMessage("voiceMessage", "アイコンは 2MB 以下の画像にしてください。", "err");
      fileInput.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      setPreview(result);
      setMessage("voiceMessage", "アイコンを設定しました。", "ok");
    };
    reader.onerror = () => {
      setMessage("voiceMessage", "アイコンの読み込みに失敗しました。", "err");
    };
    reader.readAsDataURL(file);
  });

  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      fileInput.value = "";
      setPreview("");
    });
  }
}

function formatDateTime(value) {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString("ja-JP");
}

function getAdminCredentialConfig() {
  const fromLocal = JSON.parse(localStorage.getItem(ADMIN_CREDENTIAL_KEY) || "null");
  if (fromLocal && fromLocal.email && fromLocal.passcode) return fromLocal;
  return {
    email: "admin@wavrick.local",
    passcode: "wavrick-admin"
  };
}

async function signInAdminWithSupabase(email, password) {
  if (!isSupabaseEnabled()) {
    return { ok: false, reason: "supabase_not_enabled" };
  }

  const authResult = await supabaseClient.auth.signInWithPassword({
    email,
    password
  });
  if (authResult.error || !authResult.data || !authResult.data.user) {
    return { ok: false, reason: "auth_failed" };
  }

  const { data, error } = await supabaseClient
    .from(TABLES.adminUsers)
    .select("*")
    .ilike("email", email)
    .limit(1);
  if (error || !Array.isArray(data) || !data.length) {
    await supabaseClient.auth.signOut();
    return { ok: false, reason: "not_admin" };
  }

  const row = data[0];
  return {
    ok: true,
    account: {
      email,
      displayName: row.displayname || row.display_name || "WAVRICK運営"
    }
  };
}

async function signInUserWithSupabase(email, password) {
  if (!isSupabaseEnabled()) return { ok: false, reason: "supabase_not_enabled" };
  const result = await supabaseClient.auth.signInWithPassword({ email, password });
  if (result.error || !result.data || !result.data.user) {
    return { ok: false, reason: "auth_failed" };
  }
  return { ok: true, user: result.data.user };
}

async function signUpUserWithSupabase(email, password, role) {
  if (!isSupabaseEnabled()) return { ok: false, skipped: true };
  if (!password || password.length < 6) return { ok: false, reason: "password_short" };
  const result = await supabaseClient.auth.signUp({
    email,
    password,
    options: {
      data: { role },
      emailRedirectTo: getYtEmailAuthRedirectUrl()
    }
  });
  if (result.error) {
    const msg = String(result.error.message || "").toLowerCase();
    if (msg.includes("already registered") || msg.includes("already been registered") || msg.includes("already exists")) {
      return { ok: true, alreadyExists: true };
    }
    return { ok: false, reason: "signup_failed", error: result.error };
  }
  return { ok: true };
}

const WAVRICK_VERIFIED_EMAIL_KEY = "wavrick_verified_email";
let ytEmailVerificationBridge = null;
let supabaseAuthListenerBound = false;

function getYtEmailAuthRedirectUrl() {
  const base = getWavrickAppBase() || window.location.origin;
  return `${base.replace(/\/$/, "")}/?auth=yt_email`;
}

function markVerifiedEmailInStorage(email) {
  const normalized = (email || "").toLowerCase().trim();
  if (!normalized) return;
  try {
    sessionStorage.setItem(WAVRICK_VERIFIED_EMAIL_KEY, normalized);
  } catch (_) {
    /* ignore */
  }
}

function isEmailVerifiedForForm(email) {
  const normalized = (email || "").toLowerCase().trim();
  if (!normalized) return false;
  try {
    return sessionStorage.getItem(WAVRICK_VERIFIED_EMAIL_KEY) === normalized;
  } catch (_) {
    return false;
  }
}

function tryApplyYtEmailVerificationFromSession() {
  if (!ytEmailVerificationBridge) return;
  const formEmail = ytEmailVerificationBridge.getFormEmail();
  if (!formEmail || !isEmailVerifiedForForm(formEmail)) return;
  ytEmailVerificationBridge.markEmailDone();
  setMessage("ytMessage", wavrickI18n("yt_email_verify_success"), "ok");
}

async function syncYtEmailVerificationFromSupabaseSession() {
  if (!initSupabaseClient()) return;
  const { data, error } = await supabaseClient.auth.getSession();
  if (error || !data?.session?.user?.email) return;
  const user = data.session.user;
  if (user.email_confirmed_at || user.confirmed_at) {
    markVerifiedEmailInStorage(user.email);
    tryApplyYtEmailVerificationFromSession();
  }
}

function bindSupabaseAuthForYtEmail() {
  if (!initSupabaseClient() || supabaseAuthListenerBound) return;
  supabaseAuthListenerBound = true;
  supabaseClient.auth.onAuthStateChange((event, session) => {
    if ((event === "SIGNED_IN" || event === "TOKEN_REFRESHED") && session?.user?.email) {
      if (session.user.email_confirmed_at || session.user.confirmed_at) {
        markVerifiedEmailInStorage(session.user.email);
        tryApplyYtEmailVerificationFromSession();
        if (event === "SIGNED_IN") {
          showPage("yt");
        }
      }
    }
  });
}

async function sendYtEmailVerificationLink(email) {
  if (!initSupabaseClient()) {
    return { ok: false, reason: "supabase_not_enabled" };
  }
  const normalized = (email || "").toLowerCase().trim();
  if (!normalized.includes("@")) {
    return { ok: false, reason: "invalid_email" };
  }
  const { error } = await supabaseClient.auth.signInWithOtp({
    email: normalized,
    options: {
      emailRedirectTo: getYtEmailAuthRedirectUrl(),
      shouldCreateUser: true
    }
  });
  if (error) return { ok: false, reason: "send_failed", error };
  return { ok: true };
}

function saveLocal(key, payload) {
  const rows = JSON.parse(localStorage.getItem(key) || "[]");
  rows.push({ ...payload, createdAt: new Date().toISOString() });
  localStorage.setItem(key, JSON.stringify(rows));
}

function upsertLocalByEmail(key, payload) {
  const rows = JSON.parse(localStorage.getItem(key) || "[]");
  const email = (payload.email || "").toLowerCase().trim();
  const next = rows.filter((row) => (row.email || "").toLowerCase().trim() !== email);
  next.push({ ...payload, updatedAt: new Date().toISOString() });
  localStorage.setItem(key, JSON.stringify(next));
}

function setMessage(id, text, status) {
  const node = document.getElementById(id);
  if (!node) return;
  node.textContent = text;
  node.classList.remove("ok", "err");
  if (status) node.classList.add(status);
}

function loadVoiceProfiles() {
  const localProfiles = JSON.parse(localStorage.getItem("wavrick_voice_profiles") || "[]");
  const merged = [...mockTalents, ...localProfiles, ...remoteVoiceProfiles];
  const map = new Map();
  for (const profile of merged) {
    map.set(getTalentId(profile), profile);
  }
  return [...map.values()];
}

const TALENT_HOME_SLIDER_ROWS = 6;

function getTalentDisplayMeta(profile) {
  const name = profile.displayName || `${profile.lastName || ""} ${profile.firstName || ""}`.trim() || "未設定";
  const rateFrom = profile.rateFrom ? Number(profile.rateFrom) : null;
  const rateText = rateFrom !== null && !Number.isNaN(rateFrom) ? `¥${rateFrom.toLocaleString()}/分〜` : "料金未設定";
  const jobCount =
    profile.jobCount !== undefined && profile.jobCount !== null && profile.jobCount !== ""
      ? Number(profile.jobCount)
      : null;
  const jobsText = jobCount !== null && !Number.isNaN(jobCount) ? `経験 ${jobCount}件` : "経験 未入力";
  return { name, meta: `${rateText} / ${jobsText}` };
}

function splitProfilesIntoSliderRows(profiles, rowCount) {
  const rows = Array.from({ length: rowCount }, () => []);
  if (!profiles.length) return rows;
  profiles.forEach((profile, index) => {
    rows[index % rowCount].push(profile);
  });
  for (let i = 0; i < rowCount; i++) {
    if (!rows[i].length) rows[i] = [...profiles];
  }
  return rows;
}

function createTalentCard(profile, withButton = false, options = {}) {
  const { clickable = false } = options;
  const genres = parseGenres(profile.genres).slice(0, 3);

  const tagsHtml = genres.length
    ? genres.map((genre) => `<span class="talent-tag">${genre}</span>`).join("")
    : `<span class="talent-tag">ジャンル未設定</span>`;

  const { name, meta } = getTalentDisplayMeta(profile);
  const tid = getTalentId(profile);
  const cardClass = clickable ? "talent-card talent-card--clickable" : "talent-card";
  const clickAttrs = clickable
    ? ` data-talent-id="${tid}" role="button" tabindex="0" aria-label="${name}のプロフィールを開く"`
    : "";

  return `
    <article class="${cardClass}"${clickAttrs}>
      <div class="talent-top">
        ${renderTalentAvatarHtml(profile)}
        <div>
          <p class="talent-name">${name}</p>
          <p class="talent-meta">${meta}</p>
        </div>
      </div>
      <p class="talent-bio">${profile.bio || "自己紹介はこれから登録されます。"}</p>
      <div class="talent-tags">${tagsHtml}</div>
      ${
        withButton
          ? `<button class="talent-cta" type="button" data-select-talent-id="${tid}">この声優に依頼する</button>`
          : ""
      }
    </article>
  `;
}

function renderHomeTalentSlider(profiles) {
  const sliderRows = document.getElementById("talentSliderRows");
  if (!sliderRows) return;

  const rows = splitProfilesIntoSliderRows(profiles, TALENT_HOME_SLIDER_ROWS);
  sliderRows.innerHTML = rows
    .map((rowProfiles, rowIndex) => {
      const scrollLeft = rowIndex % 2 === 0;
      const trackClass = scrollLeft ? "talent-slider-track" : "talent-slider-track talent-slider-track--right";
      const duration = 24 + (rowIndex % 4) * 4;
      const cards = rowProfiles.map((p) => createTalentCard(p, false, { clickable: true })).join("");
      const duplicated = cards + cards;
      return `
        <div class="talent-slider-row">
          <div class="talent-slider-track ${trackClass}" style="animation-duration: ${duration}s">
            ${duplicated}
          </div>
        </div>
      `;
    })
    .join("");
}

let talentModalProfile = null;

function closeTalentProfileModal() {
  const modal = document.getElementById("talentProfileModal");
  if (!modal) return;
  modal.classList.add("hidden");
  talentModalProfile = null;
  document.body.style.overflow = "";
}

function openTalentProfileModal(profile) {
  const modal = document.getElementById("talentProfileModal");
  if (!modal || !profile) return;

  talentModalProfile = profile;
  const { name, meta } = getTalentDisplayMeta(profile);
  const genres = parseGenres(profile.genres);

  const titleEl = document.getElementById("talentModalTitle");
  const metaEl = document.getElementById("talentModalMeta");
  const bioEl = document.getElementById("talentModalBio");
  const tagsEl = document.getElementById("talentModalTags");
  const sampleEl = document.getElementById("talentModalSample");
  const avatarEl = document.getElementById("talentModalAvatar");

  if (titleEl) titleEl.textContent = name;
  if (metaEl) metaEl.textContent = meta;
  if (bioEl) bioEl.textContent = profile.bio || "自己紹介はこれから登録されます。";
  if (tagsEl) {
    tagsEl.innerHTML = genres.length
      ? genres.map((g) => `<span class="talent-tag">${g}</span>`).join("")
      : `<span class="talent-tag">ジャンル未設定</span>`;
  }
  if (sampleEl) {
    const url = (profile.sampleUrl || "").trim();
    sampleEl.innerHTML = url
      ? `音声サンプル: <a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`
      : "音声サンプル: 未登録";
  }
  if (avatarEl) {
    avatarEl.outerHTML = renderTalentAvatarHtml(profile, "talent-avatar talent-avatar-preview", "talentModalAvatar");
  }

  modal.classList.remove("hidden");
  document.body.style.overflow = "hidden";
}

function selectTalentForYtRequest(profile) {
  if (!profile) return;
  const tid = getTalentId(profile);
  const payload = {
    talentId: tid,
    displayName: profile.displayName || getTalentDisplayMeta(profile).name,
    rateFrom: profile.rateFrom || null,
    jobCount: profile.jobCount || null,
    genres: profile.genres || "",
    avatarUrl: getTalentAvatarSrc(profile)
  };
  localStorage.setItem("wavrick_selected_talent", JSON.stringify(payload));
  const ytRadioSelf = document.querySelector('#ytForm input[name="castMode"][value="self"]');
  if (ytRadioSelf) ytRadioSelf.checked = true;
  updateSelectedTalentUi(payload);
  showPage("yt");
}

function bindTalentProfileModal() {
  const modal = document.getElementById("talentProfileModal");
  if (!modal || modal.dataset.bound === "1") return;
  modal.dataset.bound = "1";

  modal.querySelectorAll("[data-close-talent-modal]").forEach((el) => {
    el.addEventListener("click", () => closeTalentProfileModal());
  });

  const requestBtn = document.getElementById("talentModalRequestBtn");
  if (requestBtn) {
    requestBtn.addEventListener("click", () => {
      if (!talentModalProfile) return;
      selectTalentForYtRequest(talentModalProfile);
      closeTalentProfileModal();
    });
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modal && !modal.classList.contains("hidden")) {
      closeTalentProfileModal();
    }
  });
}

function bindTalentSliderClicks() {
  const sliderRows = document.getElementById("talentSliderRows");
  if (!sliderRows || sliderRows.dataset.bound === "1") return;
  sliderRows.dataset.bound = "1";

  sliderRows.addEventListener("click", (e) => {
    const card = e.target && e.target.closest ? e.target.closest("[data-talent-id]") : null;
    if (!card) return;
    const tid = card.getAttribute("data-talent-id");
    if (!tid) return;
    const profile = loadVoiceProfiles().find((p) => getTalentId(p) === tid);
    if (profile) openTalentProfileModal(profile);
  });

  sliderRows.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const card = e.target && e.target.closest ? e.target.closest("[data-talent-id]") : null;
    if (!card) return;
    e.preventDefault();
    const tid = card.getAttribute("data-talent-id");
    const profile = loadVoiceProfiles().find((p) => getTalentId(p) === tid);
    if (profile) openTalentProfileModal(profile);
  });
}

function renderTalents() {
  const profiles = loadVoiceProfiles();
  const talentGrid = document.getElementById("talentGrid");
  if (!talentGrid) return;

  renderHomeTalentSlider(profiles);
  const filtered = getFilteredTalentsForGrid(profiles);
  talentGrid.innerHTML = filtered.map((profile) => createTalentCard(profile, true)).join("");
}

function getFilteredTalentsForGrid(profiles) {
  const budgetSel = document.getElementById("filterBudgetMax");
  const jobSel = document.getElementById("filterJobMin");
  const genreInput = document.getElementById("filterGenres");

  const budgetMax = budgetSel && budgetSel.value ? Number(budgetSel.value) : null;
  const jobMin = jobSel && jobSel.value ? Number(jobSel.value) : null;
  const genreText = genreInput ? genreInput.value : "";

  const desired = parseGenres(genreText).map((g) => g.toLowerCase());

  return profiles.filter((p) => {
    const rate = p.rateFrom !== undefined && p.rateFrom !== null && p.rateFrom !== "" ? Number(p.rateFrom) : null;
    const jobs = p.jobCount !== undefined && p.jobCount !== null && p.jobCount !== "" ? Number(p.jobCount) : 0;

    if (budgetMax !== null && rate !== null && !Number.isNaN(rate) && rate > budgetMax) return false;
    if (jobMin !== null && !Number.isNaN(jobs) && jobs < jobMin) return false;

    if (desired.length) {
      const score = computeGenreOverlapScore(p, genreText);
      if (score <= 0) return false;
    }

    return true;
  });
}

function bindTalentPageInteractions() {
  const applyBtn = document.getElementById("applyTalentFilterBtn");
  const resetBtn = document.getElementById("resetTalentFilterBtn");

  if (applyBtn) {
    applyBtn.addEventListener("click", () => renderTalents());
  }
  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      const budgetSel = document.getElementById("filterBudgetMax");
      const jobSel = document.getElementById("filterJobMin");
      const genreInput = document.getElementById("filterGenres");
      if (budgetSel) budgetSel.value = "";
      if (jobSel) jobSel.value = "";
      if (genreInput) genreInput.value = "";
      renderTalents();
    });
  }

  document.addEventListener("click", (e) => {
    const btn = e.target && e.target.closest ? e.target.closest("[data-select-talent-id]") : null;
    if (!btn) return;

    const tid = btn.getAttribute("data-select-talent-id");
    if (!tid) return;

    const profiles = loadVoiceProfiles();
    const selected = profiles.find((p) => getTalentId(p) === tid);
    if (!selected) return;
    selectTalentForYtRequest(selected);
  });
}

function bindVoiceForm() {
  const form = document.getElementById("voiceForm");
  if (!form) return;
  bindVoiceAvatarPicker();

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    setMessage("voiceMessage", "");

    const data = Object.fromEntries(new FormData(form).entries());
    if (!data.email.includes("@")) {
      setMessage("voiceMessage", "メールアドレスの形式を確認してください。", "err");
      return;
    }
    if (!data.sampleUrl.startsWith("http")) {
      setMessage("voiceMessage", "音声サンプルURLは http(s) で始めてください。", "err");
      return;
    }
    if (isSupabaseEnabled() && data.password && data.password.length < 6) {
      setMessage("voiceMessage", "Supabase用パスワードは6文字以上にしてください。", "err");
      return;
    }

    const signupResult = await signUpUserWithSupabase(data.email, data.password, "voice");
    if (isSupabaseEnabled() && !signupResult.ok) {
      if (signupResult.reason === "password_short") {
        setMessage("voiceMessage", "Supabase用パスワードを6文字以上で入力してください。", "err");
      } else {
        setMessage("voiceMessage", "Supabase Auth登録に失敗しました。入力を確認してください。", "err");
      }
      return;
    }

    const { password: _voicePassword, ...voiceDataForSave } = data;
    saveLocal("wavrick_voice_profiles", voiceDataForSave);
    upsertLocalByEmail("wavrick_voice_accounts", {
      role: "voice",
      email: data.email,
      displayName: data.displayName || `${data.lastName || ""} ${data.firstName || ""}`.trim()
    });
    const remoteProfileResult = await insertRemote(TABLES.voiceProfiles, mapVoiceProfileToRemote(voiceDataForSave));
    await insertRemote(
      TABLES.voiceAccounts,
      mapVoiceAccountToRemote({
        email: data.email,
        displayName: data.displayName || `${data.lastName || ""} ${data.firstName || ""}`.trim()
      })
    );
    form.reset();
    if (remoteProfileResult.ok && signupResult.ok && isSupabaseEnabled()) {
      setMessage("voiceMessage", "登録を受け付けました（Auth + Supabase + ローカル保存）。", "ok");
      await refreshRemoteVoiceProfiles();
    } else if (remoteProfileResult.ok) {
      setMessage("voiceMessage", "登録を受け付けました（Supabase + ローカル保存）。", "ok");
      await refreshRemoteVoiceProfiles();
    } else if (isSupabaseEnabled() && !remoteProfileResult.skipped) {
      setMessage("voiceMessage", "ローカル保存は成功しましたが、Supabase保存に失敗しました。", "err");
    } else {
      setMessage("voiceMessage", "登録を受け付けました（ローカル保存）。", "ok");
    }
    renderTalents();
  });

  const skipBtn = document.getElementById("voiceSkipButton");
  if (skipBtn) {
    skipBtn.addEventListener("click", async () => {
      const demoEmail = `demo-voice-${Date.now()}@example.com`;
      const demoData = {
        lastName: "デモ",
        firstName: "声優",
        displayName: "デモ声優",
        email: demoEmail,
        bio: "デモ用の声優プロフィールです。後で本物の入力に置き換えてください。",
        genres: "旅行, 教育",
        rateFrom: "8000",
        jobCount: "12",
        sampleUrl: "https://example.com/demo-sample.mp3"
      };

      saveLocal("wavrick_voice_profiles", demoData);
      upsertLocalByEmail("wavrick_voice_accounts", {
        role: "voice",
        email: demoEmail,
        displayName: demoData.displayName
      });
      await insertRemote(TABLES.voiceProfiles, mapVoiceProfileToRemote(demoData));
      await insertRemote(
        TABLES.voiceAccounts,
        mapVoiceAccountToRemote({
          email: demoEmail,
          displayName: demoData.displayName
        })
      );
      await refreshRemoteVoiceProfiles();
      renderTalents();
      showPage("talents");
    });
  }
}

function formatMediaPipelineErrorMessage(raw) {
  const m = String(raw || "");
  if (/trycloudflare|dns error|lookup address|Name or service not known|音声プロキシ.*トンネル/i.test(m)) {
    return (
      "YouTube音声の取得用トンネルが切れています。Macで wavrick-app を開き、ターミナルで ./scripts/cursor-ai-setup.sh を実行してから、もう一度お試しください。" +
      "（台本生成を使う間は、Mac上で音声プロキシとトンネルを起動したままにしてください。）"
    );
  }
  if (/解釈できません|動画URLとして/i.test(m)) {
    return `${m} 例: watch?v=11文字のID、youtu.be/ID、/shorts/ID、/live/ID のURLを試してください。`;
  }
  return m;
}

async function invokeMediaPipeline(body) {
  const { data, error } = await supabaseClient.functions.invoke("media-pipeline", { body });
  if (!error) return { data, error: null };

  let detail = error.message || String(error);
  const ctx = error.context;
  if (ctx) {
    try {
      if (typeof ctx.json === "function") {
        const parsed = await ctx.json();
        if (parsed?.error) detail = parsed.error;
        else if (parsed?.message) detail = parsed.message;
        return { data: parsed, error: { message: detail } };
      }
      if (typeof ctx.text === "function") {
        const text = await ctx.text();
        if (text) {
          try {
            const parsed = JSON.parse(text);
            if (parsed?.error) detail = parsed.error;
          } catch {
            detail = text.slice(0, 500);
          }
        }
      }
    } catch (_) {
      /* keep default detail */
    }
  }
  return { data: null, error: { message: detail } };
}

function bindMediaPipelineUi() {
  const button = document.getElementById("generateScriptButton");
  const status = document.getElementById("aiStatus");
  const scriptPreview = document.getElementById("scriptPreview");
  const scriptField = document.getElementById("ytScript");
  const videoUrlField = document.getElementById("ytVideoUrl");
  const step1 = document.getElementById("aiStep1");
  const step2 = document.getElementById("aiStep2");
  const step3 = document.getElementById("aiStep3");
  if (!button || !status || !scriptPreview || !scriptField || !videoUrlField) return;

  function resetStatusCopy() {
    if (step1) step1.textContent = "1/3 動画から音声を取得中...";
    if (step2) step2.textContent = "2/3 Whisper で文字起こし中...";
    if (step3) step3.textContent = "3/3 Grok で翻訳・台本化中...";
    [step1, step2, step3].forEach((el) => el && el.classList.remove("ai-step-active"));
  }

  button.addEventListener("click", async () => {
    const videoUrl = videoUrlField.value.trim();
    if (!isYouTubeUrl(videoUrl)) {
      setMessage(
        "ytMessage",
        "YouTube の動画URLとして認識できませんでした。例: https://www.youtube.com/watch?v=… / https://youtu.be/… / m.youtube.com のURLも利用できます。",
        "err"
      );
      return;
    }
    if (!initSupabaseClient()) {
      setMessage("ytMessage", "Supabase に接続してから利用してください（ログイン画面で URL / anon key を保存）。", "err");
      return;
    }

    setMessage("ytMessage", "");
    status.classList.remove("hidden");
    scriptPreview.classList.add("hidden");
    button.disabled = true;
    const originalLabel = button.textContent;
    button.textContent = "処理中...";
    if (step1) {
      step1.textContent = "バックエンドで処理中（音声取得 → Whisper → Grok）。長い動画は数十秒以上かかることがあります。";
      step1.classList.add("ai-step-active");
    }
    if (step2) {
      step2.textContent = "";
      step2.classList.remove("ai-step-active");
    }
    if (step3) {
      step3.textContent = "";
      step3.classList.remove("ai-step-active");
    }

    try {
      const { data, error } = await invokeMediaPipeline({ videoUrl });

      if (error && (!data || data.ok === undefined)) {
        setMessage(
          "ytMessage",
          formatMediaPipelineErrorMessage(error.message) || "パイプラインに失敗しました。",
          "err"
        );
        return;
      }
      if (data && data.ok === false) {
        setMessage(
          "ytMessage",
          formatMediaPipelineErrorMessage(data.error) || "パイプラインに失敗しました。",
          "err"
        );
        return;
      }
      if (!data || !data.ok) {
        setMessage(
          "ytMessage",
          "想定外の応答です。Supabase Dashboard → Edge Functions に media-pipeline があるか確認してください。",
          "err"
        );
        return;
      }

      const parts = [];
      parts.push("【声優向け台本（Grok）】");
      parts.push((data.script || "").trim() || "（空）");
      parts.push("");
      parts.push("【参考: 日本語訳】");
      parts.push((data.translation || "").trim() || "（空）");
      parts.push("");
      parts.push("【参考: Whisper 文字起こし（原文）】");
      parts.push((data.whisperTranscript || "").trim() || "（空）");
      scriptField.value = parts.join("\n");

      scriptPreview.classList.remove("hidden");
      const ms = typeof data.durationMs === "number" ? data.durationMs : null;
      const tail = ms != null ? `（所要約 ${Math.round(ms / 1000)} 秒）` : "";
      setMessage(
        "ytMessage",
        `台本を生成しました。ジョブ ID: ${data.jobId || "-"}（DBに蓄積済み。将来の品質改善に利用可能）${tail}`,
        "ok"
      );
    } catch (err) {
      setMessage("ytMessage", err instanceof Error ? err.message : String(err), "err");
    } finally {
      status.classList.add("hidden");
      button.disabled = false;
      button.textContent = originalLabel;
      resetStatusCopy();
    }
  });
}

function bindYtForm() {
  const form = document.getElementById("ytForm");
  if (!form) return;
  const submitButton = document.getElementById("ytSubmitButton");
  const verifyBadge = document.getElementById("verifyBadge");
  const verifyEmailBtn = document.getElementById("verifyEmailBtn");
  const verifyChannelBtn = document.getElementById("verifyChannelBtn");

  const verifyState = {
    email: false,
    channel: false,
    verifiedChannelKey: "",
    verifiedChannelId: ""
  };

  let ytOAuthPending = null;

  function applyYoutubeOAuthResult(d) {
    if (!d || d.type !== "WAVRICK_YT_OAUTH") return false;
    if (!ytOAuthPending) return false;

    const msgKey = channelKeyFromOAuthMessage(d);
    if (
      d.ok &&
      !d.channelId &&
      msgKey &&
      !channelKeysMatch(msgKey, ytOAuthPending.key)
    ) {
      return false;
    }

    if (ytOAuthPending.timer) {
      window.clearInterval(ytOAuthPending.timer);
      ytOAuthPending.timer = null;
    }
    if (ytOAuthPending.storagePoll) {
      window.clearInterval(ytOAuthPending.storagePoll);
      ytOAuthPending.storagePoll = null;
    }
    const btn = ytOAuthPending.btn;
    const pendingKey = ytOAuthPending.key;
    ytOAuthPending = null;

    try {
      sessionStorage.removeItem(WAVRICK_YT_OAUTH_STORAGE_KEY);
    } catch (_) {
      /* ignore */
    }

    if (d.ok) {
      verifyState.verifiedChannelKey = pendingKey;
      verifyState.verifiedChannelId = d.channelId || "";
      if (btn) {
        markStepDone("channel", btn, wavrickI18n("yt_channel_done"));
      } else {
        verifyState.channel = true;
      }
      let okMsg = wavrickI18n("yt_oauth_success");
      if (verifyState.verifiedChannelId) {
        okMsg +=
          wavrickI18n("yt_oauth_channel_id_prefix") +
          verifyState.verifiedChannelId +
          wavrickI18n("yt_oauth_channel_id_suffix");
      }
      setMessage("ytMessage", okMsg, "ok");
    } else if (btn) {
      btn.disabled = false;
      btn.textContent = wavrickI18n("yt_channel_btn");
      const extra = d.detail ? ` (${d.detail})` : "";
      const errText = d.code ? youtubeOAuthMessageFromCode(d.code) : wavrickI18n("yt_oauth_fail");
      setMessage("ytMessage", errText + extra, "err");
    }
    return true;
  }

  function tryConsumeYoutubeOAuthFromStorage() {
    let raw = "";
    try {
      raw = sessionStorage.getItem(WAVRICK_YT_OAUTH_STORAGE_KEY) || "";
    } catch (_) {
      return false;
    }
    if (!raw) return false;
    let wrapped = null;
    try {
      wrapped = JSON.parse(raw);
    } catch (_) {
      return false;
    }
    const ts = wrapped?.ts;
    const d = wrapped?.data;
    if (!d || d.type !== "WAVRICK_YT_OAUTH") return false;
    if (typeof ts === "number" && Date.now() - ts > 120_000) {
      try {
        sessionStorage.removeItem(WAVRICK_YT_OAUTH_STORAGE_KEY);
      } catch (_) {
        /* ignore */
      }
      return false;
    }
    return applyYoutubeOAuthResult(d);
  }

  if (!window.__wavrickYtOAuthMessageBound) {
    window.__wavrickYtOAuthMessageBound = true;
    window.addEventListener("message", (event) => {
      const localOrigin = window.location.origin;
      const supabaseOrigin = getSupabaseOriginForPostMessage();
      if (event.origin === localOrigin) {
        applyYoutubeOAuthResult(event.data);
        return;
      }
      if (!supabaseOrigin || event.origin !== supabaseOrigin) return;
      applyYoutubeOAuthResult(event.data);
    });
  }

  function refreshVerificationUi() {
    const verified = verifyState.email && verifyState.channel;
    if (submitButton) {
      submitButton.disabled = !verified;
      submitButton.textContent = verified ? "依頼を送信する" : "本人確認後に依頼を送信";
    }
    if (verifyBadge) {
      verifyBadge.textContent = verified ? "完了" : "未完了";
      verifyBadge.classList.toggle("done", verified);
    }
  }

  function markStepDone(key, button, label) {
    verifyState[key] = true;
    if (button) {
      button.classList.add("done");
      button.textContent = label + "（完了）";
      button.disabled = true;
    }
    refreshVerificationUi();
  }

  ytEmailVerificationBridge = {
    getFormEmail: () => {
      const el = document.getElementById("ytEmail");
      return el ? el.value.trim() : "";
    },
    markEmailDone: () => markStepDone("email", verifyEmailBtn, "1) メール認証")
  };

  if (isEmailVerifiedForForm(ytEmailVerificationBridge.getFormEmail())) {
    markStepDone("email", verifyEmailBtn, "1) メール認証");
  }

  if (verifyEmailBtn) {
    verifyEmailBtn.addEventListener("click", async () => {
      const email = ytEmailVerificationBridge.getFormEmail();
      if (!email.includes("@")) {
        setMessage("ytMessage", "先にメールアドレスを入力してください。", "err");
        return;
      }
      if (!isSupabaseEnabled() && !initSupabaseClient()) {
        markStepDone("email", verifyEmailBtn, "1) メール認証を完了");
        setMessage(
          "ytMessage",
          "Supabase 未接続のためデモで完了扱いにしました。本番では接続設定を確認してください。",
          "ok"
        );
        return;
      }
      bindSupabaseAuthForYtEmail();
      verifyEmailBtn.disabled = true;
      const prevLabel = verifyEmailBtn.textContent;
      verifyEmailBtn.textContent = wavrickI18n("yt_email_verify_sending");
      const result = await sendYtEmailVerificationLink(email);
      verifyEmailBtn.disabled = false;
      if (!result.ok) {
        verifyEmailBtn.textContent = prevLabel;
        const detail = result.error?.message ? ` (${result.error.message})` : "";
        setMessage("ytMessage", `${wavrickI18n("yt_email_verify_fail")}${detail}`, "err");
        return;
      }
      verifyEmailBtn.textContent = wavrickI18n("yt_email_verify_sent_btn");
      setMessage("ytMessage", wavrickI18n("yt_email_verify_sent"), "ok");
    });
  }

  if (verifyChannelBtn) {
    verifyChannelBtn.addEventListener("click", () => {
      const channelField = document.getElementById("ytChannelUrl");
      const key = normalizeYoutubeChannelKey(channelField ? channelField.value : "");
      if (!key) {
        setMessage("ytMessage", "先にチャンネルURLを正しい形式で入力してください。", "err");
        return;
      }
      if (!isSupabaseEnabled()) {
        setMessage(
          "ytMessage",
          "Google による所有確認には、ログイン画面で Supabase に接続したうえで Edge Function（youtube-oauth-start / youtube-oauth-callback）をデプロイしてください。",
          "err"
        );
        return;
      }
      const parentBase = getWavrickAppBase();
      if (!parentBase || parentBase === "null") {
        setMessage(
          "ytMessage",
          "このページの URL が取得できません。http(s) のローカルサーバまたは本番URLで開いてください（file:// では利用できません）。",
          "err"
        );
        return;
      }
      const startUrl = buildYoutubeOAuthStartUrl(key, parentBase);
      if (!startUrl) {
        setMessage("ytMessage", "Supabase URL を取得できませんでした。", "err");
        return;
      }
      if (window.location.protocol === "file:") {
        setMessage(
          "ytMessage",
          "file:// では OAuth できません。プロジェクトで python3 -m http.server 8889 を起動し、http://localhost:8889 で開いてください。",
          "err"
        );
        return;
      }
      verifyChannelBtn.disabled = true;
      verifyChannelBtn.textContent = wavrickI18n("yt_channel_opening");
      const popup = window.open(startUrl, "wavrick_yt_oauth", "width=560,height=720");
      if (!popup) {
        verifyChannelBtn.disabled = false;
        verifyChannelBtn.textContent = wavrickI18n("yt_channel_btn");
        setMessage(
          "ytMessage",
          "ポップアップがブロックされました。ブラウザでこのサイトのポップアップを許可してください。",
          "err"
        );
        return;
      }
      verifyChannelBtn.textContent = wavrickI18n("yt_channel_wait");
      ytOAuthPending = { key, btn: verifyChannelBtn, timer: null, storagePoll: null };
      ytOAuthPending.storagePoll = window.setInterval(() => {
        tryConsumeYoutubeOAuthFromStorage();
      }, 350);
      ytOAuthPending.timer = window.setInterval(() => {
        if (!popup.closed) {
          tryConsumeYoutubeOAuthFromStorage();
          return;
        }
        tryConsumeYoutubeOAuthFromStorage();
        const p = ytOAuthPending;
        if (p?.timer) window.clearInterval(p.timer);
        if (p?.storagePoll) window.clearInterval(p.storagePoll);
        if (p) {
          p.timer = null;
          p.storagePoll = null;
        }
        if (p && !verifyState.channel && p.btn === verifyChannelBtn) {
          verifyChannelBtn.disabled = false;
          verifyChannelBtn.textContent = wavrickI18n("yt_channel_btn");
          setMessage("ytMessage", wavrickI18n("yt_oauth_postmessage_fail"), "err");
        }
        if (ytOAuthPending === p) ytOAuthPending = null;
      }, 600);
    });
  }

  refreshVerificationUi();

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    setMessage("ytMessage", "");
    initSupabaseClient();
    const data = Object.fromEntries(new FormData(form).entries());
    const verified = verifyState.email && verifyState.channel;

    if (!data.email.includes("@")) {
      setMessage("ytMessage", "メールアドレスの形式を確認してください。", "err");
      return;
    }
    data.videoChannelUrl = data.channelUrl;
    if (!isYouTubeUrl(data.channelUrl) || !isYouTubeUrl(data.videoUrl)) {
      setMessage("ytMessage", "YouTube URLの形式を確認してください。", "err");
      return;
    }
    if (!verified) {
      setMessage("ytMessage", "依頼送信の前に、本人確認（①メール ②チャンネル所有）を完了してください。", "err");
      return;
    }
    if (isSupabaseEnabled() && data.password && data.password.length < 6) {
      setMessage("ytMessage", "Supabase用パスワードは6文字以上にしてください。", "err");
      return;
    }

    const requestChannelKey = normalizeYoutubeChannelKey(data.channelUrl);
    if (!requestChannelKey) {
      setMessage("ytMessage", "チャンネルURLは /@name や /channel/ID 形式で入力してください。", "err");
      return;
    }
    const channelOk =
      channelKeysMatch(verifyState.verifiedChannelKey, requestChannelKey) ||
      (verifyState.verifiedChannelId &&
        requestChannelKey.startsWith("channel:") &&
        requestChannelKey.slice(8).toLowerCase() === verifyState.verifiedChannelId.toLowerCase());
    if (!channelOk) {
      setMessage("ytMessage", "認証済みチャンネルと入力チャンネルが一致しません。URLを確認してください。", "err");
      return;
    }

    const castMode = data.castMode || "self";
    const selected = JSON.parse(localStorage.getItem("wavrick_selected_talent") || "null");
    if (!selected || !selected.talentId) {
      setMessage("ytMessage", "声優を選択してください（声優一覧かおすすめ提案で選べます）。", "err");
      return;
    }
    data.castMode = castMode;
    data.selectedTalentId = selected.talentId;
    data.selectedTalentName = selected.displayName || "";
    data.requestId = generateRequestId();
    data.status = REQUEST_STATUS_FLOW[0];

    let signupResult = { ok: true, skipped: true };
    const signupPassword = (data.password || "").trim();
    if (isSupabaseEnabled() && signupPassword) {
      if (signupPassword.length < 6) {
        setMessage("ytMessage", "Supabase用パスワードは6文字以上にしてください。", "err");
        return;
      }
      signupResult = await signUpUserWithSupabase(data.email, signupPassword, "customer");
      if (!signupResult.ok) {
        const detail = signupResult.error?.message ? ` (${signupResult.error.message})` : "";
        setMessage("ytMessage", `Supabase Auth登録に失敗しました。${detail}`, "err");
        return;
      }
    }

    const { password: _customerPassword, ...ytDataForSave } = data;
    ytDataForSave.identityProofText = "メール確認+YouTubeチャンネル所有確認まで";
    saveLocal("wavrick_youtube_requests", ytDataForSave);
    const workflows = getWorkflows();
    workflows[ytDataForSave.requestId] = {
      requestId: ytDataForSave.requestId,
      status: ytDataForSave.status,
      messages: [],
      quoteAmount: "",
      paymentStatus: "unpaid",
      stripeUrl: "",
      deliveries: [],
      revisionCount: 0,
      updatedAt: new Date().toISOString()
    };
    saveWorkflows(workflows);
    if (isSupabaseEnabled()) {
      await upsertRemote(
        TABLES.requestWorkflows,
        mapWorkflowToRemote(workflows[ytDataForSave.requestId]),
        "requestid"
      );
    }
    pushNotification(`新規案件が作成されました: ${ytDataForSave.name}`, ytDataForSave.requestId);
    upsertLocalByEmail("wavrick_customer_accounts", {
      role: "customer",
      email: ytDataForSave.email,
      name: ytDataForSave.name,
      channelUrl: ytDataForSave.channelUrl
    });
    const requestResult = await insertRemote(TABLES.youtubeRequests, mapYoutubeRequestToRemote(ytDataForSave));
    await insertRemote(
      TABLES.customerAccounts,
      mapCustomerAccountToRemote({
        email: ytDataForSave.email,
        name: ytDataForSave.name,
        channelUrl: ytDataForSave.channelUrl
      })
    );
    form.reset();
    [verifyEmailBtn, verifyChannelBtn].forEach((btn) => {
      if (!btn) return;
      btn.disabled = false;
      btn.classList.remove("done");
    });
    if (verifyEmailBtn) verifyEmailBtn.textContent = "1) 確認メールを送信";
    if (verifyChannelBtn) verifyChannelBtn.textContent = "2) Googleでチャンネル所有を確認";
    verifyState.email = false;
    verifyState.channel = false;
    verifyState.verifiedChannelKey = "";
    verifyState.verifiedChannelId = "";
    refreshVerificationUi();
    tryApplyYtEmailVerificationFromSession();
    const sp = document.getElementById("scriptPreview");
    if (sp) sp.classList.add("hidden");
    if (requestResult.ok && signupResult.ok && isSupabaseEnabled()) {
      setMessage("ytMessage", "依頼を受け付けました（Auth + Supabase + ローカル保存）。", "ok");
    } else if (requestResult.ok) {
      setMessage("ytMessage", "依頼を受け付けました（Supabase + ローカル保存）。", "ok");
    } else if (isSupabaseEnabled() && !requestResult.skipped) {
      const detail = requestResult.error?.message || requestResult.error?.hint || "";
      setMessage(
        "ytMessage",
        detail
          ? `ローカル保存は成功しましたが、Supabase保存に失敗しました: ${detail}`
          : "ローカル保存は成功しましたが、Supabase保存に失敗しました。",
        "err"
      );
    } else if (!isSupabaseEnabled()) {
      setMessage(
        "ytMessage",
        "依頼を受け付けました（ローカル保存のみ）。Supabaseに繋がっていません。ログイン画面の「接続設定を保存」か index.html の WAVRICK_CONFIG を確認し、ページを再読み込みしてください。",
        "err"
      );
    } else {
      setMessage("ytMessage", "依頼を受け付けました（ローカル保存）。", "ok");
    }
  });

  // ===== Casting mode UI (self / recommend) =====
  const ytRadioSelf = form.querySelector('input[name="castMode"][value="self"]');
  const ytRadioRecommend = form.querySelector('input[name="castMode"][value="recommend"]');
  const castSelfBox = document.getElementById("castSelfBox");
  const castRecommendBox = document.getElementById("castRecommendBox");
  const chooseTalentBtn = document.getElementById("chooseTalentBtn");
  const recommendBtn = document.getElementById("recommendTalentBtn");
  const recommendMessage = document.getElementById("recommendMessage");
  const selectedTalentNameEl = document.getElementById("selectedTalentName");

  function refreshCastUi() {
    const mode = form.querySelector('input[name="castMode"]:checked')?.value || "self";
    if (mode === "self") {
      if (castSelfBox) castSelfBox.classList.remove("hidden");
      if (castRecommendBox) castRecommendBox.classList.add("hidden");
    } else {
      if (castSelfBox) castSelfBox.classList.add("hidden");
      if (castRecommendBox) castRecommendBox.classList.remove("hidden");
    }
  }

  function loadSelectedTalentIntoUi() {
    const stored = JSON.parse(localStorage.getItem("wavrick_selected_talent") || "null");
    updateSelectedTalentUi(stored);
    if (stored && ytRadioSelf) ytRadioSelf.checked = true;
    refreshCastUi();
  }

  function recommendTalent() {
    const recGenres = document.getElementById("recGenres")?.value || "";
    const recBudgetMax = document.getElementById("recBudgetMax")?.value || "";
    const recJobMin = document.getElementById("recJobMin")?.value || "";

    const budgetMax = recBudgetMax ? Number(recBudgetMax) : null;
    const jobMin = recJobMin ? Number(recJobMin) : null;

    const profiles = loadVoiceProfiles();
    const candidates = profiles
      .map((p) => {
        const genreScore = computeGenreOverlapScore(p, recGenres);
        const rateOk = budgetMax === null ? true : (p.rateFrom ? Number(p.rateFrom) <= budgetMax : false);
        const jobsOk = jobMin === null ? true : ((p.jobCount ? Number(p.jobCount) : 0) >= jobMin);
        const total = genreScore * 10 + (rateOk ? 3 : 0) + (jobsOk ? 2 : 0);
        return { p, genreScore, rateOk, jobsOk, total };
      })
      .filter((x) => (recGenres.trim() ? x.genreScore > 0 : true) && x.rateOk && x.jobsOk);

    if (!candidates.length) {
      if (recommendMessage) {
        setMessage("recommendMessage", "条件に合う声優が見つかりません。絞り込みをゆるくしてみてください。", "err");
      }
      return;
    }

    candidates.sort((a, b) => b.total - a.total);
    const best = candidates[0].p;
    const tid = getTalentId(best);

    const recommendPayload = {
      talentId: tid,
      displayName: best.displayName,
      rateFrom: best.rateFrom || null,
      jobCount: best.jobCount || null,
      genres: best.genres || "",
      avatarUrl: getTalentAvatarSrc(best)
    };
    localStorage.setItem("wavrick_selected_talent", JSON.stringify(recommendPayload));

    updateSelectedTalentUi(recommendPayload);
    if (recommendMessage) setMessage("recommendMessage", `おすすめしました：${best.displayName}`, "ok");

    if (ytRadioSelf) ytRadioSelf.checked = true;
    refreshCastUi();
  }

  if (ytRadioSelf) ytRadioSelf.addEventListener("change", refreshCastUi);
  if (ytRadioRecommend) ytRadioRecommend.addEventListener("change", refreshCastUi);
  if (chooseTalentBtn) chooseTalentBtn.addEventListener("click", () => showPage("talents"));
  if (recommendBtn) recommendBtn.addEventListener("click", recommendTalent);

  // ===== Demo skip (no need to fill) =====
  const ytSkipBtn = document.getElementById("ytSkipButton");
  if (ytSkipBtn) {
    ytSkipBtn.addEventListener("click", () => {
      const demoEmail = `demo-customer-${Date.now()}@example.com`;
      const demoHandle = "wavrick_demo";
      const demoChannelUrl = `https://www.youtube.com/@${demoHandle}`;
      const demoVideoUrl = `https://www.youtube.com/watch?v=dQw4w9WgXcQ`;

      const ytNameEl = document.getElementById("ytName");
      const ytEmailEl = document.getElementById("ytEmail");
      const ytChannelUrlEl = document.getElementById("ytChannelUrl");
      const ytVideoUrlEl = document.getElementById("ytVideoUrl");
      if (ytNameEl) ytNameEl.value = "デモ顧客";
      if (ytEmailEl) ytEmailEl.value = demoEmail;
      if (ytChannelUrlEl) ytChannelUrlEl.value = demoChannelUrl;
      if (ytVideoUrlEl) ytVideoUrlEl.value = demoVideoUrl;

      const btnEmail = document.getElementById("verifyEmailBtn");
      const btnChannel = document.getElementById("verifyChannelBtn");
      if (btnEmail) btnEmail.click();
      if (btnChannel) {
        const verifyKey = normalizeYoutubeChannelKey(demoChannelUrl);
        verifyState.verifiedChannelKey = verifyKey;
        markStepDone("channel", btnChannel, "2) デモ: チャンネル所有（本番はGoogle）");
      }

      showPage("talents");
    });
  }

  refreshCastUi();
  loadSelectedTalentIntoUi();
}

function toAdminSourceRows(rows, source) {
  return (rows || []).map((row) => ({ ...row, source }));
}

function normalizeAdminEmail(value) {
  return (value || "").toLowerCase().trim();
}

function isVoiceActorRow(row) {
  const role = (row.role || "").toLowerCase();
  if (role === "voice") return true;
  if (row.genres || row.displayName || row.sampleUrl || row.bio) return true;
  return false;
}

function collectVoiceEmailSet(voiceProfiles, voiceAccounts) {
  const set = new Set();
  for (const row of [...voiceProfiles, ...voiceAccounts]) {
    const email = normalizeAdminEmail(row.email);
    if (email) set.add(email);
  }
  return set;
}

function buildAdminYoutuberRows(requestRows, customerRows, voiceEmails) {
  const map = new Map();
  for (const row of customerRows) {
    const email = normalizeAdminEmail(row.email);
    if (!email || voiceEmails.has(email) || isVoiceActorRow(row)) continue;
    map.set(email, {
      email: row.email,
      name: row.name || "",
      channelUrl: row.channelUrl || "",
      createdAt: row.createdAt || row.updatedAt || "",
      source: row.source || "local"
    });
  }
  for (const row of requestRows) {
    const email = normalizeAdminEmail(row.email);
    if (!email || voiceEmails.has(email)) continue;
    const prev = map.get(email) || {};
    const source =
      row.source === "supabase" || prev.source === "supabase" ? "supabase" : row.source || prev.source || "local";
    map.set(email, {
      email: row.email || prev.email,
      name: row.name || prev.name || "",
      channelUrl: row.channelUrl || prev.channelUrl || "",
      createdAt: row.createdAt || prev.createdAt || "",
      source
    });
  }
  return [...map.values()].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
}

function buildAdminVoiceRows(voiceProfiles) {
  const map = new Map();
  for (const row of voiceProfiles) {
    const email = normalizeAdminEmail(row.email);
    if (!email) continue;
    map.set(email, {
      displayName: row.displayName || "",
      email: row.email,
      genres: row.genres || "",
      rateFrom: row.rateFrom || "",
      avatarUrl: row.avatarUrl || "",
      createdAt: row.createdAt || "",
      source: row.source || "local"
    });
  }
  return [...map.values()].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
}

function matchesAdminFilters(row, keyword, sourceFilter) {
  if (sourceFilter !== "all" && row.source !== sourceFilter) return false;
  if (!keyword) return true;
  const haystack = [
    row.email,
    row.name,
    row.displayName,
    row.channelUrl,
    row.videoUrl,
    row.selectedTalentName,
    row.genres,
    row.identityProofText
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(keyword);
}

function adminSourceBadge(source) {
  const isRemote = source === "supabase";
  const label = isRemote ? "Supabase" : "local";
  return `<span class="admin-badge ${isRemote ? "badge-supabase" : "badge-local"}">${label}</span>`;
}

function adminLinkCell(url, label) {
  const raw = String(url || "").trim();
  if (!raw || raw === "-") return `<span class="admin-muted">-</span>`;
  const safeUrl = escapeAttr(raw);
  const text = escapeHtml(label || truncateText(raw, 42));
  return `<a class="admin-link" href="${safeUrl}" target="_blank" rel="noreferrer">${text}</a>`;
}

function switchAdminTab(tabName) {
  document.querySelectorAll("[data-admin-tab]").forEach((btn) => {
    const active = btn.getAttribute("data-admin-tab") === tabName;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
  });
  document.querySelectorAll("[data-admin-panel]").forEach((panel) => {
    const show = panel.getAttribute("data-admin-panel") === tabName;
    panel.classList.toggle("active", show);
    if (show) panel.removeAttribute("hidden");
    else panel.setAttribute("hidden", "");
  });
}

function bindAdminTabs() {
  document.querySelectorAll("[data-admin-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.getAttribute("data-admin-tab");
      if (tab) switchAdminTab(tab);
    });
  });
}

function renderAdminRequestsBody(rows) {
  const body = document.getElementById("adminRequestsBody");
  if (!body) return;
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="6" class="admin-empty">データがありません。</td></tr>`;
    return;
  }
  body.innerHTML = rows
    .map((row) => {
      const who = `<div class="admin-cell-stack"><strong>${escapeHtml(row.name || "-")}</strong><span class="admin-muted">${escapeHtml(row.email || "-")}</span></div>`;
      const idCell = escapeHtml(row.identityProofText || "-");
      return `<tr>
        <td class="admin-nowrap">${escapeHtml(row.createdAtText || "-")}</td>
        <td>${who}</td>
        <td>${adminLinkCell(row.videoUrl)}</td>
        <td>${escapeHtml(row.selectedTalentName || "-")}</td>
        <td class="admin-identity-col">${idCell}</td>
        <td>${adminSourceBadge(row.source)}</td>
      </tr>`;
    })
    .join("");
}

function renderAdminCustomersBody(rows) {
  const body = document.getElementById("adminCustomersBody");
  if (!body) return;
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="4" class="admin-empty">データがありません。</td></tr>`;
    return;
  }
  body.innerHTML = rows
    .map(
      (row) => `<tr>
        <td><strong>${escapeHtml(row.name || "-")}</strong></td>
        <td>${escapeHtml(row.email || "-")}</td>
        <td>${adminLinkCell(row.channelUrl)}</td>
        <td>${adminSourceBadge(row.source)}</td>
      </tr>`
    )
    .join("");
}

function renderAdminVoicesBody(rows) {
  const body = document.getElementById("adminVoicesBody");
  if (!body) return;
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="6" class="admin-empty">データがありません。</td></tr>`;
    return;
  }
  body.innerHTML = rows
    .map(
      (row) => `<tr>
        <td class="admin-avatar-col">${renderTalentAvatarHtml(row, "talent-avatar admin-table-avatar")}</td>
        <td><strong>${escapeHtml(row.displayName || "-")}</strong></td>
        <td>${escapeHtml(row.email || "-")}</td>
        <td>${escapeHtml(truncateText(row.genres || "-", 36))}</td>
        <td class="admin-nowrap">${escapeHtml(row.rateText || "-")}</td>
        <td>${adminSourceBadge(row.source)}</td>
      </tr>`
    )
    .join("");
}

function renderAdminDashboard() {
  const searchInput = document.getElementById("adminSearchInput");
  const sourceFilterEl = document.getElementById("adminSourceFilter");
  const keyword = (searchInput ? searchInput.value : "").trim().toLowerCase();
  const sourceFilter = sourceFilterEl ? sourceFilterEl.value : "all";

  const filteredRequests = adminDataState.requests.filter((row) =>
    matchesAdminFilters(row, keyword, sourceFilter)
  );
  const filteredYoutubers = adminDataState.youtubers.filter((row) =>
    matchesAdminFilters(row, keyword, sourceFilter)
  );
  const filteredVoices = adminDataState.voices.filter((row) =>
    matchesAdminFilters(row, keyword, sourceFilter)
  );

  const statRequests = document.getElementById("adminStatRequests");
  const statRequestsToday = document.getElementById("adminStatRequestsToday");
  const statCustomers = document.getElementById("adminStatCustomers");
  const statVoices = document.getElementById("adminStatVoices");
  const now = Date.now();
  const requestsToday = filteredRequests.filter((row) => {
    const t = new Date(row.createdAt || 0).getTime();
    return t && now - t <= 24 * 60 * 60 * 1000;
  }).length;
  if (statRequests) statRequests.textContent = String(filteredRequests.length);
  if (statRequestsToday) statRequestsToday.textContent = String(requestsToday);
  if (statCustomers) statCustomers.textContent = String(filteredYoutubers.length);
  if (statVoices) statVoices.textContent = String(filteredVoices.length);

  const countRequests = document.getElementById("adminRequestsCount");
  const countCustomers = document.getElementById("adminCustomersCount");
  const countVoices = document.getElementById("adminVoicesCount");
  if (countRequests) countRequests.textContent = `${filteredRequests.length} 件`;
  if (countCustomers) countCustomers.textContent = `${filteredYoutubers.length} 件`;
  if (countVoices) countVoices.textContent = `${filteredVoices.length} 件`;

  renderAdminRequestsBody(
    filteredRequests.map((row) => ({
      createdAtText: formatDateTime(row.createdAt),
      name: row.name || "-",
      email: row.email || "-",
      videoUrl: row.videoUrl || "-",
      selectedTalentName: row.selectedTalentName || "-",
      identityProofText: row.identityProofText || "",
      source: row.source || "local"
    }))
  );

  renderAdminCustomersBody(
    filteredYoutubers.map((row) => ({
      email: row.email || "-",
      name: row.name || "-",
      channelUrl: row.channelUrl || "-",
      source: row.source || "local"
    }))
  );

  renderAdminVoicesBody(
    filteredVoices.map((row) => ({
      displayName: row.displayName || "-",
      email: row.email || "-",
      genres: row.genres || "-",
      rateText: row.rateFrom ? `¥${Number(row.rateFrom).toLocaleString()}/分〜` : "-",
      avatarUrl: row.avatarUrl || "",
      source: row.source || "local"
    }))
  );
}

async function loadAdminData() {
  const localRequests = JSON.parse(localStorage.getItem("wavrick_youtube_requests") || "[]");
  const localCustomers = JSON.parse(localStorage.getItem("wavrick_customer_accounts") || "[]");
  const localVoiceAccounts = JSON.parse(localStorage.getItem("wavrick_voice_accounts") || "[]");
  const localVoices = JSON.parse(localStorage.getItem("wavrick_voice_profiles") || "[]");

  const localMappedRequests = toAdminSourceRows(
    (Array.isArray(localRequests) ? localRequests : []).map((row) => ({
      name: row.name || "",
      email: row.email || "",
      channelUrl: row.channelUrl || "",
      videoUrl: row.videoUrl || "",
      selectedTalentName: row.selectedTalentName || "",
      createdAt: row.createdAt || "",
      identityProofText: row.identityProofText || ""
    })),
    "local"
  );
  const localMappedCustomers = toAdminSourceRows(
    (Array.isArray(localCustomers) ? localCustomers : []).map((row) => ({
      email: row.email || "",
      name: row.name || "",
      channelUrl: row.channelUrl || "",
      role: row.role || "customer",
      createdAt: row.createdAt || row.updatedAt || ""
    })),
    "local"
  );
  const localMappedVoices = toAdminSourceRows(
    (Array.isArray(localVoices) ? localVoices : []).map((row) => ({
      displayName: row.displayName || "",
      email: row.email || "",
      genres: row.genres || "",
      rateFrom: row.rateFrom || "",
      avatarUrl: row.avatarUrl || "",
      role: "voice",
      createdAt: row.createdAt || ""
    })),
    "local"
  );
  const localMappedVoiceAccounts = toAdminSourceRows(
    (Array.isArray(localVoiceAccounts) ? localVoiceAccounts : []).map((row) => ({
      email: row.email || "",
      displayName: row.displayName || "",
      role: row.role || "voice",
      createdAt: row.createdAt || row.updatedAt || ""
    })),
    "local"
  );

  let remoteRequests = [];
  let remoteCustomers = [];
  let remoteVoices = [];
  let remoteVoiceAccounts = [];
  if (isSupabaseEnabled()) {
    remoteRequests = toAdminSourceRows(await fetchRemoteYoutubeRequests(), "supabase");
    remoteCustomers = toAdminSourceRows(await fetchRemoteCustomerAccounts(), "supabase");
    remoteVoices = toAdminSourceRows(await fetchRemoteVoiceProfiles(), "supabase");
    remoteVoiceAccounts = toAdminSourceRows(await fetchRemoteVoiceAccounts(), "supabase");
  }

  const voiceEmails = collectVoiceEmailSet(
    [...remoteVoices, ...localMappedVoices],
    [...remoteVoiceAccounts, ...localMappedVoiceAccounts]
  );
  const allRequests = [...remoteRequests, ...localMappedRequests];
  const allCustomerRows = [...remoteCustomers, ...localMappedCustomers];

  adminDataState = {
    requests: allRequests,
    youtubers: buildAdminYoutuberRows(allRequests, allCustomerRows, voiceEmails),
    voices: buildAdminVoiceRows([...remoteVoices, ...localMappedVoices])
  };
  renderAdminDashboard();
}

function toCsvLine(values) {
  return values
    .map((v) => `"${String(v || "").replace(/"/g, '""')}"`)
    .join(",");
}

function downloadCsv(filename, lines) {
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function bindAdminDashboard() {
  const refreshBtn = document.getElementById("adminRefreshBtn");
  const exportBtn = document.getElementById("adminExportRequestsBtn");
  const searchInput = document.getElementById("adminSearchInput");
  const sourceFilter = document.getElementById("adminSourceFilter");
  if (!refreshBtn || !exportBtn || !searchInput || !sourceFilter) return;

  bindAdminTabs();

  refreshBtn.addEventListener("click", async () => {
    await loadAdminData();
    setMessage("adminMessage", "管理データを最新化しました。", "ok");
  });

  exportBtn.addEventListener("click", () => {
    const lines = [
      toCsvLine(["createdAt", "name", "email", "videoUrl", "selectedTalentName", "identityProofText", "source"])
    ];
    adminDataState.requests.forEach((row) => {
      lines.push(
        toCsvLine([
          row.createdAt || "",
          row.name || "",
          row.email || "",
          row.videoUrl || "",
          row.selectedTalentName || "",
          row.identityProofText || "",
          row.source
        ])
      );
    });
    downloadCsv(`wavrick-requests-${Date.now()}.csv`, lines);
    setMessage("adminMessage", "依頼一覧CSVを出力しました。", "ok");
  });

  searchInput.addEventListener("input", renderAdminDashboard);
  sourceFilter.addEventListener("change", renderAdminDashboard);
}

function getVisibleRequestsForCurrentSession() {
  const session = getCurrentSession();
  const rows = JSON.parse(localStorage.getItem("wavrick_youtube_requests") || "[]");
  if (!session) return [];
  if (session.role === "admin") return rows;
  if (session.role === "customer") return rows.filter((r) => (r.email || "").toLowerCase() === (session.email || "").toLowerCase());
  if (session.role === "voice") {
    const selected = JSON.parse(localStorage.getItem("wavrick_selected_talent") || "null");
    const tid = selected && selected.talentId ? selected.talentId : "";
    return rows.filter((r) => (r.selectedTalentId || "") === tid);
  }
  return [];
}

function renderWorkStatusTimeline(status) {
  const wrap = document.getElementById("workStatusTimeline");
  if (!wrap) return;
  const activeIndex = REQUEST_STATUS_FLOW.indexOf(status);
  wrap.innerHTML = REQUEST_STATUS_FLOW
    .map((label, idx) => `<span class="status-pill ${idx <= activeIndex ? "done" : ""}">${escapeHtml(label)}</span>`)
    .join("");
}

function renderWorkDetails(request) {
  const workflows = getWorkflows();
  const wf = workflows[request.requestId] || {
    requestId: request.requestId,
    status: request.status || REQUEST_STATUS_FLOW[0],
    messages: [],
    quoteAmount: "",
    paymentStatus: "unpaid",
    stripeUrl: "",
    deliveries: [],
    revisionCount: 0
  };

  const statusSelect = document.getElementById("workStatusSelect");
  if (statusSelect) statusSelect.value = wf.status || REQUEST_STATUS_FLOW[0];
  renderWorkStatusTimeline(wf.status || REQUEST_STATUS_FLOW[0]);

  const chatList = document.getElementById("workChatList");
  if (chatList) {
    const rows = wf.messages || [];
    chatList.innerHTML = rows.length
      ? rows.map((m) => `<div class="chat-item"><strong>${escapeHtml(m.sender)}</strong> (${formatDateTime(m.createdAt)}): ${escapeHtml(m.text)}</div>`).join("")
      : `<div class="chat-item">まだメッセージはありません。</div>`;
  }

  const quoteInput = document.getElementById("workQuoteAmount");
  const paymentStatus = document.getElementById("workPaymentStatus");
  const stripeUrl = document.getElementById("workStripeUrl");
  if (quoteInput) quoteInput.value = wf.quoteAmount || "";
  if (paymentStatus) paymentStatus.value = wf.paymentStatus || "unpaid";
  if (stripeUrl) stripeUrl.value = wf.stripeUrl || "";

  const deliveriesList = document.getElementById("workDeliveriesList");
  if (deliveriesList) {
    const rows = wf.deliveries || [];
    deliveriesList.innerHTML = rows.length
      ? rows.map((d) => `<div class="delivery-item">${formatDateTime(d.createdAt)} / <a href="${escapeHtml(d.url)}" target="_blank" rel="noreferrer">${escapeHtml(d.url)}</a> / ${escapeHtml(d.note)}</div>`).join("")
      : `<div class="delivery-item">納品物はまだありません。</div>`;
  }

  const revision = document.getElementById("workRevisionCount");
  if (revision) revision.textContent = `修正依頼回数: ${wf.revisionCount || 0}`;
}

function renderWorkNotifications(requestId) {
  const list = document.getElementById("workNotificationsList");
  if (!list) return;
  const rows = getNotifications().filter((n) => !requestId || n.requestId === requestId);
  list.innerHTML = rows.length
    ? rows.map((n) => `<div class="notice-item ${n.read ? "" : "unread"}">${formatDateTime(n.createdAt)} - ${escapeHtml(n.text)}</div>`).join("")
    : `<div class="notice-item">通知はありません。</div>`;
}

function bindWorkPage() {
  if (isWorkPageBound) return;
  isWorkPageBound = true;
  const requestSelect = document.getElementById("workRequestSelect");
  const statusSelect = document.getElementById("workStatusSelect");
  const saveStatusBtn = document.getElementById("saveWorkStatusBtn");
  const sendChatBtn = document.getElementById("sendWorkChatBtn");
  const saveQuoteBtn = document.getElementById("saveWorkQuoteBtn");
  const addDeliveryBtn = document.getElementById("addWorkDeliveryBtn");
  const addRevisionBtn = document.getElementById("addRevisionRequestBtn");
  const markReadBtn = document.getElementById("markAllNoticeReadBtn");
  if (!requestSelect || !statusSelect || !saveStatusBtn || !sendChatBtn || !saveQuoteBtn || !addDeliveryBtn || !addRevisionBtn || !markReadBtn) return;

  statusSelect.innerHTML = REQUEST_STATUS_FLOW.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join("");

  async function refreshRequestOptions() {
    await hydrateRemoteWorkData();
    const rows = getVisibleRequestsForCurrentSession();
    requestSelect.innerHTML = rows.length
      ? rows.map((r) => `<option value="${escapeHtml(r.requestId)}">${escapeHtml(r.name || "-")} / ${escapeHtml(r.videoUrl || "-")}</option>`).join("")
      : `<option value="">案件がありません</option>`;
    if (rows.length) {
      const selected = rows[0];
      renderWorkDetails(selected);
      renderWorkNotifications(selected.requestId);
    } else {
      renderWorkStatusTimeline(REQUEST_STATUS_FLOW[0]);
      renderWorkNotifications("");
    }
  }

  function findCurrentRequest() {
    const rows = getVisibleRequestsForCurrentSession();
    return rows.find((r) => r.requestId === requestSelect.value) || null;
  }

  async function updateWorkflow(mutator) {
    const request = findCurrentRequest();
    if (!request) {
      setMessage("workMessage", "対象案件がありません。", "err");
      return null;
    }
    const workflows = getWorkflows();
    const current = workflows[request.requestId] || {
      requestId: request.requestId,
      status: request.status || REQUEST_STATUS_FLOW[0],
      messages: [],
      quoteAmount: "",
      paymentStatus: "unpaid",
      stripeUrl: "",
      deliveries: [],
      revisionCount: 0
    };
    const next = mutator({ ...current });
    next.updatedAt = new Date().toISOString();
    workflows[request.requestId] = next;
    saveWorkflows(workflows);
    if (isSupabaseEnabled()) {
      await upsertRemote(TABLES.requestWorkflows, mapWorkflowToRemote(next), "requestid");
    }
    renderWorkDetails(request);
    renderWorkNotifications(request.requestId);
    return request;
  }

  requestSelect.addEventListener("change", () => {
    const request = findCurrentRequest();
    if (!request) return;
    renderWorkDetails(request);
    renderWorkNotifications(request.requestId);
  });

  saveStatusBtn.addEventListener("click", async () => {
    const status = statusSelect.value;
    const req = await updateWorkflow((wf) => {
      wf.status = status;
      return wf;
    });
    if (!req) return;
    pushNotification(`案件ステータスが「${status}」に更新されました`, req.requestId);
    setMessage("workMessage", "ステータスを更新しました。", "ok");
  });

  sendChatBtn.addEventListener("click", async () => {
    const input = document.getElementById("workChatInput");
    const text = input ? input.value.trim() : "";
    if (!text) {
      setMessage("workMessage", "メッセージを入力してください。", "err");
      return;
    }
    const session = getCurrentSession();
    const req = await updateWorkflow((wf) => {
      const sender = session ? session.displayName || session.roleLabel || "ユーザー" : "ユーザー";
      wf.messages = [...(wf.messages || []), { sender, text, createdAt: new Date().toISOString() }];
      return wf;
    });
    if (!req) return;
    if (input) input.value = "";
    pushNotification("新しいメッセージが届きました", req.requestId);
    setMessage("workMessage", "メッセージを送信しました。", "ok");
  });

  saveQuoteBtn.addEventListener("click", async () => {
    const quoteAmount = document.getElementById("workQuoteAmount")?.value || "";
    const paymentStatus = document.getElementById("workPaymentStatus")?.value || "unpaid";
    const stripeUrl = document.getElementById("workStripeUrl")?.value || "";
    const req = await updateWorkflow((wf) => {
      wf.quoteAmount = quoteAmount;
      wf.paymentStatus = paymentStatus;
      wf.stripeUrl = stripeUrl;
      return wf;
    });
    if (!req) return;
    pushNotification("見積/支払い情報が更新されました", req.requestId);
    setMessage("workMessage", "見積・支払い情報を保存しました。", "ok");
  });

  addDeliveryBtn.addEventListener("click", async () => {
    const url = document.getElementById("workDeliveryUrl")?.value || "";
    const note = document.getElementById("workDeliveryNote")?.value || "";
    if (!url.startsWith("http")) {
      setMessage("workMessage", "納品URLは http(s) で入力してください。", "err");
      return;
    }
    const req = await updateWorkflow((wf) => {
      wf.deliveries = [...(wf.deliveries || []), { url, note, createdAt: new Date().toISOString() }];
      return wf;
    });
    if (!req) return;
    document.getElementById("workDeliveryUrl").value = "";
    document.getElementById("workDeliveryNote").value = "";
    pushNotification("納品物が追加されました", req.requestId);
    setMessage("workMessage", "納品物を追加しました。", "ok");
  });

  addRevisionBtn.addEventListener("click", async () => {
    const req = await updateWorkflow((wf) => {
      wf.revisionCount = Number(wf.revisionCount || 0) + 1;
      return wf;
    });
    if (!req) return;
    pushNotification("修正依頼が追加されました", req.requestId);
    setMessage("workMessage", "修正依頼を追加しました。", "ok");
  });

  markReadBtn.addEventListener("click", async () => {
    const req = findCurrentRequest();
    const requestId = req ? req.requestId : "";
    const rows = getNotifications().map((n) => (requestId && n.requestId !== requestId ? n : { ...n, read: true }));
    saveNotifications(rows);
    if (isSupabaseEnabled()) {
      for (const n of rows) {
        if (requestId && n.requestId !== requestId) continue;
        await upsertRemote(TABLES.notifications, mapNotificationToRemote(n), "id");
      }
    }
    renderWorkNotifications(requestId);
    setMessage("workMessage", "通知を既読にしました。", "ok");
  });

  window.addEventListener("wavrick-workdata-updated", () => {
    refreshRequestOptions();
  });

  refreshRequestOptions();
}

function bindSupabaseConfig() {
  const urlInput = document.getElementById("sbUrl");
  const keyInput = document.getElementById("sbAnonKey");
  const saveBtn = document.getElementById("saveSbConfigBtn");
  const clearBtn = document.getElementById("clearSbConfigBtn");
  if (!urlInput || !keyInput || !saveBtn || !clearBtn) return;

  const config = getStoredSupabaseConfig();
  if (config) {
    urlInput.value = config.supabaseUrl || "";
    keyInput.value = config.supabaseAnonKey || "";
  }

  saveBtn.addEventListener("click", async () => {
    const supabaseUrl = urlInput.value.trim();
    const supabaseAnonKey = keyInput.value.trim();
    if (!supabaseUrl || !supabaseAnonKey) {
      setMessage("sbConfigMessage", "URLとanon keyを入力してください。", "err");
      return;
    }
    localStorage.setItem(
      SUPABASE_CONFIG_KEY,
      JSON.stringify({ supabaseUrl, supabaseAnonKey, updatedAt: new Date().toISOString() })
    );
    const ready = initSupabaseClient();
    if (!ready) {
      setMessage("sbConfigMessage", "設定を保存しましたが、Supabase初期化に失敗しました。", "err");
      return;
    }
    await refreshRemoteVoiceProfiles();
    await hydrateRemoteWorkData();
    await loadAdminData();
    setMessage("sbConfigMessage", "接続設定を保存しました。以後はSupabaseにも保存します。", "ok");
  });

  clearBtn.addEventListener("click", () => {
    localStorage.removeItem(SUPABASE_CONFIG_KEY);
    supabaseClient = null;
    remoteVoiceProfiles = [];
    renderTalents();
    loadAdminData();
    setMessage("sbConfigMessage", "Supabase設定を削除しました。ローカル保存のみで動作します。", "ok");
  });
}

function bindLogin() {
  const form = document.getElementById("loginForm");
  const message = document.getElementById("loginMessage");
  const sessionCard = document.getElementById("loginSessionCard");
  const sessionText = document.getElementById("loginSessionText");
  const jumpButton = document.getElementById("loginJumpButton");
  const logoutButton = document.getElementById("logoutButton");
  const roleSelect = document.getElementById("loginRole");
  const loginPasswordField = document.getElementById("loginPasswordField");
  const adminPassField = document.getElementById("adminPasscodeField");
  const adminNavLink = document.getElementById("adminNavLink");
  if (!form || !message || !sessionCard || !sessionText || !jumpButton || !logoutButton || !roleSelect || !loginPasswordField || !adminPassField || !adminNavLink) return;

  function setLoginMessage(text, status) {
    message.textContent = text;
    message.classList.remove("ok", "err");
    if (status) message.classList.add(status);
  }

  function renderSession() {
    const session = JSON.parse(localStorage.getItem("wavrick_session") || "null");
    if (!session) {
      sessionCard.classList.add("hidden");
      adminNavLink.classList.add("hidden");
      return;
    }
    sessionCard.classList.remove("hidden");
    sessionText.textContent = `${session.roleLabel}: ${session.displayName} でログイン中`;
    adminNavLink.classList.toggle("hidden", session.role !== "admin");
    if (session.role === "voice") jumpButton.textContent = "声優登録ページへ";
    else if (session.role === "admin") jumpButton.textContent = "運営ダッシュボードへ";
    else jumpButton.textContent = "依頼ページへ";
  }

  function updateRoleUi() {
    const isAdmin = roleSelect.value === "admin";
    loginPasswordField.classList.toggle("hidden", isAdmin);
    adminPassField.classList.toggle("hidden", !isAdmin);
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    const email = (data.email || "").toLowerCase().trim();
    const role = data.role;
    if (!email.includes("@")) {
      setLoginMessage("メールアドレスの形式を確認してください。", "err");
      return;
    }

    let roleLabel = "顧客";
    let account = null;
    if (role === "admin") {
      roleLabel = "運営";
      const password = (data.adminPasscode || "").trim();
      if (!password) {
        setLoginMessage("運営パスワードを入力してください。", "err");
        return;
      }

      const supabaseAdminResult = await signInAdminWithSupabase(email, password);
      if (supabaseAdminResult.ok) {
        account = supabaseAdminResult.account;
      } else {
        const adminConfig = getAdminCredentialConfig();
        if (email !== adminConfig.email.toLowerCase() || password !== adminConfig.passcode) {
          setLoginMessage("運営メールまたはパスワードが違います。", "err");
          return;
        }
        account = { email, displayName: "WAVRICK運営" };
      }
    } else {
      const password = (data.password || "").trim();
      if (isSupabaseEnabled()) {
        if (!password) {
          setLoginMessage("Supabase接続中はパスワード入力が必要です。", "err");
          return;
        }
        const userSignIn = await signInUserWithSupabase(email, password);
        if (!userSignIn.ok) {
          setLoginMessage("ログインに失敗しました。メールまたはパスワードを確認してください。", "err");
          return;
        }
      }

      const key = role === "voice" ? "wavrick_voice_accounts" : "wavrick_customer_accounts";
      roleLabel = role === "voice" ? "声優" : "顧客";
      const accounts = JSON.parse(localStorage.getItem(key) || "[]");
      const localAccount = accounts.find((row) => (row.email || "").toLowerCase().trim() === email);
      const remoteAccount = await findRemoteAccount(role, email);
      account = remoteAccount || localAccount;
      if (!account) {
        setLoginMessage(`${roleLabel}として未登録のメールです。先に登録してください。`, "err");
        return;
      }
    }

    const displayName = account.displayName || account.displayname || account.name || account.email;
    localStorage.setItem(
      "wavrick_session",
      JSON.stringify({
        role,
        roleLabel,
        email,
        displayName,
        createdAt: new Date().toISOString()
      })
    );
    setLoginMessage("ログインしました。", "ok");
    renderSession();
  });

  jumpButton.addEventListener("click", () => {
    const session = JSON.parse(localStorage.getItem("wavrick_session") || "null");
    if (!session) return;
    if (session.role === "voice") showPage("voice");
    else if (session.role === "admin") showPage("admin");
    else showPage("yt");
  });

  logoutButton.addEventListener("click", () => {
    localStorage.removeItem("wavrick_session");
    if (isSupabaseEnabled()) {
      supabaseClient.auth.signOut();
    }
    setLoginMessage("ログアウトしました。", "ok");
    renderSession();
  });

  renderSession();
  updateRoleUi();
  roleSelect.addEventListener("change", updateRoleUi);
}

async function init() {
  initSupabaseClient();
  bindNavigation();
  bindVoiceForm();
  bindMediaPipelineUi();
  bindYtForm();
  bindSupabaseAuthForYtEmail();
  if (new URLSearchParams(window.location.search).get("auth") === "yt_email") {
    showPage("yt");
  }
  await syncYtEmailVerificationFromSupabaseSession();
  bindWorkPage();
  bindAdminDashboard();
  bindSupabaseConfig();
  bindLogin();
  bindTalentPageInteractions();
  bindTalentProfileModal();
  bindTalentSliderClicks();
  renderTalents();
  if (isSupabaseEnabled()) {
    await refreshRemoteVoiceProfiles();
    await hydrateRemoteWorkData();
  }
}

init();
