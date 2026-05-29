const pageMap = {
  home: "page-home",
  voice: "page-voice",
  yt: "page-yt",
  account: "page-account",
  talents: "page-talents",
  login: "page-login",
  "customer-signup": "page-customer-signup",
  work: "page-work",
  admin: "page-admin"
};

const CUSTOMER_CHANNELS_KEY = "wavrick_customer_youtube_channels";
const CUSTOMER_UPLOAD_BUCKET = "customer-uploads";
/** テスト用: 顧客の YouTube チャンネル一致チェックをスキップ */
const YT_CHANNEL_CHECK_BYPASS_KEY = "wavrick_test_skip_yt_channel_check";

let wavrickYoutubeOAuthPending = null;
const wavrickYoutubeOAuthHandlers = [];

const SUPABASE_CONFIG_KEY = "wavrick_supabase_config";
const ADMIN_CREDENTIAL_KEY = "wavrick_admin_credentials"; // kept for migration cleanup only
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
const WORK_SELECTED_REQUEST_KEY = "wavrick_work_selected_request_id";
const DELIVERY_STORAGE_BUCKET = "record-workspace";

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

function isCustomerLoggedIn() {
  const session = getCurrentSession();
  return Boolean(session && (session.role === "customer" || session.role === "admin"));
}

function findCustomerAccountByEmail(email) {
  const normalized = (email || "").toLowerCase().trim();
  if (!normalized) return null;
  const rows = JSON.parse(localStorage.getItem("wavrick_customer_accounts") || "[]");
  return (
    rows.find((row) => (row.email || "").toLowerCase().trim() === normalized) || null
  );
}

function persistCustomerSession(account, email) {
  const normalized = (email || account?.email || "").toLowerCase().trim();
  const displayName =
    account?.name || account?.displayName || account?.displayname || normalized;
  const sessionPayload = {
    role: "customer",
    roleLabel: "顧客",
    email: normalized,
    displayName,
    createdAt: new Date().toISOString()
  };
  localStorage.setItem("wavrick_session", JSON.stringify(sessionPayload));
  syncMainNav();
  return sessionPayload;
}

function persistVoiceSession(account, email) {
  const normalized = (email || account?.email || "").toLowerCase().trim();
  const displayName =
    account?.displayName ||
    account?.displayname ||
    `${account?.lastName || ""} ${account?.firstName || ""}`.trim() ||
    normalized;
  const sessionPayload = {
    role: "voice",
    roleLabel: "声優",
    email: normalized,
    displayName,
    talentId: resolveVoiceTalentIdForSession({ role: "voice", email: normalized }),
    createdAt: new Date().toISOString()
  };
  localStorage.setItem("wavrick_session", JSON.stringify(sessionPayload));
  syncMainNav();
  return sessionPayload;
}

/** 上部ナビ: 未ログイン＝声優登録・ログイン・依頼する / ログイン後はロール別 */
function syncMainNav() {
  const session = getCurrentSession();
  const role = session?.role || "";
  const loggedIn = Boolean(session);

  const navVoice = document.getElementById("navVoiceItem");
  const navLogin = document.getElementById("navLoginItem");
  const navWork = document.getElementById("navWorkItem");
  const navAccount = document.getElementById("navAccountItem");
  const navRecord = document.getElementById("navRecordItem");
  const navAdmin = document.getElementById("navAdminItem");
  const navYt = document.getElementById("navYtItem");
  const navVoiceStatus = document.getElementById("navVoiceStatus");
  const navVoiceStatusLabel = document.getElementById("navVoiceStatusLabel");
  const workNavLink = document.getElementById("workNavLink");
  const accountNavLink = document.getElementById("accountNavLink");

  const showGuest = !loggedIn;
  navVoice?.classList.toggle("hidden", !showGuest);
  navLogin?.classList.toggle("hidden", loggedIn);
  navYt?.classList.toggle("hidden", !showGuest);

  navWork?.classList.toggle("hidden", true);
  navAccount?.classList.toggle("hidden", true);
  navRecord?.classList.toggle("hidden", true);
  navAdmin?.classList.toggle("hidden", true);
  navVoiceStatus?.classList.add("hidden");

  workNavLink?.classList.remove("nav-link-emphasis");
  accountNavLink?.classList.remove("nav-link-emphasis");

  if (role === "voice") {
    navWork?.classList.remove("hidden");
    navAccount?.classList.remove("hidden");
    navRecord?.classList.remove("hidden");
    workNavLink?.classList.add("nav-link-emphasis");

    if (navVoiceStatus && navVoiceStatusLabel) {
      navVoiceStatus.classList.remove("hidden");
      const active = getVoiceIsActive(session);
      navVoiceStatusLabel.className = active
        ? "nav-voice-status nav-voice-status--active"
        : "nav-voice-status nav-voice-status--offline";
      navVoiceStatusLabel.innerHTML = active
        ? `<span class="nav-voice-status-dot"></span>募集中`
        : `<span class="nav-voice-status-dot"></span>オフライン`;
    }

    reorderMainNavItems(["voiceStatus", "work", "account", "record"]);
  } else if (role === "customer") {
    navWork?.classList.remove("hidden");
    navAccount?.classList.remove("hidden");
    navYt?.classList.remove("hidden");
    accountNavLink?.classList.add("nav-link-emphasis");
    reorderMainNavItems(["account", "work", "yt"]);
  } else if (role === "admin") {
    navAdmin?.classList.remove("hidden");
    navWork?.classList.remove("hidden");
    navAccount?.classList.remove("hidden");
    navYt?.classList.remove("hidden");
    navVoice?.classList.remove("hidden");
    navRecord?.classList.remove("hidden");
    accountNavLink?.classList.add("nav-link-emphasis");
    reorderMainNavItems(["admin", "yt", "voice", "work", "account", "record"]);
  } else {
    reorderMainNavItems(["voice", "login", "yt"]);
  }
}

function reorderMainNavItems(visibleOrder) {
  const navUl = document.querySelector("#mainNav ul");
  if (!navUl) return;
  const keys = ["voiceStatus", "voice", "login", "work", "account", "record", "admin", "yt"];
  const map = {
    voiceStatus: document.getElementById("navVoiceStatus"),
    voice: document.getElementById("navVoiceItem"),
    login: document.getElementById("navLoginItem"),
    work: document.getElementById("navWorkItem"),
    account: document.getElementById("navAccountItem"),
    record: document.getElementById("navRecordItem"),
    admin: document.getElementById("navAdminItem"),
    yt: document.getElementById("navYtItem")
  };
  for (const key of visibleOrder) {
    const el = map[key];
    if (el) navUl.appendChild(el);
  }
  for (const key of keys) {
    if (!visibleOrder.includes(key)) {
      const el = map[key];
      if (el) navUl.appendChild(el);
    }
  }
}

function collectYtRequestDataFromForm(form) {
  const session = getCurrentSession();
  if (!session || session.role !== "customer") {
    return { ok: false, message: "依頼するには顧客としてログインしてください。" };
  }
  const data = Object.fromEntries(new FormData(form).entries());
  const profile = findCustomerAccountByEmail(session.email);
  data.name = profile?.name || session.displayName || "顧客";
  data.email = session.email;
  data.channelUrl = profile?.channelUrl || "";
  data.videoChannelUrl = data.channelUrl || data.videoUrl || "";
  return { ok: true, data, session };
}

function syncYtPageAuthUi() {
  const gate = document.getElementById("ytCustomerGate");
  const app = document.getElementById("ytCustomerApp");
  const loggedInAs = document.getElementById("ytLoggedInAs");
  const subtitle = document.querySelector("#page-yt .form-subtitle");
  const loggedIn = isCustomerLoggedIn();
  const session = getCurrentSession();

  if (gate) gate.classList.toggle("hidden", loggedIn);
  if (app) app.classList.toggle("hidden", !loggedIn);
  if (subtitle) {
    subtitle.textContent = loggedIn
      ? "動画URLを入れて、台本作成から依頼まで進められます。"
      : "依頼を始めるには、ログインまたは無料アカウント登録が必要です。";
  }
  if (loggedInAs && session) {
    loggedInAs.textContent = `${session.displayName || session.email} としてログイン中`;
  }
  refreshYtProvisionalPayButton();
  refreshYtChannelUi();
  syncYtChannelTestBypassUi();
}

function getCustomerAccountApi() {
  return typeof window !== "undefined" && window.WavrickCustomerAccount
    ? window.WavrickCustomerAccount
    : null;
}

function getCustomerChannels() {
  const session = getCurrentSession();
  const CA = getCustomerAccountApi();
  if (!session || session.role !== "customer" || !CA) return [];
  return CA.getChannelsForEmail(session.email);
}

function isYtChannelCheckBypassed() {
  if (!isCustomerLoggedIn()) return false;
  try {
    return localStorage.getItem(YT_CHANNEL_CHECK_BYPASS_KEY) === "1";
  } catch {
    return false;
  }
}

function setYtChannelCheckBypassed(enabled) {
  try {
    if (enabled) localStorage.setItem(YT_CHANNEL_CHECK_BYPASS_KEY, "1");
    else localStorage.removeItem(YT_CHANNEL_CHECK_BYPASS_KEY);
  } catch {
    /* ignore */
  }
  syncYtChannelTestBypassUi();
  refreshYtChannelUi();
}

function syncYtChannelTestBypassUi() {
  const box = document.getElementById("ytChannelTestBypass");
  const checkbox = document.getElementById("ytChannelBypassCheck");
  if (!box) return;
  const show = isCustomerLoggedIn() && getYtSourceMode() === "youtube";
  box.classList.toggle("hidden", !show);
  if (checkbox) checkbox.checked = isYtChannelCheckBypassed();
}

function registerYoutubeOAuthHandler(handler) {
  if (typeof handler === "function") wavrickYoutubeOAuthHandlers.push(handler);
}

function clearYoutubeOAuthPending() {
  const p = wavrickYoutubeOAuthPending;
  if (!p) return;
  if (p.timer) window.clearInterval(p.timer);
  if (p.storagePoll) window.clearInterval(p.storagePoll);
  wavrickYoutubeOAuthPending = null;
}

function deliverYoutubeOAuthResult(d) {
  if (!d || d.type !== "WAVRICK_YT_OAUTH") return false;
  for (const handler of wavrickYoutubeOAuthHandlers) {
    try {
      if (handler(d)) return true;
    } catch (_) {
      /* continue */
    }
  }
  const pending = wavrickYoutubeOAuthPending;
  if (!pending?.onResult) return false;
  const msgKey = channelKeyFromOAuthMessage(d);
  if (
    pending.channelKey &&
    d.ok &&
    d.channelId &&
    msgKey &&
    !channelKeysMatch(msgKey, pending.channelKey)
  ) {
    return false;
  }
  try {
    sessionStorage.removeItem(WAVRICK_YT_OAUTH_STORAGE_KEY);
  } catch (_) {
    /* ignore */
  }
  const onResult = pending.onResult;
  const btn = pending.btn;
  const idleLabel = pending.idleLabel;
  clearYoutubeOAuthPending();
  onResult(d, { btn, idleLabel });
  return true;
}

function tryConsumeYoutubeOAuthFromStorageGlobal() {
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
  return deliverYoutubeOAuthResult(d);
}

function initYoutubeOAuthBridge() {
  if (window.__wavrickYtOAuthMessageBound) return;
  window.__wavrickYtOAuthMessageBound = true;
  window.addEventListener("message", (event) => {
    const localOrigin = window.location.origin;
    const supabaseOrigin = getSupabaseOriginForPostMessage();
    if (event.origin !== localOrigin && (!supabaseOrigin || event.origin !== supabaseOrigin)) return;
    deliverYoutubeOAuthResult(event.data);
  });
  window.addEventListener("focus", () => tryConsumeYoutubeOAuthFromStorageGlobal());
}

function startYoutubeOAuthPopup({ channelKey, linkAll, btn, idleLabel, onResult }) {
  if (!isSupabaseEnabled() && !initSupabaseClient()) {
    return { ok: false, message: "Google 認証には Supabase 接続と Edge Function（youtube-oauth-*）が必要です。" };
  }
  const parentBase = getWavrickAppBase();
  if (!parentBase || parentBase === "null") {
    return { ok: false, message: "http(s) の URL で開いてください（file:// では利用できません）。" };
  }
  if (window.location.protocol === "file:") {
    return {
      ok: false,
      message: "file:// では OAuth できません。./scripts/start-dev-server.sh で起動してください。"
    };
  }
  const startUrl = buildYoutubeOAuthStartUrl(channelKey || "", parentBase, { linkAll });
  if (!startUrl) {
    return { ok: false, message: "OAuth URL を組み立てられませんでした。" };
  }
  if (btn) {
    btn.disabled = true;
    btn.textContent = linkAll ? "Google を開いています…" : wavrickI18n("yt_channel_opening");
  }
  const popup = window.open(startUrl, "wavrick_yt_oauth", "width=560,height=720");
  if (!popup) {
    if (btn) {
      btn.disabled = false;
      btn.textContent = idleLabel || wavrickI18n("yt_channel_btn");
    }
    return { ok: false, message: "ポップアップがブロックされました。許可してから再度お試しください。" };
  }
  if (btn) btn.textContent = wavrickI18n("yt_channel_wait");
  clearYoutubeOAuthPending();
  wavrickYoutubeOAuthPending = {
    channelKey: channelKey || "",
    linkAll: Boolean(linkAll),
    btn,
    idleLabel: idleLabel || "",
    onResult,
    storagePoll: window.setInterval(() => tryConsumeYoutubeOAuthFromStorageGlobal(), 350),
    timer: window.setInterval(() => {
      if (!popup.closed) {
        tryConsumeYoutubeOAuthFromStorageGlobal();
        return;
      }
      tryConsumeYoutubeOAuthFromStorageGlobal();
      const p = wavrickYoutubeOAuthPending;
      if (p?.btn === btn && btn) {
        btn.disabled = false;
        btn.textContent = p.idleLabel || wavrickI18n("yt_channel_btn");
      }
      clearYoutubeOAuthPending();
    }, 600)
  };
  return { ok: true };
}

function getYtSourceMode() {
  const checked = document.querySelector('input[name="ytSourceMode"]:checked');
  return checked?.value === "audio" ? "audio" : "youtube";
}

function ytFormNeedsValidVideoUrl() {
  return getYtSourceMode() !== "audio";
}

function syncYtSourceModeUi() {
  const mode = getYtSourceMode();
  const ytBlock = document.getElementById("ytYoutubeBlock");
  const audioBlock = document.getElementById("ytAudioBlock");
  const videoField = document.getElementById("ytVideoUrl");
  if (ytBlock) ytBlock.classList.toggle("hidden", mode === "audio");
  if (audioBlock) audioBlock.classList.toggle("hidden", mode !== "audio");
  if (videoField) videoField.required = mode === "youtube";
  const mismatch = document.getElementById("ytChannelMismatch");
  if (mismatch && mode === "audio") mismatch.classList.add("hidden");
  if (mode === "youtube") refreshYtChannelUi();
  syncYtChannelTestBypassUi();
}

function refreshYtChannelUi() {
  const banner = document.getElementById("ytChannelBanner");
  const mismatch = document.getElementById("ytChannelMismatch");
  if (!banner) return;
  if (!isCustomerLoggedIn() || getYtSourceMode() !== "youtube") {
    banner.classList.add("hidden");
    if (mismatch) mismatch.classList.add("hidden");
    return;
  }
  const channels = getCustomerChannels();
  const CA = getCustomerAccountApi();
  if (!channels.length && !isYtChannelCheckBypassed()) {
    banner.classList.remove("hidden");
    banner.innerHTML =
      'YouTube 利用にはチャンネル登録が必要です。<button type="button" class="link-btn" data-go="account">マイページでチャンネルを追加</button>';
    banner.querySelector("[data-go]")?.addEventListener("click", (e) => {
      e.preventDefault();
      showPage("account");
    });
    return;
  }
  banner.classList.remove("hidden");
  if (isYtChannelCheckBypassed()) {
    banner.textContent =
      "テストモード: チャンネル不一致ロックは無効です（登録チャンネルと動画が違っても進められます）。";
  } else {
    const labels = channels.map((c) => (CA ? CA.channelEntryLabel(c) : c.channelId)).join("、");
    banner.textContent = `登録チャンネル（${channels.length}件）: ${labels}`;
  }
  if (mismatch) mismatch.classList.add("hidden");
}

function performWavrickLogout(options = {}) {
  localStorage.removeItem("wavrick_session");
  if (isSupabaseEnabled() && supabaseClient) {
    supabaseClient.auth.signOut();
  }
  syncMainNav();
  syncYtPageAuthUi();
  syncAccountPageUi();
  window.dispatchEvent(new Event("wavrick-logout"));
  if (options.loginMessage) {
    setMessage("loginMessage", options.loginMessage, "ok");
  }
  const redirect = options.redirectTo;
  if (redirect && pageMap[redirect]) showPage(redirect);
}

function syncAccountPageUi() {
  const gate = document.getElementById("accountCustomerGate");
  const app = document.getElementById("accountCustomerApp");
  const voiceApp = document.getElementById("accountVoiceApp");
  const adminApp = document.getElementById("accountAdminApp");
  const logoutCard = document.getElementById("accountLogoutCard");
  const loggedInAs = document.getElementById("accountLoggedInAs");
  const loggedInAsVoice = document.getElementById("accountLoggedInAsVoice");
  const loggedInAsAdmin = document.getElementById("accountLoggedInAsAdmin");
  const session = getCurrentSession();
  const isCustomer = isCustomerLoggedIn();
  const isVoice = session?.role === "voice";
  const isAdmin = session?.role === "admin";
  const loggedIn = isCustomer || isVoice || isAdmin;

  if (logoutCard) logoutCard.classList.toggle("hidden", !loggedIn);
  if (gate) gate.classList.toggle("hidden", isCustomer || isVoice || isAdmin);
  if (app) app.classList.toggle("hidden", !isCustomer);
  if (voiceApp) voiceApp.classList.toggle("hidden", !isVoice);
  if (adminApp) adminApp.classList.toggle("hidden", !isAdmin);
  if (loggedInAs && session && isCustomer) {
    loggedInAs.textContent = `${session.displayName || session.email} としてログイン中`;
  }
  if (loggedInAsVoice && session && isVoice) {
    loggedInAsVoice.textContent = `${session.displayName || session.email}（声優）としてログイン中`;

    const toggle = document.getElementById("voiceActiveToggle");
    const statusText = document.getElementById("voiceActiveStatusText");
    const active = getVoiceIsActive(session);
    if (toggle) {
      toggle.checked = active;
      if (toggle.dataset.bound !== "1") {
        toggle.dataset.bound = "1";
        toggle.addEventListener("change", () => {
          setVoiceIsActive(toggle.checked);
          syncAccountPageUi();
        });
      }
    }
    if (statusText) {
      statusText.textContent = active ? "現在: 募集中" : "現在: オフライン";
      statusText.className = active
        ? "voice-active-status-text voice-active-status-text--on"
        : "voice-active-status-text voice-active-status-text--off";
    }

    const mypageStats = document.getElementById("voiceMypageStats");
    if (mypageStats) {
      const TS = globalThis.WavrickTalentStats;
      const talentId = resolveVoiceTalentIdForSession(session);
      mypageStats.innerHTML = TS ? TS.renderDetailedStatsHtml(TS.getTalentStats(talentId)) : "";
    }
  }
  if (loggedInAsAdmin && session && isAdmin) {
    loggedInAsAdmin.textContent = `${session.displayName || session.email}（運営）としてログイン中`;
  }
  if (isCustomer) renderAccountChannelList();
}

function renderAccountChannelList() {
  const list = document.getElementById("accountChannelList");
  const empty = document.getElementById("accountChannelEmpty");
  const session = getCurrentSession();
  const CA = getCustomerAccountApi();
  if (!list || !session || !CA) return;
  const channels = getCustomerChannels();
  list.innerHTML = "";
  if (empty) empty.classList.toggle("hidden", channels.length > 0);
  for (const ch of channels) {
    const li = document.createElement("li");
    const left = document.createElement("div");
    const label = document.createElement("div");
    label.className = "channel-label";
    label.textContent = CA.channelEntryLabel(ch);
    const meta = document.createElement("div");
    meta.className = "channel-meta";
    meta.textContent = ch.channelId || ch.channelKey || "";
    left.append(label, meta);
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "btn-ghost";
    removeBtn.textContent = "削除";
    removeBtn.addEventListener("click", () => {
      CA.removeChannelForEmail(session.email, ch.channelId);
      renderAccountChannelList();
      refreshYtChannelUi();
      setMessage("accountMessage", "チャンネルを削除しました。", "ok");
    });
    li.append(left, removeBtn);
    list.appendChild(li);
  }
}

async function uploadCustomerAudioWithFallback(file) {
  const CA = getCustomerAccountApi();
  if (!CA) throw new Error("顧客アカウントモジュールを読み込めません。");
  const session = getCurrentSession();
  if (isSupabaseEnabled() && supabaseClient && session?.email) {
    const safeName = (file.name || "upload").replace(/[^\w.-]+/g, "_").slice(0, 80) || "upload.bin";
    const path = `${encodeURIComponent(session.email)}/${Date.now()}_${safeName}`;
    const { error } = await supabaseClient.storage
      .from(CUSTOMER_UPLOAD_BUCKET)
      .upload(path, file, { upsert: false, contentType: file.type || undefined });
    if (!error) {
      const { data: pub } = supabaseClient.storage.from(CUSTOMER_UPLOAD_BUCKET).getPublicUrl(path);
      return {
        ok: true,
        url: pub?.publicUrl || "",
        storagePath: path,
        fileName: file.name,
        byteLength: file.size
      };
    }
  }
  return CA.uploadCustomerAudio(file);
}

function bindAccountPage() {
  const logoutBtn = document.getElementById("accountLogoutButton");
  if (logoutBtn && logoutBtn.dataset.bound !== "1") {
    logoutBtn.dataset.bound = "1";
    logoutBtn.addEventListener("click", () => {
      performWavrickLogout({
        redirectTo: "login",
        loginMessage: "ログアウトしました。"
      });
    });
  }

  const oauthBtn = document.getElementById("accountChannelOAuthBtn");
  const linkAllBtn = document.getElementById("accountLinkAllOAuthBtn");
  if (!oauthBtn && !linkAllBtn) return;

  if (oauthBtn) {
    oauthBtn.addEventListener("click", () => {
      setMessage("accountMessage", "");
      if (!isCustomerLoggedIn()) {
        setMessage("accountMessage", "先にログインしてください。", "err");
        return;
      }
      const field = document.getElementById("accountChannelUrl");
      const key = normalizeYoutubeChannelKey(field ? field.value : "");
      if (!key) {
        setMessage("accountMessage", "チャンネル URL または @ハンドルを入力してください。", "err");
        return;
      }
      const session = getCurrentSession();
      const CA = getCustomerAccountApi();
      const idle = oauthBtn.textContent;
      const started = startYoutubeOAuthPopup({
        channelKey: key,
        linkAll: false,
        btn: oauthBtn,
        idleLabel: idle,
        onResult: (d) => {
          oauthBtn.disabled = false;
          oauthBtn.textContent = idle;
          if (!d.ok) {
            const errText = d.code ? youtubeOAuthMessageFromCode(d.code) : wavrickI18n("yt_oauth_fail");
            setMessage("accountMessage", errText + (d.detail ? ` (${d.detail})` : ""), "err");
            return;
          }
          if (CA && session?.email && d.channelId) {
            const msgKey = channelKeyFromOAuthMessage(d) || key;
            CA.addChannelsForEmail(session.email, [
              { channelId: d.channelId, channelKey: msgKey || `channel:${d.channelId}` }
            ]);
            renderAccountChannelList();
            refreshYtChannelUi();
          }
          setMessage("accountMessage", wavrickI18n("yt_oauth_success"), "ok");
        }
      });
      if (!started.ok) setMessage("accountMessage", started.message, "err");
    });
  }

  if (linkAllBtn) {
    linkAllBtn.addEventListener("click", () => {
      setMessage("accountMessage", "");
      if (!isCustomerLoggedIn()) {
        setMessage("accountMessage", "先にログインしてください。", "err");
        return;
      }
      const session = getCurrentSession();
      const CA = getCustomerAccountApi();
      const idle = linkAllBtn.textContent;
      const started = startYoutubeOAuthPopup({
        channelKey: "",
        linkAll: true,
        btn: linkAllBtn,
        idleLabel: idle,
        onResult: (d) => {
          linkAllBtn.disabled = false;
          linkAllBtn.textContent = idle;
          if (!d.ok) {
            const errText = d.code ? youtubeOAuthMessageFromCode(d.code) : wavrickI18n("yt_oauth_fail");
            setMessage("accountMessage", errText + (d.detail ? ` (${d.detail})` : ""), "err");
            return;
          }
          const ids = Array.isArray(d.channelIds) ? d.channelIds : d.channelId ? [d.channelId] : [];
          if (CA && session?.email && ids.length) {
            CA.addChannelsForEmail(
              session.email,
              ids.map((id) => ({ channelId: id, channelKey: `channel:${id}` }))
            );
            renderAccountChannelList();
            refreshYtChannelUi();
          }
          setMessage(
            "accountMessage",
            ids.length ? `${ids.length} 件のチャンネルを登録しました。` : wavrickI18n("yt_oauth_success"),
            "ok"
          );
        }
      });
      if (!started.ok) setMessage("accountMessage", started.message, "err");
    });
  }
}

function bindYtSourceMode() {
  document.querySelectorAll('input[name="ytSourceMode"]').forEach((el) => {
    el.addEventListener("change", () => syncYtSourceModeUi());
  });
  const bypassCheck = document.getElementById("ytChannelBypassCheck");
  if (bypassCheck && bypassCheck.dataset.bound !== "1") {
    bypassCheck.dataset.bound = "1";
    bypassCheck.addEventListener("change", () => {
      setYtChannelCheckBypassed(bypassCheck.checked);
      const mismatch = document.getElementById("ytChannelMismatch");
      if (mismatch && bypassCheck.checked) mismatch.classList.add("hidden");
      setMessage(
        "ytMessage",
        bypassCheck.checked
          ? "テストモード: チャンネル不一致ロックを無効にしました。"
          : "チャンネル不一致ロックを有効に戻しました。",
        "ok"
      );
    });
  }
  syncYtSourceModeUi();
}

function getWorkflows() {
  return JSON.parse(localStorage.getItem("wavrick_request_workflows") || "{}");
}

function saveWorkflows(payload) {
  localStorage.setItem("wavrick_request_workflows", JSON.stringify(payload));
  if (globalThis.WavrickTalentStats) globalThis.WavrickTalentStats.invalidateCache();
}

function getNotifications() {
  return JSON.parse(localStorage.getItem("wavrick_notifications") || "[]");
}

function saveNotifications(rows) {
  localStorage.setItem("wavrick_notifications", JSON.stringify(rows));
}

function getRequestDedupeKey(row) {
  return `${(row.email || "").toLowerCase().trim()}|${(row.videoUrl || "").trim()}`;
}

function parseCastMetaFromScript(script) {
  const raw = String(script || "");
  const match = raw.match(/---\s*WAVRICK_CAST\s*---\s*([\s\S]*?)\s*---/i);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1].trim());
    if (parsed && Array.isArray(parsed.castSlots)) return parsed;
  } catch {
    /* ignore */
  }
  return null;
}

function getVoiceProfilesMerged() {
  const localProfiles = JSON.parse(localStorage.getItem("wavrick_voice_profiles") || "[]");
  return [...mockTalents, ...localProfiles, ...remoteVoiceProfiles];
}

function resolveVoiceTalentIdForSession(session) {
  if (!session || session.role !== "voice") return "";
  if (session.talentId) return String(session.talentId);
  const email = (session.email || "").toLowerCase().trim();
  const profiles = getVoiceProfilesMerged();
  const profile = profiles.find((p) => (p.email || "").toLowerCase().trim() === email);
  if (profile) return getTalentId(profile);
  const selected = JSON.parse(localStorage.getItem("wavrick_selected_talent") || "null");
  if (selected?.talentId) return String(selected.talentId);
  return "";
}

function getVoiceIsActive(session) {
  if (!session || session.role !== "voice") return true;
  if (session.isActive === false) return false;
  const talentId = resolveVoiceTalentIdForSession(session);
  if (!talentId) return true;
  const profile = getVoiceProfilesMerged().find((p) => getTalentId(p) === talentId);
  if (profile) return profile.isActive !== false;
  return true;
}

function setVoiceIsActive(active) {
  const session = getCurrentSession();
  if (!session || session.role !== "voice") return;
  const email = (session.email || "").toLowerCase().trim();
  if (!email) return;

  session.isActive = active;
  localStorage.setItem("wavrick_session", JSON.stringify(session));

  const profiles = JSON.parse(localStorage.getItem("wavrick_voice_profiles") || "[]");
  const idx = profiles.findIndex((p) => (p.email || "").toLowerCase().trim() === email);
  if (idx >= 0) {
    profiles[idx].isActive = active;
    localStorage.setItem("wavrick_voice_profiles", JSON.stringify(profiles));
  }

  for (const m of mockTalents) {
    if ((m.email || "").toLowerCase().trim() === email) {
      m.isActive = active;
    }
  }

  if (isSupabaseEnabled() && supabaseClient) {
    supabaseClient
      .from(TABLES.voiceProfiles)
      .update({ is_active: active })
      .ilike("email", email)
      .then(() => {});
  }

  syncMainNav();
  renderTalents();
}

function isProfileActive(profile) {
  return profile.isActive !== false;
}

function parseSelectedTalentIds(value) {
  return String(value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function getTransactionApi() {
  return globalThis.WavrickTransaction || null;
}

function getWorkflowCastSlots(request, wf) {
  if (wf?.castAcceptance?.length) return wf.castAcceptance;
  return getCastSlotsForRequest(request);
}

function requestAssignedToVoice(request, talentId) {
  if (!talentId) return false;
  const wf = getWorkflows()[request.requestId];
  if (wf?.castAcceptance?.length) {
    return wf.castAcceptance.some((s) => String(s.talentId) === talentId);
  }
  const ids = parseSelectedTalentIds(request.selectedTalentId);
  if (ids.includes(talentId)) return true;
  const cast = parseCastMetaFromScript(request.script);
  if (cast?.castSlots?.some((s) => String(s.talentId) === talentId)) return true;
  return false;
}

function getVoiceSpeakerSlotsForRequest(request, talentId) {
  const wf = getWorkflowForRequest(request.requestId, request.status);
  const slots = getWorkflowCastSlots(request, wf);
  if (!slots.length) return [];
  return slots.filter((s) => String(s.talentId) === talentId);
}

async function getMergedYoutubeRequests() {
  const local = JSON.parse(localStorage.getItem("wavrick_youtube_requests") || "[]");
  const map = new Map();
  for (const row of Array.isArray(local) ? local : []) {
    const requestId = row.requestId || generateRequestId();
    map.set(requestId, { ...row, requestId });
  }
  if (!isSupabaseEnabled()) return [...map.values()].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const remote = await fetchRemoteYoutubeRequests();
  for (const row of remote) {
    const mapped = { ...row };
    if (!mapped.requestId) mapped.requestId = `req_${row.id || generateRequestId()}`;
    const workflows = getWorkflows();
    const wfMatch = Object.values(workflows).find(
      (wf) =>
        wf.requestId &&
        (wf.requestId === mapped.requestId ||
          getRequestDedupeKey(mapped) === getRequestDedupeKey({ email: mapped.email, videoUrl: mapped.videoUrl }))
    );
    if (wfMatch?.requestId) mapped.requestId = wfMatch.requestId;
    const key = mapped.requestId || getRequestDedupeKey(mapped);
    if (!map.has(key)) map.set(key, mapped);
  }
  return [...map.values()].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function getWorkSelectedRequestId() {
  return sessionStorage.getItem(WORK_SELECTED_REQUEST_KEY) || localStorage.getItem(WORK_SELECTED_REQUEST_KEY) || "";
}

function setWorkSelectedRequestId(requestId) {
  if (!requestId) return;
  sessionStorage.setItem(WORK_SELECTED_REQUEST_KEY, requestId);
  localStorage.setItem(WORK_SELECTED_REQUEST_KEY, requestId);
}

async function hydrateRemoteWorkData() {
  if (!isSupabaseEnabled()) return;

  const remoteRequests = await fetchRemoteYoutubeRequests();
  if (remoteRequests.length) {
    const local = JSON.parse(localStorage.getItem("wavrick_youtube_requests") || "[]");
    const map = new Map();
    for (const row of local) {
      const requestId = row.requestId || generateRequestId();
      map.set(requestId, { ...row, requestId });
    }
    for (const row of remoteRequests) {
      const mapped = { ...row };
      if (!mapped.requestId) mapped.requestId = `req_${mapped.id || generateRequestId()}`;
      const key = mapped.requestId;
      if (!map.has(key)) map.set(key, mapped);
    }
    localStorage.setItem("wavrick_youtube_requests", JSON.stringify([...map.values()]));
  }

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
    email: "akari.yamamoto@example.com",
    isActive: true,
    bio: "明るく親しみやすい声。旅行・料理Vlogの吹替が得意です。",
    genres: "旅行, 料理, Vlog",
    pricePerMinute: 25,
    minimumOrderPrice: 15,
    additionalRetakePrice: 8,
    jobCount: 42,
    sampleUrl: "https://example.com/akari-sample.mp3",
    avatarUrl: "https://api.dicebear.com/9.x/notionists/svg?seed=Akari&backgroundColor=b6e3f4"
  },
  {
    displayName: "田中 美咲",
    firstName: "美咲",
    lastName: "田中",
    email: "misaki.tanaka@example.com",
    isActive: true,
    bio: "落ち着いたナレーション向き。教育・ドキュメンタリー案件に対応。",
    genres: "教育, ドキュメンタリー",
    pricePerMinute: 32,
    minimumOrderPrice: 20,
    additionalRetakePrice: 10,
    jobCount: 78,
    sampleUrl: "https://example.com/misaki-sample.mp3",
    avatarUrl: "https://api.dicebear.com/9.x/notionists/svg?seed=Misaki&backgroundColor=c0aede"
  },
  {
    displayName: "鈴木 健太",
    firstName: "健太",
    lastName: "鈴木",
    email: "kenta.suzuki@example.com",
    isActive: true,
    bio: "エネルギッシュな声質。ゲーム実況やエンタメ系に相性が良いです。",
    genres: "ゲーム実況, エンタメ",
    pricePerMinute: 22,
    minimumOrderPrice: 10,
    additionalRetakePrice: 5,
    jobCount: 56,
    sampleUrl: "https://example.com/kenta-sample.mp3",
    avatarUrl: "https://api.dicebear.com/9.x/notionists/svg?seed=Kenta&backgroundColor=d1d4f9"
  },
  {
    displayName: "佐藤 りな",
    firstName: "りな",
    lastName: "佐藤",
    email: "rina.sato@example.com",
    isActive: true,
    bio: "かわいめ〜清楚系まで幅広く対応。アニメ調の演技も得意です。",
    genres: "アニメ, 美容, ライフスタイル",
    pricePerMinute: 20,
    minimumOrderPrice: 0,
    additionalRetakePrice: 5,
    jobCount: 18,
    sampleUrl: "https://example.com/rina-sample.mp3",
    avatarUrl: "https://api.dicebear.com/9.x/notionists/svg?seed=Rina&backgroundColor=ffd5dc"
  },
  {
    displayName: "中村 大輝",
    firstName: "大輝",
    lastName: "中村",
    email: "daiki.nakamura@example.com",
    isActive: true,
    bio: "深みのあるバリトンボイス。ビジネス系・技術解説・ナレーションに定評があります。",
    genres: "ビジネス, テック, ナレーション",
    pricePerMinute: 38,
    minimumOrderPrice: 25,
    additionalRetakePrice: 12,
    jobCount: 124,
    sampleUrl: "https://example.com/daiki-sample.mp3",
    avatarUrl: "https://api.dicebear.com/9.x/notionists/svg?seed=Daiki&backgroundColor=b6e3f4"
  },
  {
    displayName: "高橋 さくら",
    firstName: "さくら",
    lastName: "高橋",
    email: "sakura.takahashi@example.com",
    isActive: true,
    bio: "やさしく透明感のある声。子ども向けコンテンツや絵本朗読が得意です。",
    genres: "キッズ, 絵本, 教育",
    pricePerMinute: 18,
    minimumOrderPrice: 10,
    additionalRetakePrice: 5,
    jobCount: 35,
    sampleUrl: "https://example.com/sakura-sample.mp3",
    avatarUrl: "https://api.dicebear.com/9.x/notionists/svg?seed=Sakura&backgroundColor=ffdfbf"
  },
  {
    displayName: "伊藤 龍之介",
    firstName: "龍之介",
    lastName: "伊藤",
    email: "ryunosuke.ito@example.com",
    isActive: true,
    bio: "迫力のあるアクション系ボイスからクールなナレーションまで。ゲームPV・映画予告で活躍中。",
    genres: "ゲーム, 映画, アクション",
    pricePerMinute: 45,
    minimumOrderPrice: 30,
    additionalRetakePrice: 15,
    jobCount: 91,
    sampleUrl: "https://example.com/ryunosuke-sample.mp3",
    avatarUrl: "https://api.dicebear.com/9.x/notionists/svg?seed=Ryunosuke&backgroundColor=c0aede"
  },
  {
    displayName: "渡辺 ゆい",
    firstName: "ゆい",
    lastName: "渡辺",
    email: "yui.watanabe@example.com",
    isActive: false,
    bio: "フレンドリーで聞き取りやすい声。日常系Vlog・商品レビュー系で多数実績あり。",
    genres: "Vlog, レビュー, ライフスタイル",
    pricePerMinute: 20,
    minimumOrderPrice: 0,
    additionalRetakePrice: 5,
    jobCount: 63,
    sampleUrl: "https://example.com/yui-sample.mp3",
    avatarUrl: "https://api.dicebear.com/9.x/notionists/svg?seed=Yui&backgroundColor=ffd5dc"
  }
];

/**
 * テスト用: デモ声優のワークフロー実績データをlocalStorageに注入する。
 * 一度だけ自動実行される。
 */
function seedMockWorkflowStats() {
  const KEY = "wavrick_mock_stats_seeded_v4";
  if (localStorage.getItem(KEY)) return;

  localStorage.removeItem("wavrick_mock_stats_seeded_v2");
  localStorage.removeItem("wavrick_mock_stats_seeded_v3");

  const workflows = JSON.parse(localStorage.getItem("wavrick_request_workflows") || "{}");
  const now = Date.now();
  const h = (hours) => hours * 60 * 60 * 1000;
  const t = (offset) => new Date(now - offset).toISOString();

  function slot(email, name, status, offerH, respondH) {
    return { talentId: `voice:${email}`, displayName: name, status, offerSentAt: t(h(offerH)), respondedAt: t(h(respondH)) };
  }
  function dlv(email, name, delivH) {
    return { submitterEmail: email, submittedBy: name, createdAt: t(h(delivH)), kind: "audio_mix" };
  }
  function msg(sender, kind, hoursAgo) {
    return { sender, text: kind === "revision" ? "修正依頼" : "メッセージ", kind, createdAt: t(h(hoursAgo)) };
  }
  function rating(tid, score) {
    return { talentId: tid, score, reviewerName: "顧客", createdAt: t(h(Math.random() * 500)) };
  }

  const AK = "akari.yamamoto@example.com", AKn = "山本 あかり", AKt = "voice:" + AK;
  const MS = "misaki.tanaka@example.com", MSn = "田中 美咲", MSt = "voice:" + MS;
  const KT = "kenta.suzuki@example.com", KTn = "鈴木 健太", KTt = "voice:" + KT;
  const RN = "rina.sato@example.com", RNn = "佐藤 りな", RNt = "voice:" + RN;
  const DK = "daiki.nakamura@example.com", DKn = "中村 大輝", DKt = "voice:" + DK;
  const SK = "sakura.takahashi@example.com", SKn = "高橋 さくら", SKt = "voice:" + SK;
  const RY = "ryunosuke.ito@example.com", RYn = "伊藤 龍之介", RYt = "voice:" + RY;
  const YU = "yui.watanabe@example.com", YUn = "渡辺 ゆい", YUt = "voice:" + YU;

  const mockData = [
    { id: "mock_req_001", slots: [slot(AK, AKn, "accepted", 500, 499)], deliveries: [dlv(AK, AKn, 480)], phase: "in_production",
      messages: [msg("顧客A", "chat", 495), msg(AKn, "chat", 493), msg("顧客A", "revision", 485), msg(AKn, "chat", 482)],
      ratings: [rating(AKt, 5)] },
    { id: "mock_req_002", slots: [slot(AK, AKn, "accepted", 400, 399)], deliveries: [dlv(AK, AKn, 389)], phase: "in_production",
      messages: [msg("顧客B", "revision", 395), msg(AKn, "chat", 392)],
      ratings: [rating(AKt, 4.5)] },
    { id: "mock_req_003", slots: [slot(AK, AKn, "accepted", 300, 299)], deliveries: [dlv(AK, AKn, 290)], phase: "in_production",
      messages: [msg("顧客C", "chat", 296), msg(AKn, "chat", 294)],
      ratings: [rating(AKt, 5)] },

    { id: "mock_req_004", slots: [slot(MS, MSn, "accepted", 600, 599)], deliveries: [dlv(MS, MSn, 590)], phase: "in_production",
      messages: [msg("顧客D", "revision", 596), msg(MSn, "chat", 594), msg("顧客D", "chat", 593), msg(MSn, "chat", 591)],
      ratings: [rating(MSt, 5)] },
    { id: "mock_req_005", slots: [slot(MS, MSn, "accepted", 500, 499)], deliveries: [dlv(MS, MSn, 488)], phase: "in_production",
      messages: [msg("顧客E", "revision", 495), msg(MSn, "chat", 492)],
      ratings: [rating(MSt, 4.5)] },
    { id: "mock_req_006", slots: [slot(MS, MSn, "accepted", 400, 399)], deliveries: [dlv(MS, MSn, 395)], phase: "in_production",
      messages: [msg("顧客F", "chat", 398), msg(MSn, "chat", 396)],
      ratings: [rating(MSt, 5)] },
    { id: "mock_req_007", slots: [slot(MS, MSn, "accepted", 200, 199)], deliveries: [dlv(MS, MSn, 195)], phase: "in_production",
      messages: [msg("顧客G", "revision", 198), msg(MSn, "chat", 195)],
      ratings: [rating(MSt, 4)] },

    { id: "mock_req_008", slots: [slot(KT, KTn, "accepted", 700, 699)], deliveries: [dlv(KT, KTn, 630)], phase: "in_production",
      messages: [msg("顧客H", "revision", 680), msg(KTn, "chat", 668)],
      ratings: [rating(KTt, 3)] },
    { id: "mock_req_009", slots: [slot(KT, KTn, "declined", 600, 599)], deliveries: [], phase: "cancelled",
      messages: [], ratings: [] },
    { id: "mock_req_010", slots: [slot(KT, KTn, "accepted", 500, 499)], deliveries: [dlv(KT, KTn, 400)], phase: "in_production",
      messages: [msg("顧客I", "chat", 480), msg(KTn, "chat", 470)],
      ratings: [rating(KTt, 3.5)] },

    { id: "mock_req_011", slots: [slot(RN, RNn, "accepted", 300, 299)], deliveries: [dlv(RN, RNn, 295)], phase: "in_production",
      messages: [msg("顧客J", "chat", 298), msg(RNn, "chat", 296), msg("顧客J", "revision", 296), msg(RNn, "chat", 294)],
      ratings: [rating(RNt, 4.5)] },

    { id: "mock_req_012", slots: [slot(DK, DKn, "accepted", 800, 799)], deliveries: [dlv(DK, DKn, 790)], phase: "in_production",
      messages: [msg("顧客K", "revision", 796), msg(DKn, "chat", 795), msg("顧客K", "chat", 794), msg(DKn, "chat", 793)],
      ratings: [rating(DKt, 5)] },
    { id: "mock_req_013", slots: [slot(DK, DKn, "accepted", 700, 699)], deliveries: [dlv(DK, DKn, 693)], phase: "in_production",
      messages: [msg("顧客L", "revision", 697), msg(DKn, "chat", 695)],
      ratings: [rating(DKt, 5)] },
    { id: "mock_req_014", slots: [slot(DK, DKn, "accepted", 600, 599)], deliveries: [dlv(DK, DKn, 585)], phase: "in_production",
      messages: [msg("顧客M", "chat", 597), msg(DKn, "chat", 595), msg("顧客M", "revision", 590), msg(DKn, "chat", 588)],
      ratings: [rating(DKt, 4.5)] },
    { id: "mock_req_015", slots: [slot(DK, DKn, "accepted", 500, 499)], deliveries: [dlv(DK, DKn, 492)], phase: "in_production",
      messages: [msg("顧客N", "revision", 498), msg(DKn, "chat", 496)],
      ratings: [rating(DKt, 5)] },
    { id: "mock_req_016", slots: [slot(DK, DKn, "accepted", 400, 399)], deliveries: [dlv(DK, DKn, 395)], phase: "in_production",
      messages: [msg("顧客O", "chat", 398), msg(DKn, "chat", 396)],
      ratings: [rating(DKt, 4.5)] },

    { id: "mock_req_017", slots: [slot(SK, SKn, "accepted", 500, 499)], deliveries: [dlv(SK, SKn, 489)], phase: "in_production",
      messages: [msg("顧客P", "revision", 496), msg(SKn, "chat", 493), msg("顧客P", "chat", 492), msg(SKn, "chat", 490)],
      ratings: [rating(SKt, 4.5)] },
    { id: "mock_req_018", slots: [slot(SK, SKn, "accepted", 400, 399)], deliveries: [dlv(SK, SKn, 392)], phase: "in_production",
      messages: [msg("顧客Q", "chat", 398), msg(SKn, "chat", 395)],
      ratings: [rating(SKt, 4)] },

    { id: "mock_req_019", slots: [slot(RY, RYn, "accepted", 600, 599)], deliveries: [dlv(RY, RYn, 597)], phase: "in_production",
      messages: [msg("顧客R", "revision", 598.5), msg(RYn, "chat", 597.5), msg("顧客R", "chat", 598), msg(RYn, "chat", 597)],
      ratings: [rating(RYt, 5)] },
    { id: "mock_req_020", slots: [slot(RY, RYn, "accepted", 500, 499)], deliveries: [dlv(RY, RYn, 496)], phase: "in_production",
      messages: [msg("顧客S", "revision", 498), msg(RYn, "chat", 496)],
      ratings: [rating(RYt, 4.5)] },
    { id: "mock_req_021", slots: [slot(RY, RYn, "accepted", 400, 399)], deliveries: [dlv(RY, RYn, 395)], phase: "in_production",
      messages: [msg("顧客T", "chat", 398), msg(RYn, "chat", 396)],
      ratings: [rating(RYt, 5)] },
    { id: "mock_req_022", slots: [slot(RY, RYn, "declined", 300, 299)], deliveries: [], phase: "cancelled",
      messages: [], ratings: [] },

    { id: "mock_req_023", slots: [slot(YU, YUn, "accepted", 500, 499)], deliveries: [dlv(YU, YUn, 490)], phase: "in_production",
      messages: [msg("顧客U", "revision", 496), msg(YUn, "chat", 488)],
      ratings: [rating(YUt, 3.5)] },
    { id: "mock_req_024", slots: [slot(YU, YUn, "accepted", 400, 399)], deliveries: [dlv(YU, YUn, 388)], phase: "in_production",
      messages: [msg("顧客V", "chat", 396), msg(YUn, "chat", 388)],
      ratings: [rating(YUt, 3)] },
    { id: "mock_req_025", slots: [slot(YU, YUn, "accepted", 200, 199)], deliveries: [], phase: "cancelled",
      messages: [], ratings: [] }
  ];

  for (const m of mockData) {
    workflows[m.id] = {
      requestId: m.id, status: "完了", quoteAmount: "", paymentStatus: "paid_provisional",
      stripeUrl: "", revisionCount: 0, omakaseCriteria: {},
      deliveries: m.deliveries,
      messages: m.messages || [],
      ratings: m.ratings || [],
      transactionPhase: m.phase,
      castAcceptance: m.slots,
      updatedAt: new Date().toISOString()
    };
  }

  localStorage.setItem("wavrick_request_workflows", JSON.stringify(workflows));
  localStorage.setItem(KEY, "1");
  if (globalThis.WavrickTalentStats) globalThis.WavrickTalentStats.invalidateCache();
}

function getPricingApi() {
  return globalThis.WavrickPricing || null;
}

function resolveVoiceProfileByTalentId(talentId) {
  if (!talentId) return null;
  return loadVoiceProfiles().find((p) => getTalentId(p) === talentId) || null;
}

function renderTalentPricingHtml(profile) {
  const P = getPricingApi();
  if (!P) return "";
  const lines = P.formatVoicePricingLines(profile);
  return `<div class="talent-pricing">
    <span class="talent-price-tag">${escapeHtml(lines.perMinute)}</span>
    <span class="talent-price-tag">${escapeHtml(lines.minimum)}</span>
    <span class="talent-price-tag">${escapeHtml(lines.retake)}</span>
  </div>`;
}

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

let _suppressHistoryPush = false;

function showPage(name, options) {
  const pushHistory = !(options && options.skipHistory);
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
  window.scrollTo({ top: 0, behavior: "instant" });
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
  if (name === "yt") {
    syncYtPageAuthUi();
    if (isCustomerLoggedIn()) {
      renderYtSpeakerPicker();
      updateYtAssignHint();
      syncYtSourceModeUi();
    }
  }
  if (name === "account") {
    syncAccountPageUi();
    if (!isCustomerLoggedIn()) {
      /* gate only */
    }
  }
  if (name === "customer-signup") {
    const session = getCurrentSession();
    if (session?.role === "customer") {
      showPage("yt");
      return;
    }
  }
  window.scrollTo({ top: 0, behavior: "smooth" });

  if (pushHistory && !_suppressHistoryPush) {
    const newHash = "#" + name;
    if (window.location.hash !== newHash) {
      history.pushState({ wavrickPage: name }, "", newHash);
    }
  }
  sessionStorage.setItem("wavrick_active_page", name);
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

  window.addEventListener("popstate", (e) => {
    _suppressHistoryPush = true;
    const statePage = e.state && e.state.wavrickPage;
    const hashPage = (window.location.hash || "").replace(/^#/, "");
    const target = statePage || (hashPage && pageMap[hashPage] ? hashPage : null);
    if (target && pageMap[target]) {
      showPage(target, { skipHistory: true });
      _wavrickRestoreFormState();
      _wavrickRestorePipelineState();
    } else {
      showPage("home", { skipHistory: true });
    }
    _suppressHistoryPush = false;
  });

  window.addEventListener("pageshow", (e) => {
    if (!e.persisted) return;
    _wavrickRestoreFormState();
    _wavrickRestorePipelineState();
    const lastPage = sessionStorage.getItem("wavrick_active_page");
    if (lastPage && pageMap[lastPage]) {
      _suppressHistoryPush = true;
      showPage(lastPage, { skipHistory: true });
      _suppressHistoryPush = false;
    }
  });
}

// ─── フォームオートセーブ＆復元 ───
const _FORM_AUTOSAVE_KEY = "wavrick_form_autosave";
const _FORM_FIELDS_TO_SAVE = [
  "voiceLastName", "voiceFirstName", "voiceDisplayName", "voiceEmail",
  "voiceBio", "voiceGenres", "voicePricePerMinute", "voiceMinimumOrderPrice",
  "voiceAdditionalRetakePrice", "voiceJobCount", "voiceSampleUrl",
  "customerSignupName", "customerSignupEmail",
  "ytVideoUrl", "ytTone", "ytDeadline", "ytSpeakerCount",
  "ytTranscriptEdit", "ytScript",
  "ytOmakaseGender", "ytOmakaseBudget", "ytOmakaseGenres",
  "accountChannelUrl"
];

function _wavrickSaveFormState() {
  try {
    const data = {};
    for (const id of _FORM_FIELDS_TO_SAVE) {
      const el = document.getElementById(id);
      if (el && el.value) data[id] = el.value;
    }
    const radioYtSource = document.querySelector('input[name="ytSourceMode"]:checked');
    if (radioYtSource) data._ytSourceMode = radioYtSource.value;
    sessionStorage.setItem(_FORM_AUTOSAVE_KEY, JSON.stringify(data));
    _wavrickSavePipelineState();
  } catch (e) { /* quota exceeded — ignore */ }
}

function _wavrickRestoreFormState() {
  try {
    const raw = sessionStorage.getItem(_FORM_AUTOSAVE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    for (const id of _FORM_FIELDS_TO_SAVE) {
      if (data[id] == null) continue;
      const el = document.getElementById(id);
      if (el) el.value = data[id];
    }
    if (data._ytSourceMode) {
      const radio = document.querySelector(`input[name="ytSourceMode"][value="${data._ytSourceMode}"]`);
      if (radio) { radio.checked = true; radio.dispatchEvent(new Event("change", { bubbles: true })); }
    }
    _wavrickRestorePipelineState();
  } catch (e) { /* ignore */ }
}

const _YT_PIPELINE_STATE_KEY = "wavrick_yt_pipeline_state";

function _wavrickElVisible(id) {
  const el = document.getElementById(id);
  return Boolean(el && !el.classList.contains("hidden"));
}

function _wavrickSetElVisible(id, visible) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.toggle("hidden", !visible);
}

function _wavrickSavePipelineState() {
  try {
    const transcriptField = document.getElementById("ytTranscriptEdit");
    if (transcriptField?.value?.trim() && isYtTranscriptSrtLike(transcriptField.value)) {
      ytTranscriptSrt = transcriptField.value.trim();
    }
    const payload = {
      ytTranscriptPlain,
      ytTranscriptPlainAtWhisper,
      ytTranscriptSrt,
      ytWhisperSegments,
      ytWhisperDurationSec,
      ytWhisperTimeline,
      ytAssignRanges,
      ytAssignRangeHistory,
      ytAssignRangeSeq,
      ytActiveSpeaker,
      ytAssignClickMode,
      ytAssignPreviewFocusSpeaker,
      ui: {
        pipelineAfterTranscribe: _wavrickElVisible("pipelineAfterTranscribe"),
        lineAssign: _wavrickElVisible("ytLineAssignSection"),
        castSlots: _wavrickElVisible("ytCastSlotsSection"),
        scriptPreview: _wavrickElVisible("scriptPreview"),
        generateScript: _wavrickElVisible("generateScriptButton")
      },
      savedAt: Date.now()
    };
    sessionStorage.setItem(_YT_PIPELINE_STATE_KEY, JSON.stringify(payload));
  } catch (e) { /* quota — ignore */ }
}

function _wavrickRestorePipelineState() {
  try {
    const raw = sessionStorage.getItem(_YT_PIPELINE_STATE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (!saved.ytTranscriptPlain) return;

    ytTranscriptPlain = String(saved.ytTranscriptPlain || "");
    ytTranscriptPlainAtWhisper = String(saved.ytTranscriptPlainAtWhisper || "");
    ytTranscriptSrt = String(saved.ytTranscriptSrt || "");
    ytWhisperSegments = Array.isArray(saved.ytWhisperSegments) ? saved.ytWhisperSegments : [];
    ytWhisperDurationSec = Number(saved.ytWhisperDurationSec) || 0;
    ytWhisperTimeline = String(saved.ytWhisperTimeline || "");
    ytAssignRanges = Array.isArray(saved.ytAssignRanges) ? saved.ytAssignRanges : [];
    ytAssignRangeHistory = Array.isArray(saved.ytAssignRangeHistory) ? saved.ytAssignRangeHistory : [];
    ytAssignRangeSeq = Number(saved.ytAssignRangeSeq) || 0;
    ytActiveSpeaker = Number(saved.ytActiveSpeaker) || 1;
    ytAssignClickMode = Boolean(saved.ytAssignClickMode);
    ytAssignAnchor = null;
    ytAssignPreviewFocusSpeaker = Number(saved.ytAssignPreviewFocusSpeaker) || 0;

    const transcriptField = document.getElementById("ytTranscriptEdit");
    if (transcriptField) {
      transcriptField.value = ytTranscriptSrt || ytTranscriptPlain || "";
      if (!ytTranscriptSrt && ytWhisperSegments.length) {
        void buildYtWhisperSrtForDisplay(ytWhisperSegments, ytWhisperDurationSec).then(
          (srt) => {
            if (!srt || !transcriptField) return;
            ytTranscriptSrt = srt;
            transcriptField.value = srt;
          }
        );
      }
    }

    const ui = saved.ui || {};
    const showPipeline = ui.pipelineAfterTranscribe !== false;
    _wavrickSetElVisible("pipelineAfterTranscribe", showPipeline);
    _wavrickSetElVisible("ytLineAssignSection", ui.lineAssign !== false || showPipeline);
    _wavrickSetElVisible("ytCastSlotsSection", Boolean(ui.castSlots));
    _wavrickSetElVisible("scriptPreview", Boolean(ui.scriptPreview));
    _wavrickSetElVisible("generateScriptButton", Boolean(ui.generateScript));

    bindYtSpeakerPickerOnce();
    bindYtTranscriptDragSelectOnce();
    bindYtTranscriptClickModeOnce();
    bindYtAssignSummaryOnce();
    syncYtAssignModeUi();
    renderYtSpeakerPicker();
    renderYtSpeakerNames();
    renderYtTranscriptAssignView();
    updateYtAssignHint();
    renderYtCastSlots();
    if (ui.scriptPreview) updateYtQuotePreview();
  } catch (e) {
    console.warn("[wavrick] pipeline state restore failed", e);
  }
}

function _wavrickBindFormAutosave() {
  const handler = _wavrickSaveFormState;
  for (const id of _FORM_FIELDS_TO_SAVE) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.addEventListener("input", handler);
    el.addEventListener("change", handler);
  }
  document.querySelectorAll('input[name="ytSourceMode"]').forEach((r) => {
    r.addEventListener("change", handler);
  });
  window.addEventListener("pagehide", handler);
  window.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") handler();
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

function buildYoutubeOAuthStartUrl(channelKey, parentBase, opts = {}) {
  const cfg = getStoredSupabaseConfig();
  if (!cfg?.supabaseUrl) return "";
  const linkAll = Boolean(opts.linkAll);
  if (!linkAll && !channelKey) return "";
  const base = String(cfg.supabaseUrl).replace(/\/+$/, "");
  const u = new URL(`${base}/functions/v1/youtube-oauth-start`);
  if (linkAll) {
    u.searchParams.set("link_mode", "link_all");
  } else {
    u.searchParams.set("channel_key_b64", channelKeyToBase64(channelKey));
  }
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
  const P = getPricingApi();
  const normalized = P ? P.normalizeVoicePricing(data) : {};
  return {
    lastname: data.lastName || "",
    firstname: data.firstName || "",
    displayname: data.displayName || "",
    email: data.email || "",
    bio: data.bio || "",
    genres: data.genres || "",
    ratefrom: data.rateFrom ? Number(data.rateFrom) : null,
    price_per_minute: normalized.pricePerMinute ?? (data.pricePerMinute ? Number(data.pricePerMinute) : null),
    minimum_order_price: normalized.minimumOrderPrice ?? 0,
    additional_retake_price: normalized.additionalRetakePrice ?? 0,
    jobcount: data.jobCount ? Number(data.jobCount) : null,
    sampleurl: data.sampleUrl || "",
    avatarurl: data.avatarUrl || "",
    is_active: data.isActive !== false
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
    pricePerMinute: row.price_per_minute ?? row.pricePerMinute ?? "",
    minimumOrderPrice: row.minimum_order_price ?? row.minimumOrderPrice ?? "",
    additionalRetakePrice: row.additional_retake_price ?? row.additionalRetakePrice ?? "",
    jobCount: row.jobcount ?? "",
    sampleUrl: row.sampleurl || "",
    avatarUrl: row.avatarurl || row.avatarUrl || "",
    isActive: row.is_active !== false
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
    requestId: row.requestid || row.requestId || row.id || "",
    name: row.name || "",
    email: row.email || "",
    channelUrl: row.channelurl || row.channelUrl || "",
    videoUrl: row.videourl || row.videoUrl || "",
    videoChannelUrl: row.videochannelurl || row.videoChannelUrl || "",
    tone: row.tone || "",
    deadline: row.deadline || "",
    selectedTalentId: row.selectedtalentid || row.selectedTalentId || "",
    selectedTalentName: row.selectedtalentname || row.selectedTalentName || "",
    castMode: row.castmode || row.castMode || "",
    status: row.status || "",
    createdAt: row.created_at || row.createdAt || "",
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
    quote_amount_usd: wf.quoteAmountUsd != null ? Number(wf.quoteAmountUsd) : null,
    quote_breakdown: wf.quoteBreakdown || {},
    billable_seconds: Number(wf.billableSeconds || 0),
    paymentstatus: wf.paymentStatus || "unpaid",
    stripeurl: wf.stripeUrl || "",
    deliveries: wf.deliveries || [],
    revisioncount: Number(wf.revisionCount || 0),
    free_retakes_used: Number(wf.freeRetakesUsed ?? wf.revisionCount ?? 0),
    retake_payment_status: wf.retakePaymentStatus || "none",
    retake_fee_usd: wf.retakeFeeUsd != null ? Number(wf.retakeFeeUsd) : 0,
    transaction_phase: wf.transactionPhase || "draft",
    cast_acceptance: wf.castAcceptance || [],
    omakase_criteria: wf.omakaseCriteria || {},
    provisional_paid_at: wf.provisionalPaidAt || null,
    stripe_payment_intent_id: wf.stripePaymentIntentId || "",
    updated_at: wf.updatedAt || new Date().toISOString()
  };
}

function normalizeWorkflowMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.map((m) => ({
    sender: m.sender || "ユーザー",
    text: m.text || "",
    createdAt: m.createdAt || new Date().toISOString(),
    kind: m.kind || "chat"
  }));
}

function normalizeWorkflowDeliveries(deliveries) {
  if (!Array.isArray(deliveries)) return [];
  return deliveries.map((d) => ({
    url: d.url || "",
    note: d.note || "",
    createdAt: d.createdAt || new Date().toISOString(),
    kind: d.kind || "url",
    fileName: d.fileName || "",
    submittedBy: d.submittedBy || "",
    audioDataUrl: d.audioDataUrl || "",
    storagePath: d.storagePath || "",
    durationSec: d.durationSec != null ? Number(d.durationSec) : null
  }));
}

function defaultWorkflow(requestId, status) {
  return {
    requestId,
    status: status || REQUEST_STATUS_FLOW[0],
    messages: [],
    quoteAmount: "",
    quoteAmountUsd: null,
    quoteBreakdown: null,
    billableSeconds: 0,
    paymentStatus: "unpaid",
    stripeUrl: "",
    deliveries: [],
    revisionCount: 0,
    freeRetakesUsed: 0,
    retakePaymentStatus: "none",
    retakeFeeUsd: 0,
    transactionPhase: "draft",
    castAcceptance: [],
    omakaseCriteria: {},
    provisionalPaidAt: null,
    stripePaymentIntentId: "",
    updatedAt: new Date().toISOString()
  };
}

function getWorkflowForRequest(requestId, requestStatus) {
  const workflows = getWorkflows();
  const wf = workflows[requestId];
  if (!wf) return defaultWorkflow(requestId, requestStatus);
  return {
    ...defaultWorkflow(requestId, requestStatus),
    ...wf,
    messages: normalizeWorkflowMessages(wf.messages),
    deliveries: normalizeWorkflowDeliveries(wf.deliveries)
  };
}

function mapWorkflowFromRemote(row) {
  const wf = {
    requestId: row.requestid || "",
    status: row.status || REQUEST_STATUS_FLOW[0],
    messages: Array.isArray(row.messages) ? row.messages : [],
    quoteAmount: row.quoteamount || "",
    quoteAmountUsd: row.quote_amount_usd != null ? Number(row.quote_amount_usd) : null,
    quoteBreakdown: row.quote_breakdown && typeof row.quote_breakdown === "object" ? row.quote_breakdown : null,
    billableSeconds: Number(row.billable_seconds || 0),
    paymentStatus: row.paymentstatus || "unpaid",
    stripeUrl: row.stripeurl || "",
    deliveries: Array.isArray(row.deliveries) ? row.deliveries : [],
    revisionCount: Number(row.revisioncount || 0),
    freeRetakesUsed: Number(row.free_retakes_used ?? row.revisioncount ?? 0),
    retakePaymentStatus: row.retake_payment_status || "none",
    retakeFeeUsd: Number(row.retake_fee_usd || 0),
    transactionPhase: row.transaction_phase || "draft",
    castAcceptance: Array.isArray(row.cast_acceptance) ? row.cast_acceptance : [],
    omakaseCriteria:
      row.omakase_criteria && typeof row.omakase_criteria === "object" ? row.omakase_criteria : {},
    provisionalPaidAt: row.provisional_paid_at || null,
    stripePaymentIntentId: row.stripe_payment_intent_id || "",
    updatedAt: row.updated_at || row.created_at || new Date().toISOString()
  };
  wf.messages = normalizeWorkflowMessages(wf.messages);
  wf.deliveries = normalizeWorkflowDeliveries(wf.deliveries);
  return wf;
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
  localStorage.removeItem(ADMIN_CREDENTIAL_KEY);
  return null;
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

function loadVoiceProfilesForMatch() {
  return loadVoiceProfiles()
    .filter((p) => p.isActive !== false)
    .map((p) => ({
      ...p,
      talentId: getTalentId(p),
      displayName: p.displayName || `${p.lastName || ""} ${p.firstName || ""}`.trim() || "声優"
    }));
}

if (typeof window !== "undefined") {
  window.loadVoiceProfilesForMatch = loadVoiceProfilesForMatch;
}

const TALENT_HOME_SLIDER_ROWS = 6;

function getTalentDisplayMeta(profile) {
  const name = profile.displayName || `${profile.lastName || ""} ${profile.firstName || ""}`.trim() || "未設定";
  const P = getPricingApi();
  const rateText = P ? P.formatVoicePricingLines(profile).perMinute : "料金未設定";
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

  const TS = globalThis.WavrickTalentStats;
  const talentStats = TS ? TS.getTalentStats(tid) : null;
  const statsHtml = TS ? TS.renderCardStatsHtml(talentStats) : "";
  const ratingHtml = TS && talentStats ? TS.renderStarRatingHtml(talentStats.avgRating, talentStats.ratingCount, "sm") : "";
  const offline = profile.isActive === false;
  const offlineBadge = offline
    ? `<span class="talent-card-offline-badge">オフライン</span>`
    : "";

  let ctaHtml = "";
  if (withButton) {
    ctaHtml = offline
      ? `<button class="talent-cta talent-cta--disabled" type="button" data-offline-talent="1">この声優に依頼する</button>`
      : `<button class="talent-cta" type="button" data-select-talent-id="${tid}">この声優に依頼する</button>`;
  }

  return `
    <article class="${cardClass}"${clickAttrs}>
      ${offlineBadge}
      <div class="talent-top">
        ${renderTalentAvatarHtml(profile)}
        <div>
          <p class="talent-name">${name}</p>
          <p class="talent-meta">${meta}</p>
          ${ratingHtml}
        </div>
      </div>
      ${statsHtml}
      <p class="talent-bio">${profile.bio || "自己紹介はこれから登録されます。"}</p>
      ${renderTalentPricingHtml(profile)}
      <div class="talent-tags">${tagsHtml}</div>
      ${ctaHtml}
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
  const modalRatingEl = document.getElementById("talentModalRating");
  if (modalRatingEl) {
    const TS = globalThis.WavrickTalentStats;
    const s = TS ? TS.getTalentStats(getTalentId(profile)) : null;
    modalRatingEl.innerHTML = s ? TS.renderStarRatingHtml(s.avgRating, s.ratingCount, "md") : "";
  }
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
  const pricingEl = document.getElementById("talentModalPricing");
  if (pricingEl) pricingEl.innerHTML = renderTalentPricingHtml(profile);

  const statsEl = document.getElementById("talentModalStats");
  if (statsEl) {
    const TS = globalThis.WavrickTalentStats;
    const tid = getTalentId(profile);
    const offlineHtml = profile.isActive === false
      ? `<p class="talent-offline-notice" style="margin-bottom:0.75rem">※この声優は現在案件を受けていません</p>`
      : "";
    statsEl.innerHTML = offlineHtml + (TS ? TS.renderDetailedStatsHtml(TS.getTalentStats(tid)) : "");
  }

  const requestBtn = document.getElementById("talentModalRequestBtn");
  if (requestBtn) {
    const offline = profile.isActive === false;
    requestBtn.disabled = offline;
    requestBtn.textContent = offline ? "現在オフラインです" : "この声優に依頼する";
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

  const slotKey = sessionStorage.getItem("wavrick_pick_talent_slot");
  if (slotKey) {
    const speakerIndex = Number(slotKey);
    const count = getYtSpeakerCount();
    const slots = loadYtCastSlots(count);
    const target = slots.find((s) => s.speakerIndex === speakerIndex);
    if (target) {
      target.mode = "pick";
      target.talentId = tid;
      target.displayName = payload.displayName;
      saveYtCastSlots(slots, count);
      getSpeakerAssignApi()?.rememberVaPreset({
        speakerName: target.speakerName || `話者${speakerIndex}`,
        talentId: tid,
        displayName: payload.displayName,
        mode: "pick"
      });
      renderYtCastSlots();
    }
    sessionStorage.removeItem("wavrick_pick_talent_slot");
    showPage("yt");
    setMessage(
      "ytMessage",
      `「${getYtSpeakerLabel(speakerIndex)}」に ${payload.displayName} を割り当てました。`,
      "ok"
    );
    return;
  }

  const recastRequestId = sessionStorage.getItem("wavrick_recast_request");
  const recastSpeaker = sessionStorage.getItem("wavrick_recast_speaker");
  if (recastRequestId && recastSpeaker) {
    const speakerIndex = Number(recastSpeaker);
    sessionStorage.removeItem("wavrick_recast_request");
    sessionStorage.removeItem("wavrick_recast_speaker");
    const Tx = getTransactionApi();
    if (!Tx) {
      showPage("work");
      setMessage("workMessage", "取引モジュールを読み込めませんでした。", "err");
      return;
    }
    const workflows = getWorkflows();
    const wf = getWorkflowForRequest(recastRequestId);
    wf.castAcceptance = Tx.applyCustomerRecast(
      wf.castAcceptance || [],
      speakerIndex,
      tid,
      payload.displayName
    );
    maybeAdvanceTransactionPhase(wf);
    wf.updatedAt = new Date().toISOString();
    workflows[recastRequestId] = wf;
    saveWorkflows(workflows);
    if (isSupabaseEnabled()) {
      void upsertRemote(TABLES.requestWorkflows, mapWorkflowToRemote(wf), "requestid");
    }
    const rows = JSON.parse(localStorage.getItem("wavrick_youtube_requests") || "[]");
    const reqIdx = rows.findIndex((r) => r.requestId === recastRequestId);
    if (reqIdx >= 0) {
      syncRequestTalentIdsFromCastAcceptance(rows[reqIdx], wf.castAcceptance);
      localStorage.setItem("wavrick_youtube_requests", JSON.stringify(rows));
    }
    setWorkSelectedRequestId(recastRequestId);
    pushNotification(`話者${speakerIndex} の声優が再選定されました`, recastRequestId);
    pushNotification(`新しい案件依頼: 話者${speakerIndex}`, recastRequestId);
    showPage("work");
    setMessage("workMessage", `話者${speakerIndex} に ${payload.displayName} を再割り当てしました。`, "ok");
    window.dispatchEvent(new CustomEvent("wavrick-workdata-updated"));
    return;
  }

  localStorage.setItem("wavrick_selected_talent", JSON.stringify(payload));
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
      if (talentModalProfile.isActive === false) {
        alert("現在この声優は案件を募集していません。");
        return;
      }
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
  const sorted = sortTalentsForGrid(filtered);
  talentGrid.innerHTML = sorted.map((profile) => createTalentCard(profile, true, { clickable: true })).join("");
}

function getFilteredTalentsForGrid(profiles) {
  const budgetSel = document.getElementById("filterBudgetMax");
  const jobSel = document.getElementById("filterJobMin");
  const genreInput = document.getElementById("filterGenres");
  const onlineOnly = document.getElementById("filterOnlineOnly");

  const budgetMax = budgetSel && budgetSel.value ? Number(budgetSel.value) : null;
  const jobMin = jobSel && jobSel.value ? Number(jobSel.value) : null;
  const genreText = genreInput ? genreInput.value : "";
  const hideOffline = onlineOnly ? onlineOnly.checked : false;

  const desired = parseGenres(genreText).map((g) => g.toLowerCase());

  return profiles.filter((p) => {
    if (hideOffline && p.isActive === false) return false;

    const P = getPricingApi();
    const rate =
      P != null
        ? P.normalizeVoicePricing(p).pricePerMinute
        : p.rateFrom !== undefined && p.rateFrom !== null && p.rateFrom !== ""
          ? Number(p.rateFrom)
          : null;
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

function sortTalentsForGrid(profiles) {
  const sortSel = document.getElementById("filterSortOrder");
  const sortKey = sortSel ? sortSel.value : "";
  if (!sortKey) return profiles;

  const TS = globalThis.WavrickTalentStats;
  const P = getPricingApi();

  const getPrice = (p) => {
    if (P) return P.normalizeVoicePricing(p).pricePerMinute || 0;
    const v = p.rateFrom ?? p.pricePerMinute;
    return v !== undefined && v !== null && v !== "" ? Number(v) : 0;
  };

  const getJobs = (p) => {
    const v = p.jobCount;
    return v !== undefined && v !== null && v !== "" ? Number(v) : 0;
  };

  const getStats = (p) => {
    if (!TS) return null;
    return TS.getTalentStats(getTalentId(p));
  };

  const getAvgSpeedMs = (stats) => {
    if (!stats || !stats.hasData) return Infinity;
    const d = stats.avgDeliveryMs;
    const r = stats.avgRevisionResponseMs;
    if (d != null && r != null) return (d + r) / 2;
    if (d != null) return d;
    if (r != null) return r;
    return Infinity;
  };

  const sorted = [...profiles];
  sorted.sort((a, b) => {
    switch (sortKey) {
      case "jobs_desc":
        return getJobs(b) - getJobs(a);
      case "price_desc":
        return getPrice(b) - getPrice(a);
      case "price_asc":
        return getPrice(a) - getPrice(b);
      case "rating_desc": {
        const sa = getStats(a), sb = getStats(b);
        const ra = sa ? sa.avgRating : 0, rb = sb ? sb.avgRating : 0;
        if (rb !== ra) return rb - ra;
        return (sb ? sb.ratingCount : 0) - (sa ? sa.ratingCount : 0);
      }
      case "speed_asc": {
        const sa = getStats(a), sb = getStats(b);
        return getAvgSpeedMs(sa) - getAvgSpeedMs(sb);
      }
      default:
        return 0;
    }
  });
  return sorted;
}

function bindTalentPageInteractions() {
  const applyBtn = document.getElementById("applyTalentFilterBtn");
  const resetBtn = document.getElementById("resetTalentFilterBtn");

  if (applyBtn) {
    applyBtn.addEventListener("click", () => renderTalents());
  }
  const onlineOnlyCheckbox = document.getElementById("filterOnlineOnly");
  if (onlineOnlyCheckbox) {
    onlineOnlyCheckbox.addEventListener("change", () => renderTalents());
  }
  const sortSelect = document.getElementById("filterSortOrder");
  if (sortSelect) {
    sortSelect.addEventListener("change", () => renderTalents());
  }
  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      const budgetSel = document.getElementById("filterBudgetMax");
      const jobSel = document.getElementById("filterJobMin");
      const genreInput = document.getElementById("filterGenres");
      const onlineOnly = document.getElementById("filterOnlineOnly");
      const sortSel = document.getElementById("filterSortOrder");
      if (budgetSel) budgetSel.value = "";
      if (jobSel) jobSel.value = "";
      if (genreInput) genreInput.value = "";
      if (onlineOnly) onlineOnly.checked = false;
      if (sortSel) sortSel.value = "";
      renderTalents();
    });
  }

  const talentGrid = document.getElementById("talentGrid");
  if (talentGrid && talentGrid.dataset.bound !== "1") {
    talentGrid.dataset.bound = "1";
    talentGrid.addEventListener("click", (e) => {
      const offlineBtn = e.target?.closest?.("[data-offline-talent]");
      if (offlineBtn) {
        e.stopPropagation();
        alert("現在この声優は案件を募集していません。");
        return;
      }
      const btn = e.target?.closest?.("[data-select-talent-id]");
      if (btn) {
        e.stopPropagation();
        const tid = btn.getAttribute("data-select-talent-id");
        const profiles = loadVoiceProfiles();
        const selected = profiles.find((p) => getTalentId(p) === tid);
        if (selected) selectTalentForYtRequest(selected);
        return;
      }
      const card = e.target?.closest?.("[data-talent-id]");
      if (card) {
        const tid = card.getAttribute("data-talent-id");
        const profile = loadVoiceProfiles().find((p) => getTalentId(p) === tid);
        if (profile) openTalentProfileModal(profile);
      }
    });
    talentGrid.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const card = e.target?.closest?.("[data-talent-id]");
      if (!card) return;
      e.preventDefault();
      const tid = card.getAttribute("data-talent-id");
      const profile = loadVoiceProfiles().find((p) => getTalentId(p) === tid);
      if (profile) openTalentProfileModal(profile);
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

    const P = getPricingApi();
    if (P) {
      const check = P.validateVoicePricingInput(data);
      if (!check.ok) {
        setMessage("voiceMessage", check.errors.join(" "), "err");
        return;
      }
      Object.assign(data, check.normalized);
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
    persistVoiceSession(
      {
        email: data.email,
        displayName: data.displayName || `${data.lastName || ""} ${data.firstName || ""}`.trim()
      },
      data.email
    );
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
        pricePerMinute: 25,
        minimumOrderPrice: 10,
        additionalRetakePrice: 5,
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

function isLocalWavrickDevHost() {
  if (typeof location === "undefined") return false;
  const host = (location.hostname || "").toLowerCase();
  const port = location.port || (location.protocol === "https:" ? "443" : "80");
  return (host === "127.0.0.1" || host === "localhost") && port === "8889";
}

function formatMediaPipelineErrorMessage(raw) {
  const m = String(raw || "");
  if (/proxy:\s*HTTP\s*502|プロキシ\s*502|YouTube から音声を取得できません/i.test(m)) {
    if (isLocalWavrickDevHost()) {
      return (
        "YouTube から音声を取得できませんでした。① ターミナルで ./scripts/ensure-audio-proxy.sh を実行（プロキシ再起動）② ページを再読み込み ③ まだダメなら依頼フォームで「音声ファイル」を選んでアップロードしてください。"
      );
    }
    return (
      "YouTube から音声を取得できませんでした。しばらくして再試行するか、音声ファイルを直接アップロードしてください。"
    );
  }
  if (isLocalWavrickDevHost() && /5055|音声プロキシ|start-audio-proxy/i.test(m)) {
    return (
      "YouTube音声プロキシ (5055) が起動していません。Mac のターミナルで cd wavrick-app && ./scripts/start-audio-proxy.sh を実行し、表示が出たターミナルは閉じずにそのままにしてください。（http://127.0.0.1:8889 ではトンネルは不要です）"
    );
  }
  if (/401|Unauthorized/i.test(m)) {
    if (/OpenAI|openai/i.test(m)) {
      return m;
    }
    if (/xAI|x\.ai/i.test(m)) {
      return m;
    }
    if (/プロキシ|PROXY_SECRET|5055/i.test(m)) {
      return m;
    }
    return (
      "認証エラー (401) です。ターミナルで ./scripts/check-local-ai.sh を実行して、OpenAI キーと音声プロキシのどちらが原因か確認してください。"
    );
  }
  if (/OPENAI_API_KEY|XAI_API_KEY|secrets\.env/i.test(m)) {
    return (
      `${m} ローカル開発では ${isLocalWavrickDevHost() ? "scripts/secrets.env.example を参照し .local/secrets.env を作成するか、" : ""}Supabase の secrets と同じキーを Mac に設定してください。`
    );
  }
  if (/trycloudflare|dns error|lookup address|Name or service not known|音声プロキシ.*トンネル|Cloudflareトンネル/i.test(m)) {
    if (isLocalWavrickDevHost()) {
      return (
        "ローカル (8889) ではトンネルは不要です。① ./scripts/start-dev-server.sh で開き直す ② ./scripts/start-audio-proxy.sh を起動 ③ ページを再読み込み。まだ失敗する場合は古いタブを閉じ、http://127.0.0.1:8889/index.html だけで開いてください。"
      );
    }
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

async function invokeLocalMediaPipeline(body) {
  const res = await fetch("/api/media-pipeline", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = { ok: false, error: await res.text().catch(() => `HTTP ${res.status}`) };
  }
  if (!res.ok) {
    const msg =
      (data && (data.error || data.message)) ||
      (typeof data === "string" ? data : null) ||
      `HTTP ${res.status}`;
    return { data, error: { message: String(msg) } };
  }
  return { data, error: null };
}

async function invokeMediaPipeline(body) {
  if (isLocalWavrickDevHost()) {
    try {
      return await invokeLocalMediaPipeline(body);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/Failed to fetch|NetworkError|load failed/i.test(msg)) {
        return {
          data: null,
          error: {
            message:
              "ローカル AI API に接続できません。./scripts/start-dev-server.sh で 8889 を起動し直してください（python3 -m http.server だけでは AI 台本は動きません）。"
          }
        };
      }
      return { data: null, error: { message: msg } };
    }
  }
  if (!supabaseClient) {
    return { data: null, error: { message: "Supabase に接続してください。" } };
  }
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

const YT_CAST_SLOTS_KEY = "wavrick_yt_cast_slots";
const YT_ASSIGN_GAP_SEC = 10;
let ytTranscriptPlain = "";
let ytTranscriptPlainAtWhisper = "";
/** 文字起こし欄に表示する SRT（話者割り当ては ytTranscriptPlain を使用） */
let ytTranscriptSrt = "";
let ytWhisperSegments = [];
let ytWhisperDurationSec = 0;
/** 文字起こし時のブラケットタイムライン（Grok 台本の時刻の正） */
let ytWhisperTimeline = "";
let ytAssignRanges = [];
let ytAssignRangeHistory = [];
let ytAssignRangeSeq = 0;
let ytActiveSpeaker = 1;
let ytAssignClickMode = false;
let ytAssignAnchor = null;
let ytAssignPreviewFocusSpeaker = 0;

function getYtSpeakerCount() {
  const el = document.getElementById("ytSpeakerCount");
  const n = Number(el?.value || 2);
  if (!Number.isFinite(n)) return 2;
  return Math.min(6, Math.max(1, Math.round(n)));
}

function getSpeakerAssignApi() {
  return typeof WavrickSpeakerAssign !== "undefined" ? WavrickSpeakerAssign : null;
}

function defaultYtCastSlots(count) {
  return Array.from({ length: count }, (_, i) => ({
    speakerIndex: i + 1,
    speakerName: `話者${i + 1}`,
    mode: "omakase",
    talentId: "",
    displayName: ""
  }));
}

function getYtSpeakerLabel(speakerIndex) {
  const slots = loadYtCastSlots(getYtSpeakerCount());
  const slot = slots.find((s) => s.speakerIndex === speakerIndex);
  const name = String(slot?.speakerName || "").trim();
  return name || `話者${speakerIndex}`;
}

function setYtSpeakerName(speakerIndex, name) {
  const count = getYtSpeakerCount();
  const slots = loadYtCastSlots(count);
  const slot = slots.find((s) => s.speakerIndex === speakerIndex);
  if (!slot) return;
  slot.speakerName = String(name || "").trim() || `話者${speakerIndex}`;
  saveYtCastSlots(slots, count);
  renderYtSpeakerPicker();
  renderYtSpeakerNames();
  renderYtCastSlots();
  renderYtTranscriptAssignView();
}

function loadYtCastSlots(count) {
  const want = Math.min(6, Math.max(1, count || getYtSpeakerCount()));
  try {
    const raw = localStorage.getItem(YT_CAST_SLOTS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const saved = Array.isArray(parsed?.slots) ? parsed.slots : Array.isArray(parsed) ? parsed : null;
      if (saved?.length) {
        const byIndex = new Map(
          saved
            .filter((s) => s && typeof s.speakerIndex === "number")
            .map((s) => [s.speakerIndex, s])
        );
        return defaultYtCastSlots(want).map((slot) => {
          const prev = byIndex.get(slot.speakerIndex);
          if (!prev) return slot;
          return {
            speakerIndex: slot.speakerIndex,
            speakerName: String(prev.speakerName || "").trim() || `話者${slot.speakerIndex}`,
            mode: prev.mode === "pick" ? "pick" : "omakase",
            talentId: String(prev.talentId || ""),
            displayName: String(prev.displayName || "")
          };
        });
      }
    }
  } catch (_) {
    /* ignore corrupt storage */
  }
  return defaultYtCastSlots(want);
}

function saveYtCastSlots(slots, count) {
  const want = Math.min(6, Math.max(1, count || getYtSpeakerCount()));
  const normalized = defaultYtCastSlots(want).map((slot) => {
    const found = (slots || []).find((s) => s.speakerIndex === slot.speakerIndex);
    if (!found) return slot;
    return {
      speakerIndex: slot.speakerIndex,
      speakerName: String(found.speakerName || "").trim() || `話者${slot.speakerIndex}`,
      mode: found.mode === "pick" ? "pick" : "omakase",
      talentId: String(found.talentId || ""),
      displayName: String(found.displayName || "")
    };
  });
  localStorage.setItem(
    YT_CAST_SLOTS_KEY,
    JSON.stringify({ speakerCount: want, slots: normalized, updatedAt: new Date().toISOString() })
  );
  return normalized;
}

function validateYtCastSlots(count) {
  const slots = loadYtCastSlots(count);
  for (const slot of slots) {
    if (slot.mode === "pick" && !slot.talentId) {
      return {
        ok: false,
        message: `話者${slot.speakerIndex} で「自分で選ぶ」を選んだ場合は、声優一覧から声優を選んでください。`,
        slots
      };
    }
  }
  return { ok: true, slots };
}

const WAVRICK_RW_HANDOFF_KEY = "wavrick_rw_handoff";

function saveRecordWorkspaceHandoff(payload) {
  const requestId = (payload.requestId || "").trim() || `adhoc_${Date.now()}`;
  const videoUrl = (payload.videoUrl || "").trim();
  const script = (payload.script || "").trim();
  const refAudio = getReferenceAudioUrls();
  try {
    const meta = { videoUrl, requestId, savedAt: Date.now() };
    if (refAudio?.rawAudioUrl) meta.rawAudioUrl = refAudio.rawAudioUrl;
    if (refAudio?.cleanedAudioUrl) meta.cleanedAudioUrl = refAudio.cleanedAudioUrl;
    if (Array.isArray(payload.whisperSegments) && payload.whisperSegments.length) {
      meta.whisperSegments = payload.whisperSegments.slice(0, 2500);
      meta.whisperDurationSec =
        Number(payload.whisperDurationSec) ||
        (getSpeakerAssignApi()
          ? getSpeakerAssignApi().whisperDurationFromSegments(payload.whisperSegments)
          : 0);
    }
    if (script.length > 400000) {
      localStorage.setItem(`wavrick_rw_script_${requestId}`, script);
      meta.scriptRef = requestId;
    } else {
      meta.script = script;
    }
    sessionStorage.setItem(WAVRICK_RW_HANDOFF_KEY, JSON.stringify(meta));
    try {
      const rows = JSON.parse(localStorage.getItem("wavrick_youtube_requests") || "[]");
      const match =
        rows.find((r) => r.requestId === requestId) ||
        rows.find((r) => r.videoUrl === videoUrl);
      if (match) {
        if (script) match.script = script;
        if (meta.whisperSegments?.length) {
          match.whisperSegments = meta.whisperSegments;
          match.whisperDurationSec = meta.whisperDurationSec || 0;
        }
        match.updatedAt = new Date().toISOString();
        localStorage.setItem("wavrick_youtube_requests", JSON.stringify(rows));
      }
    } catch {
      /* ignore */
    }
    return true;
  } catch {
    try {
      localStorage.setItem(`wavrick_rw_script_${requestId}`, script);
      sessionStorage.setItem(
        WAVRICK_RW_HANDOFF_KEY,
        JSON.stringify({ videoUrl, requestId, scriptRef: requestId, savedAt: Date.now() })
      );
      return true;
    } catch {
      return false;
    }
  }
}

function openRecordWorkspace(handoff, messageId = "workMessage") {
  if (handoff?.requestId) {
    setWorkSelectedRequestId(handoff.requestId);
  }
  if (handoff?.videoUrl || handoff?.script) {
    if (!saveRecordWorkspaceHandoff(handoff)) {
      setMessage(messageId, "台本データが大きすぎて保存できませんでした。案件IDのみ引き継ぎます。", "err");
    }
  }
  window.location.href = "./record-workspace.html";
}

const RW_SCRIPT_IMPORT_VER = "rw-whisper-build7-2026-05-28";
const RW_GROK_WHISPER_ALIGN_VER = "rw-grok-whisper-align-2026-05-29";

function looksLikeBrokenTimecodedScript(raw) {
  const rows = String(raw || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (rows.length < 4) return false;
  const tcOnly = rows.filter((l) => /^\[\d{1,2}:\d{2}/.test(l) && !/\]\s+\S/.test(l)).length;
  return tcOnly >= Math.max(3, Math.floor(rows.length * 0.25));
}

function sanitizeScriptTextForRetime(raw) {
  const t = String(raw || "");
  const embeddedTcRe =
    /\[\d{1,2}:\d{2}(?:\.\d{1,3})?(?:\s*(?:->|→|-)\s*\d{1,2}:\d{2}(?:\.\d{1,3})?)?\]/g;
  const leadingTcLineRe =
    /^\[\d{1,2}:\d{2}(?:\.\d{1,3})?(?:\s*(?:->|→|-)\s*\d{1,2}:\d{2}(?:\.\d{1,3})?)?\]\s*(.*)$/;

  const out = [];
  for (const line of t.split(/\r?\n/)) {
    const trimmed = String(line || "").trim();
    if (!trimmed) continue;

    const m = trimmed.match(leadingTcLineRe);
    let text = null;
    if (m) {
      text = (m[1] || "").trim();
      if (!text) continue; // tc-only
    } else {
      text = trimmed;
    }

    text = text.replace(embeddedTcRe, "").trim();
    if (!text) continue;
    out.push(text);
  }

  return out.join("\n").trim();
}

async function applyTimecodedScriptToYtField() {
  const scriptField = document.getElementById("ytScript");
  let raw = scriptField?.value?.trim();
  if (!raw) {
    return null;
  }
  const hasWhisper = Array.isArray(ytWhisperSegments) && ytWhisperSegments.length;
  const whisperSegments = hasWhisper ? ytWhisperSegments : null;
  const hasAnyTc = /\[\d{1,2}:\d{2}/.test(raw);

  const isCastFormattedScript = /---\s*WAVRICK_CAST\s*---/i.test(raw);
  if (isCastFormattedScript) {
    return {
      script: raw,
      source: "pipeline-cast",
      lineCount: (raw.match(/^\[\d{1,2}:\d{2}/gm) || []).length
    };
  }

  if (ytWhisperTimeline.trim() && hasAnyTc) {
    raw = await alignYtScriptToWhisperTimeline(raw);
    scriptField.value = raw;
  }

  // Grok が生成したタイムコード付き台本はフロントで再計算しない（パースのみ）
  if (hasAnyTc) {
    try {
      const { isGrokTimecodedScript, parseScriptLines, scriptLinesToText } = await import(
        `./js/record-workspace/script-import.js?v=${RW_SCRIPT_IMPORT_VER}`
      );
      if (isGrokTimecodedScript(raw)) {
        const lines = parseScriptLines(raw);
        if (lines.length) {
          scriptField.value = scriptLinesToText(lines);
          const isSrt = /\d{2}:\d{2}:\d{2},\d{3}\s*-->/.test(raw);
          setMessage(
            "ytMessage",
            isSrt
              ? `SRT 台本を反映しました（${lines.length} キュー・フロント再計算なし）。`
              : `Grok のタイムコード台本を反映しました（${lines.length} 行・フロント再計算なし）。`,
            "ok"
          );
          return {
            script: scriptField.value,
            source: "grok-timecoded",
            lineCount: lines.length
          };
        }
      }
    } catch (e) {
      console.warn("[yt] grok timecode preserve check failed", e);
    }
  }
  if (hasWhisper && hasAnyTc) {
    raw = sanitizeScriptTextForRetime(raw);
    scriptField.value = raw;
  } else if (looksLikeBrokenTimecodedScript(raw)) {
    if (hasAnyTc) {
      raw = sanitizeScriptTextForRetime(raw);
      scriptField.value = raw;
    } else {
      raw = raw
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(
          (l) =>
            l &&
            !/^\[\d{1,2}:\d{2}(?:\.\d{1,3})?(?:\s*(?:->|→|-)\s*\d{1,2}:\d{2}(?:\.\d{1,3})?)?\]\s*$/.test(
              l
            )
        )
        .join("\n");
      scriptField.value = raw;
    }
  }
  const SA = window.WavrickSpeakerAssign;
  try {
    const { prepareScriptForWorkspace } = await import(
      `./js/record-workspace/script-import.js?v=${RW_SCRIPT_IMPORT_VER}`
    );
    const { resolveTimelineDurationSec } = await import(
      `./js/record-workspace/timecode.js?v=${RW_SCRIPT_IMPORT_VER}`
    );
    const dur = resolveTimelineDurationSec(
      ytWhisperDurationSec > 0 ? ytWhisperDurationSec : 0,
      whisperSegments
    );
    if (!hasWhisper) {
      setMessage(
        "ytMessage",
        "タイムコードを付けるには先に「文字起こし」が必要です（Whisper の発話時刻を使います）。",
        "err"
      );
      return null;
    }
    const prep = prepareScriptForWorkspace(raw, dur, {
      whisperSegments,
      whisperDurationSec: dur
    });
    if (prep.script) {
      scriptField.value = prep.script;
    }
    if (prep?.script) {
      const src = prep.source || "ok";
      const kind = String(src).includes("whisper")
        ? "ok"
        : "err";
      setMessage(
        "ytMessage",
        kind === "ok"
          ? `台本を整形しました（${src} / ${prep.lineCount || 0}行・発話開始/終了時刻）`
          : `台本を整形しましたが Whisper 未連携です（${src}）。文字起こし後にもう一度お試しください。`,
        kind
      );
    }
    return prep;
  } catch (e) {
    console.warn("[yt] timecode apply failed", e);
    setMessage(
      "ytMessage",
      `台本の整形に失敗しました: ${e instanceof Error ? e.message : String(e)}`,
      "err"
    );
    return null;
  }
}

async function openRecordWorkspaceFromYtForm() {
  const videoUrl = document.getElementById("ytVideoUrl")?.value?.trim() || "";
  let script = document.getElementById("ytScript")?.value?.trim() || "";
  if (!isYouTubeUrl(videoUrl)) {
    setMessage(
      "ytMessage",
      "先に YouTube 動画 URL を入力するか、台本生成まで進めてください。",
      "err"
    );
    return;
  }
  if (!script) {
    setMessage("ytMessage", "台本が空です。生成するか、タイムコード付き台本を貼り付けてください。", "err");
    return;
  }
  const prep = await applyTimecodedScriptToYtField();
  if (prep?.script) script = prep.script;
  try{const rr=JSON.parse(localStorage.getItem("wavrick_youtube_requests")||"[]");const m=rr.find(r=>r.videoUrl===videoUrl);if(m){m.script=script;if(Array.isArray(ytWhisperSegments)&&ytWhisperSegments.length){m.whisperSegments=ytWhisperSegments.slice(0,2500);m.whisperDurationSec=ytWhisperDurationSec||0}}else{rr.push({requestId:`adhoc_${Date.now()}`,videoUrl,script,name:"ブース直接",createdAt:new Date().toISOString(),whisperSegments:Array.isArray(ytWhisperSegments)?ytWhisperSegments.slice(0,2500):null,whisperDurationSec:ytWhisperDurationSec||0})}localStorage.setItem("wavrick_youtube_requests",JSON.stringify(rr))}catch(e){}
  openRecordWorkspace({
    videoUrl,
    script,
    requestId: null,
    whisperSegments: ytWhisperSegments,
    whisperDurationSec: ytWhisperDurationSec
  });
}

async function openRecordWorkspaceFromWorkPage() {
  const requestSelect = document.getElementById("workRequestSelect");
  const rows = await getVisibleRequestsForCurrentSession();
  const request =
    rows.find((r) => r.requestId === requestSelect?.value) ||
    rows.find((r) => r.requestId === getWorkSelectedRequestId()) ||
    rows[0];
  if (!request) {
    setMessage("workMessage", "開ける案件がありません。", "err");
    return false;
  }
  setWorkSelectedRequestId(request.requestId);
  const videoUrl = (request.videoUrl || "").trim();
  const script = (request.script || "").trim();
  if (!isYouTubeUrl(videoUrl)) {
    setMessage("workMessage", "この案件に有効な YouTube 動画 URL がありません。", "err");
    return false;
  }
  if (!script) {
    setMessage(
      "workMessage",
      "台本が空です。収録ブースでは台本エディタに貼り付けてください。",
      "ok"
    );
  }
  openRecordWorkspace(
    {
      videoUrl,
      script,
      requestId: request.requestId || null
    },
    "workMessage"
  );
  return true;
}

function splitYtScriptBodyIntoLines(text) {
  const t = String(text || "").trim();
  if (!t) return [];
  const rows = t
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (rows.length > 1) return rows;
  if (/[。！？!?]/.test(t)) {
    const sentences = t
      .split(/(?<=[。！？!?])/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (sentences.length > 1) return sentences;
  }
  return [t];
}

function formatPipelineScriptForField(data, count, slots) {
  const castMeta = {
    schemaVersion: 2,
    castMode: "multi",
    speakerCount: count,
    castSlots: slots
  };
  const parts = ["--- WAVRICK_CAST ---", JSON.stringify(castMeta, null, 2), "---", ""];
  const scriptsBySpeaker = data?.scriptsBySpeaker && typeof data.scriptsBySpeaker === "object" ? data.scriptsBySpeaker : {};
  for (let i = 1; i <= count; i++) {
    const key = String(i);
    const bodyText = String(scriptsBySpeaker[key] || scriptsBySpeaker[i] || "").trim();
    const slot = slots.find((s) => s.speakerIndex === i);
    const speakerLabel = getYtSpeakerLabel(i);
    const castLabel =
      slot?.mode === "omakase" ? "おまかせ" : slot?.displayName || slot?.talentId || "未選択";
    const blocks =
      /\d{2}:\d{2}:\d{2},\d{3}\s*-->/.test(bodyText)
        ? bodyText
            .split(/\n\s*\n\s*\n/)
            .map((b) => b.trim())
            .filter(Boolean)
        : /\n\n---\n\n/.test(bodyText) && /->/.test(bodyText)
          ? bodyText
              .split(/\n\n---\n\n/)
              .map((b) => b.trim())
              .filter(Boolean)
          : /\n---\n/.test(bodyText) || /^\[(\d{1,2}):(\d{2})/.test(bodyText)
            ? bodyText
                .split(/\n---\n/)
                .map((b) => b.trim())
                .filter(Boolean)
            : splitGeneratedSpeakerBodyByTimeGap(bodyText, YT_ASSIGN_GAP_SEC);
    if (!blocks.length) {
      parts.push(`【${speakerLabel} / 声優: ${castLabel}】`);
      parts.push("（空）");
      parts.push("");
      continue;
    }
    blocks.forEach((block, bi) => {
      const partLabel = blocks.length > 1 ? ` / ブロック${bi + 1}` : "";
      parts.push(`【${speakerLabel} / 声優: ${castLabel}${partLabel}】`);
      const blockLines = splitYtScriptBodyIntoLines(block || "");
      parts.push(blockLines.length ? blockLines.join("\n") : "（空）");
      parts.push("");
    });
  }
  const ref = String(data?.referenceTranslation || data?.translation || "").trim();
  if (ref) {
    parts.push("【参考: 全体訳】");
    parts.push(ref);
    parts.push("");
  }
  return parts.join("\n").trim();
}

function resetYtSpeakerAssign() {
  ytTranscriptPlain = "";
  ytTranscriptPlainAtWhisper = "";
  ytWhisperSegments = [];
  ytWhisperDurationSec = 0;
  ytWhisperTimeline = "";
  ytAssignRanges = [];
  ytAssignRangeHistory = [];
  ytAssignRangeSeq = 0;
  ytActiveSpeaker = 1;
  ytAssignAnchor = null;
  ytAssignPreviewFocusSpeaker = 0;
}

function splitGeneratedSpeakerBodyByTimeGap(bodyText, gapSec) {
  const raw = String(bodyText || "").trim();
  if (!raw) return [];
  const LINE_RE =
    /^\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?(?:\s*(?:->|→|-)\s*(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?)?\]\s*(.+)$/;
  const parseTc = (min, sec, frac) => {
    const f = frac == null || frac === "" ? 0 : Number(frac);
    const digits = String(frac || "").length;
    const fracSec = !Number.isFinite(f) ? 0 : digits <= 2 ? f / 100 : digits === 3 ? f / 1000 : f;
    return Number(min) * 60 + Number(sec) + fracSec;
  };
  const rows = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const m = t.match(LINE_RE);
    if (!m) {
      if (rows.length) rows[rows.length - 1].textLines.push(t);
      else rows.push({ startSec: 0, endSec: null, textLines: [t] });
      continue;
    }
    const startSec = parseTc(m[1], m[2], m[3]);
    const endSec = m[4] != null ? parseTc(m[4], m[5], m[6]) : null;
    rows.push({ startSec, endSec, textLines: [m[7].trim()] });
  }
  if (!rows.length) return [raw];
  const blocks = [];
  let batch = [];
  let lastEnd = null;
  const flush = () => {
    if (!batch.length) return;
    blocks.push(batch.join("\n"));
    batch = [];
  };
  for (const row of rows) {
    if (lastEnd != null && row.startSec - lastEnd > gapSec) flush();
    const end =
      row.endSec != null && row.endSec > row.startSec
        ? row.endSec
        : row.startSec + 2;
    batch.push(`[${formatYtTimecode(row.startSec)}${row.endSec != null ? ` - ${formatYtTimecode(row.endSec)}` : ""}] ${row.textLines.join(" ")}`);
    lastEnd = end;
  }
  flush();
  return blocks.length ? blocks : [raw];
}

function formatYtTimecode(seconds) {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  const whole = Math.floor(sec);
  const cs = Math.round((sec - whole) * 100);
  return `${String(m).padStart(2, "0")}:${String(whole).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function isYtTranscriptSrtLike(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  return (
    /\d{1,2}:\d{2}:\d{2}[,.]\d{3}\s*-->/.test(t) ||
    /^\[\d{1,2}:\d{2}(?:\.\d{2})?\s*(?:->|→|-)/m.test(t)
  );
}

async function buildYtWhisperSrtForDisplay(segments, durationSec, apiSrt, apiTimeline) {
  if (typeof apiSrt === "string" && apiSrt.trim()) {
    return apiSrt.trim();
  }
  if (typeof apiTimeline === "string" && apiTimeline.trim()) {
    return apiTimeline.trim();
  }
  if (!Array.isArray(segments) || !segments.length) return "";
  try {
    const { buildBracketTimelineFromWhisperSegments } = await import(
      `./js/record-workspace/timecode-silence-gap.js?v=${RW_SCRIPT_IMPORT_VER}`
    );
    return buildBracketTimelineFromWhisperSegments(segments, durationSec) || "";
  } catch (e) {
    console.warn("[yt] build whisper timeline failed", e);
    return "";
  }
}

async function ingestWhisperTimingFromTranscribe(data) {
  const SA = getSpeakerAssignApi();
  ytWhisperSegments = SA
    ? SA.normalizeWhisperSegments(data?.whisperSegments)
    : Array.isArray(data?.whisperSegments)
      ? data.whisperSegments
      : [];
  ytWhisperDurationSec =
    Number(data?.audioDurationSec) ||
    Number(data?.whisperDurationSec) ||
    (SA ? SA.whisperDurationFromSegments(ytWhisperSegments) : 0) ||
    0;

  if (ytWhisperDurationSec > 0 && ytWhisperSegments.length) {
    try {
      const { clampWhisperSegmentsToTimeline } = await import(
        `./js/record-workspace/timecode.js?v=${RW_SCRIPT_IMPORT_VER}`
      );
      ytWhisperSegments = clampWhisperSegmentsToTimeline(
        ytWhisperSegments,
        ytWhisperDurationSec
      );
    } catch {
      /* ignore */
    }
  }
  ytTranscriptPlainAtWhisper = String(data?.whisperTranscript || "").trim();
  ytTranscriptSrt = await buildYtWhisperSrtForDisplay(
    ytWhisperSegments,
    ytWhisperDurationSec,
    data?.whisperSrt,
    data?.whisperTimeline
  );
  ytWhisperTimeline = String(data?.whisperTimeline || ytTranscriptSrt || "").trim();
}

async function alignYtScriptToWhisperTimeline(scriptText) {
  const canon = String(ytWhisperTimeline || "").trim();
  const raw = String(scriptText || "").trim();
  if (!canon || !raw || !/\[\d{1,2}:\d{2}/.test(raw)) return raw;
  try {
    const { alignGrokScriptToWhisperTimeline, stripTranscribeBuildMarker } = await import(
      `./js/record-workspace/grok-whisper-align.js?v=${RW_GROK_WHISPER_ALIGN_VER}`
    );
    return alignGrokScriptToWhisperTimeline(stripTranscribeBuildMarker(canon), raw);
  } catch (e) {
    console.warn("[yt] align script to whisper timeline failed", e);
    return raw;
  }
}

const REFERENCE_AUDIO_KEY = "wavrick_reference_audio";

function storeReferenceAudioUrls(rawUrl, cleanedUrl) {
  const payload = { rawAudioUrl: rawUrl || null, cleanedAudioUrl: cleanedUrl || null };
  try { localStorage.setItem(REFERENCE_AUDIO_KEY, JSON.stringify(payload)); } catch { /* */ }
}

function getReferenceAudioUrls() {
  try { return JSON.parse(localStorage.getItem(REFERENCE_AUDIO_KEY) || "null"); } catch { return null; }
}

function resolvePlainTextPosition(container, plainOffset) {
  if (!container) return null;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let pos = 0;
  let node = walker.nextNode();
  while (node) {
    const len = node.textContent.length;
    if (plainOffset <= pos + len) {
      return { node, offset: Math.max(0, plainOffset - pos) };
    }
    pos += len;
    node = walker.nextNode();
  }
  return null;
}

function getPlainOffsetFromPointer(container, clientX, clientY) {
  if (!container) return null;
  let range = null;
  if (document.caretRangeFromPoint) {
    range = document.caretRangeFromPoint(clientX, clientY);
  } else if (document.caretPositionFromPoint) {
    const caret = document.caretPositionFromPoint(clientX, clientY);
    if (caret) {
      range = document.createRange();
      range.setStart(caret.offsetNode, caret.offset);
      range.collapse(true);
    }
  }
  if (!range || !container.contains(range.startContainer)) return null;
  const pre = document.createRange();
  pre.selectNodeContents(container);
  pre.setEnd(range.startContainer, range.startOffset);
  const offset = pre.toString().length;
  const max = ytTranscriptPlain.length;
  return Math.max(0, Math.min(offset, max));
}

function setDomSelectionPlainRange(container, start, end) {
  const startPos = resolvePlainTextPosition(container, start);
  const endPos = resolvePlainTextPosition(container, end);
  if (!startPos || !endPos) return false;
  const range = document.createRange();
  range.setStart(startPos.node, startPos.offset);
  range.setEnd(endPos.node, endPos.offset);
  const sel = window.getSelection();
  if (!sel) return false;
  sel.removeAllRanges();
  sel.addRange(range);
  return true;
}

function scrollPlainOffsetIntoView(container, plainOffset) {
  const pos = resolvePlainTextPosition(container, plainOffset);
  if (!pos) return;
  const range = document.createRange();
  range.setStart(pos.node, pos.offset);
  range.collapse(true);
  const rect = range.getClientRects()[0];
  if (!rect) return;
  const boxRect = container.getBoundingClientRect();
  if (rect.top < boxRect.top || rect.bottom > boxRect.bottom) {
    let el = pos.node.nodeType === Node.TEXT_NODE ? pos.node.parentElement : pos.node;
    while (el && el !== container) {
      if (el.scrollIntoView) {
        el.scrollIntoView({ block: "nearest", behavior: "smooth" });
        break;
      }
      el = el.parentElement;
    }
  }
}

function syncYtAssignModeUi() {
  const btn = document.getElementById("ytAssignApplyBtn");
  const box = document.getElementById("ytTranscriptAssign");
  const label = btn?.querySelector(".speaker-assign-btn-label");
  if (btn) {
    btn.classList.toggle("is-on", ytAssignClickMode);
    btn.setAttribute("aria-pressed", ytAssignClickMode ? "true" : "false");
    if (label) {
      label.textContent = ytAssignClickMode ? "クリックで範囲指定: ON" : "クリックで範囲指定: OFF";
    }
  }
  if (box) {
    box.classList.toggle("transcript-assign--click-mode", ytAssignClickMode);
    box.dataset.clickMode = ytAssignClickMode ? "1" : "0";
  }
}

function toggleYtAssignClickMode() {
  ytAssignClickMode = !ytAssignClickMode;
  ytAssignAnchor = null;
  const sel = window.getSelection();
  if (sel) sel.removeAllRanges();
  syncYtAssignModeUi();
  updateYtAssignHint();
  _wavrickSavePipelineState();
  setMessage(
    "ytMessage",
    ytAssignClickMode
      ? "クリック指定 ON — 文字起こしで始まりの位置をタップし、続けて終わりの位置をタップすると色付けされます。"
      : "クリック指定 OFF — いつも通りドラッグで範囲を選べます（離すと色付き）。",
    "ok"
  );
}

function assignPlainRangeToActiveSpeaker(start, end) {
  const added = addYtAssignRange(start, end, ytActiveSpeaker);
  if (!added) return { ok: false, message: "選択範囲が短すぎます。" };
  ytAssignPreviewFocusSpeaker = 0;
  const sel = window.getSelection();
  if (sel) sel.removeAllRanges();
  renderYtTranscriptAssignView();
  updateYtAssignHint();
  document.getElementById("ytCastSlotsSection")?.classList.remove("hidden");
  document.getElementById("generateScriptButton")?.classList.remove("hidden");
  _wavrickSavePipelineState();
  const len = end - start;
  return {
    ok: true,
    message: `話者${ytActiveSpeaker} に ${len} 文字を割り当てました。`
  };
}

function selectSpeakerAssignmentsInEditor(speakerIndex) {
  const box = document.getElementById("ytTranscriptAssign");
  if (!box || !ytTranscriptPlain) {
    return { ok: false, message: "文字起こしがまだありません。" };
  }
  const chunks = ytAssignRanges
    .filter((r) => r.speakerIndex === speakerIndex)
    .sort((a, b) => a.start - b.start);
  if (!chunks.length) {
    return { ok: false, message: `話者${speakerIndex} に割り当てられた文字はまだありません。` };
  }

  ytAssignPreviewFocusSpeaker = speakerIndex;
  ytActiveSpeaker = speakerIndex;
  renderYtSpeakerPicker();
  renderYtTranscriptAssignView();

  const sel = window.getSelection();
  if (!sel) return { ok: false, message: "ブラウザがテキスト選択に対応していません。" };
  sel.removeAllRanges();
  let added = 0;
  for (const r of chunks) {
    const startPos = resolvePlainTextPosition(box, r.start);
    const endPos = resolvePlainTextPosition(box, r.end);
    if (!startPos || !endPos) continue;
    const range = document.createRange();
    range.setStart(startPos.node, startPos.offset);
    range.setEnd(endPos.node, endPos.offset);
    sel.addRange(range);
    added++;
  }

  scrollPlainOffsetIntoView(box, chunks[0].start);
  scrollPlainOffsetIntoView(box, chunks[chunks.length - 1].end);

  const totalChars = chunks.reduce((n, r) => n + (r.end - r.start), 0);
  updateYtAssignHint();
  updateYtAssignSummary();
  return {
    ok: true,
    message: `話者${speakerIndex} の割り当て ${totalChars} 文字（${chunks.length} か所）をエディタで選択しました。`
  };
}

function getSelectionOffsetsInElement(container) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) return null;
  const preStart = document.createRange();
  preStart.selectNodeContents(container);
  preStart.setEnd(range.startContainer, range.startOffset);
  const start = preStart.toString().length;
  const selected = range.toString();
  if (!selected) return null;
  const end = start + selected.length;
  if (end <= start) return null;
  const max = ytTranscriptPlain.length;
  return { start: Math.max(0, Math.min(start, max)), end: Math.max(0, Math.min(end, max)) };
}

function addYtAssignRange(start, end, speakerIndex) {
  const max = ytTranscriptPlain.length;
  const s = Math.max(0, Math.min(start, max));
  const e = Math.max(s, Math.min(end, max));
  if (e <= s) return false;

  const kept = [];
  for (const r of ytAssignRanges) {
    if (r.end <= s || r.start >= e) {
      kept.push(r);
      continue;
    }
    if (r.start < s) {
      kept.push({
        id: ++ytAssignRangeSeq,
        start: r.start,
        end: s,
        speakerIndex: r.speakerIndex
      });
    }
    if (r.end > e) {
      kept.push({
        id: ++ytAssignRangeSeq,
        start: e,
        end: r.end,
        speakerIndex: r.speakerIndex
      });
    }
  }
  ytAssignRanges = kept;
  const id = ++ytAssignRangeSeq;
  ytAssignRanges.push({ id, start: s, end: e, speakerIndex });
  ytAssignRanges.sort((a, b) => a.start - b.start);
  ytAssignRangeHistory.push(id);
  return true;
}

function countAssignedChars() {
  let n = 0;
  for (const r of ytAssignRanges) n += r.end - r.start;
  return n;
}

function renderYtSpeakerNames() {
  const grid = document.getElementById("ytSpeakerNames");
  if (!grid) return;
  const count = getYtSpeakerCount();
  const slots = loadYtCastSlots(count);
  grid.innerHTML = slots
    .map((slot) => {
      const i = slot.speakerIndex;
      const val = escapeHtml(slot.speakerName || `話者${i}`);
      return `
        <label class="speaker-assign-name-field">
          <span class="speaker-assign-name-chip speaker-${i}">話者${i}</span>
          <input type="text" class="speaker-assign-name-input" data-speaker-name="${i}" value="${val}" maxlength="40" placeholder="例: ナレーター">
        </label>`;
    })
    .join("");

  grid.querySelectorAll("[data-speaker-name]").forEach((input) => {
    if (input.dataset.bound === "1") return;
    input.dataset.bound = "1";
    input.addEventListener("change", () => {
      const idx = Number(input.getAttribute("data-speaker-name")) || 1;
      setYtSpeakerName(idx, input.value);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        input.blur();
      }
    });
  });
}

function bindYtSpeakerPickerOnce() {
  const picker = document.getElementById("ytSpeakerPicker");
  if (!picker || picker.dataset.bound === "1") return;
  picker.dataset.bound = "1";
  picker.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-speaker-pick]");
    if (!btn) return;
    e.preventDefault();
    ytActiveSpeaker = Number(btn.getAttribute("data-speaker-pick")) || 1;
    renderYtSpeakerPicker();
    updateYtAssignHint();
    _wavrickSavePipelineState();
    setMessage(
      "ytMessage",
      `いまは話者${ytActiveSpeaker} です。下の文字起こしをドラッグして範囲を選ぶと、この色で塗ります。`,
      "ok"
    );
  });
}

function bindYtTranscriptDragSelectOnce() {
  if (document.documentElement.dataset.ytDragBound === "1") return;
  document.documentElement.dataset.ytDragBound = "1";

  function tryAssignFromSelection() {
    const section = document.getElementById("ytLineAssignSection");
    if (!section || section.classList.contains("hidden")) return;
    if (ytAssignClickMode) return;
    const result = assignSelectionToActiveSpeaker();
    if (result.message) setMessage("ytMessage", result.message, result.ok ? "ok" : "err");
  }

  document.addEventListener("mouseup", tryAssignFromSelection);
  document.addEventListener("touchend", tryAssignFromSelection, { passive: true });
}

function bindYtTranscriptClickModeOnce() {
  const box = document.getElementById("ytTranscriptAssign");
  if (!box || box.dataset.clickBound === "1") return;
  box.dataset.clickBound = "1";

  box.addEventListener("mousemove", (e) => {
    if (!ytAssignClickMode || ytAssignAnchor == null) return;
    const hover = getPlainOffsetFromPointer(box, e.clientX, e.clientY);
    if (hover == null) return;
    const start = Math.min(ytAssignAnchor, hover);
    const end = Math.max(ytAssignAnchor, hover);
    if (end > start) setDomSelectionPlainRange(box, start, end);
  });

  box.addEventListener("click", (e) => {
    if (!ytAssignClickMode) return;
    e.preventDefault();
    const offset = getPlainOffsetFromPointer(box, e.clientX, e.clientY);
    if (offset == null) return;

    if (ytAssignAnchor == null) {
      ytAssignAnchor = offset;
      const sel = window.getSelection();
      if (sel) sel.removeAllRanges();
      updateYtAssignHint();
      setMessage("ytMessage", "始まりの位置を指定しました。続けて終わりの位置をタップしてください。", "ok");
      return;
    }

    const start = Math.min(ytAssignAnchor, offset);
    const end = Math.max(ytAssignAnchor, offset);
    ytAssignAnchor = null;
    const result = assignPlainRangeToActiveSpeaker(start, end);
    setMessage("ytMessage", result.message, result.ok ? "ok" : "err");
  });
}

function bindYtAssignSummaryOnce() {
  const summary = document.getElementById("ytAssignSummary");
  if (!summary || summary.dataset.bound === "1") return;
  summary.dataset.bound = "1";
  summary.addEventListener("click", (e) => {
    const row = e.target.closest("[data-speaker-summary]");
    if (!row) return;
    e.preventDefault();
    const speakerIndex = Number(row.getAttribute("data-speaker-summary")) || 1;
    const result = selectSpeakerAssignmentsInEditor(speakerIndex);
    setMessage("ytMessage", result.message, result.ok ? "ok" : "err");
  });
}

function renderYtSpeakerPicker() {
  const picker = document.getElementById("ytSpeakerPicker");
  if (!picker) return;
  const count = getYtSpeakerCount();
  picker.innerHTML = Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    const active = n === ytActiveSpeaker ? " active" : "";
    const label = escapeHtml(getYtSpeakerLabel(n));
    return `<button type="button" class="speaker-chip speaker-${n}${active}" data-speaker-pick="${n}" role="tab" aria-selected="${n === ytActiveSpeaker}">${label}</button>`;
  }).join("");
}

function renderYtTranscriptAssignView() {
  const box = document.getElementById("ytTranscriptAssign");
  if (!box) return;
  const plain = ytTranscriptPlain;
  if (!plain) {
    box.innerHTML = "";
    return;
  }
  const ranges = [...ytAssignRanges].sort((a, b) => a.start - b.start);
  let html = "";
  let pos = 0;
  for (const r of ranges) {
    if (r.start > pos) html += escapeHtml(plain.slice(pos, r.start));
    const slice = plain.slice(r.start, r.end);
    if (r.speakerIndex >= 1 && r.speakerIndex <= 6) {
      const focus =
        ytAssignPreviewFocusSpeaker === r.speakerIndex ? " speaker-assign-preview-focus" : "";
      const spkLabel = getYtSpeakerLabel(r.speakerIndex);
      html += `<span class="speaker-highlight speaker-${r.speakerIndex}${focus}" title="${escapeHtml(spkLabel)}">${escapeHtml(slice)}</span>`;
    } else {
      html += escapeHtml(slice);
    }
    pos = r.end;
  }
  if (pos < plain.length) html += escapeHtml(plain.slice(pos));
  box.innerHTML = html;
  updateYtAssignSummary();
}

function updateYtAssignHint() {
  const hint = document.getElementById("ytAssignHint");
  if (!hint) return;
  const total = ytTranscriptPlain.length;
  if (!total) {
    hint.textContent = `いまの操作: 話者${ytActiveSpeaker} — 「文字起こし」後にここに全文が表示されます。`;
    return;
  }
  const assigned = countAssignedChars();
  if (ytAssignClickMode) {
    if (ytAssignAnchor != null) {
      hint.textContent = `クリック指定 ON — 話者${ytActiveSpeaker} — 終わりの位置をタップしてください（${assigned}/${total} 文字割り当て済み）。`;
      return;
    }
    hint.textContent = `クリック指定 ON — 話者${ytActiveSpeaker} — 始まり→終わりの順にタップ（${assigned}/${total} 文字割り当て済み）。`;
    return;
  }
  hint.textContent = `ドラッグ選択 — 話者${ytActiveSpeaker} — 下をドラッグして範囲選択（${assigned}/${total} 文字割り当て済み）。同じ範囲を選び直すと話者を変更できます。`;
}

function updateYtAssignSummary() {
  const el = document.getElementById("ytAssignSummary");
  if (!el) return;
  const count = getYtSpeakerCount();
  const rows = [];
  for (let i = 1; i <= count; i++) {
    const parts = ytAssignRanges
      .filter((r) => r.speakerIndex === i)
      .sort((a, b) => a.start - b.start)
      .map((r) => ytTranscriptPlain.slice(r.start, r.end).trim())
      .filter(Boolean);
    const preview = parts.length ? truncateText(parts.join(" "), 72) : "（まだなし）";
    const activePreview = ytAssignPreviewFocusSpeaker === i ? " is-preview-active" : "";
    const spkLabel = getYtSpeakerLabel(i);
    rows.push(
      `<button type="button" class="speaker-summary-row speaker-${i}${activePreview}" data-speaker-summary="${i}" title="${escapeHtml(spkLabel)}の割り当て全文をエディタで選択">` +
        `<strong>${escapeHtml(spkLabel)}</strong>: ${escapeHtml(preview)}` +
        `</button>`
    );
  }
  el.innerHTML = rows.join("");
}

function startYtSpeakerAssignFromTranscript(transcriptField) {
  const fieldText = (transcriptField?.value || "").trim();
  if (isYtTranscriptSrtLike(fieldText)) {
    ytTranscriptSrt = fieldText;
  }
  const text = isYtTranscriptSrtLike(fieldText)
    ? (ytTranscriptPlainAtWhisper || ytTranscriptPlain || "").trim()
    : fieldText;
  if (!text) return false;
  const changed = text !== ytTranscriptPlain;
  ytTranscriptPlain = text;
  if (changed) {
    ytAssignRanges = [];
    ytAssignRangeHistory = [];
  }
  ytActiveSpeaker = 1;
  const section = document.getElementById("ytLineAssignSection");
  if (section) section.classList.remove("hidden");
  bindYtSpeakerPickerOnce();
  bindYtTranscriptDragSelectOnce();
  bindYtTranscriptClickModeOnce();
  bindYtAssignSummaryOnce();
  syncYtAssignModeUi();
  renderYtSpeakerPicker();
  renderYtSpeakerNames();
  renderYtTranscriptAssignView();
  updateYtAssignHint();
  renderYtCastSlots();
  _wavrickSavePipelineState();
  return true;
}

function assignSelectionToActiveSpeaker() {
  const box = document.getElementById("ytTranscriptAssign");
  if (!box || !ytTranscriptPlain) return { ok: false, message: "" };
  const offsets = getSelectionOffsetsInElement(box);
  if (!offsets) {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim()) {
      return { ok: false, message: "選択範囲を文字起こしボックス内でドラッグしてください。" };
    }
    return { ok: false, message: "" };
  }
  return assignPlainRangeToActiveSpeaker(offsets.start, offsets.end);
}

function undoYtSpeakerAssign() {
  const lastId = ytAssignRangeHistory.pop();
  if (lastId == null) return { ok: false, message: "取り消す割り当てがありません。" };
  ytAssignRanges = ytAssignRanges.filter((r) => r.id !== lastId);
  renderYtTranscriptAssignView();
  updateYtAssignHint();
  _wavrickSavePipelineState();
  return { ok: true, message: "直前の割り当てを取り消しました。" };
}

function collectSpeakersFromRanges(count) {
  const SA = getSpeakerAssignApi();
  const plain = ytTranscriptPlain;
  const timeAt = SA
    ? SA.buildPlainOffsetTimeMapper(plain, ytWhisperSegments, ytWhisperDurationSec)
  : (offset) => (offset / Math.max(plain.length, 1)) * (ytWhisperDurationSec || 1);

  const buckets = [];
  for (let i = 1; i <= count; i++) {
    const speakerRanges = ytAssignRanges
      .filter((r) => r.speakerIndex === i)
      .sort((a, b) => a.start - b.start);
    const lines = SA
      ? SA.groupSpeakerLinesByTimeGap(speakerRanges, plain, timeAt, YT_ASSIGN_GAP_SEC)
      : speakerRanges
          .map((r) => plain.slice(r.start, r.end).trim())
          .filter(Boolean);
    if (lines.length) {
      buckets.push({ id: i, label: getYtSpeakerLabel(i), lines });
    }
  }
  return buckets;
}

function hasYtSpeakerAssignments() {
  return ytAssignRanges.length > 0;
}



function renderYtCastSlotSuggestion(slot) {
  const SA = getSpeakerAssignApi();
  if (!SA || (slot.mode === "pick" && slot.talentId)) return "";
  const hit = SA.suggestVaPreset(slot.speakerName || `話者${slot.speakerIndex}`);
  if (!hit) return "";
  const name = escapeHtml(hit.displayName || hit.talentId);
  const spk = escapeHtml(hit.speakerName);

  const profile = resolveVoiceProfileByTalentId(hit.talentId);
  if (profile && profile.isActive === false) {
    return `<p class="cast-slot-suggestion cast-slot-suggestion--offline">以前「${spk}」には <strong>${name}</strong> を使っています。<br><span class="talent-offline-notice">※この声優は現在案件を受けていません</span></p>`;
  }

  return `<p class="cast-slot-suggestion">以前「${spk}」には <strong>${name}</strong> を使っています。<button type="button" class="btn-ghost cast-slot-suggestion-btn" data-apply-preset="${slot.speakerIndex}">この声優を提案どおりに選ぶ</button></p>`;
}

function renderCastSlotTalentPreview(slot) {
  if (slot.mode !== "pick" || !slot.talentId) return "";
  const profile = resolveVoiceProfileByTalentId(slot.talentId);
  if (!profile) {
    return `<p class="cast-slot-talent-name">${escapeHtml(slot.displayName || "未選択")}</p>`;
  }
  const { name, meta } = getTalentDisplayMeta(profile);
  const genres = parseGenres(profile.genres).slice(0, 3);
  const tagsHtml = genres.length
    ? genres.map((g) => `<span class="talent-tag">${g}</span>`).join("")
    : "";
  const TS = globalThis.WavrickTalentStats;
  const tid = getTalentId(profile);
  const statsHtml = TS ? TS.renderCardStatsHtml(TS.getTalentStats(tid)) : "";
  const offline = profile.isActive === false;
  const offlineNotice = offline
    ? `<p class="talent-offline-notice">※この声優は現在案件を受けていません</p>`
    : "";
  return `
    <div class="cast-slot-profile${offline ? " cast-slot-profile--offline" : ""}">
      <div class="talent-top">
        ${renderTalentAvatarHtml(profile)}
        <div>
          <p class="talent-name">${name}</p>
          <p class="talent-meta">${meta}</p>
        </div>
      </div>
      ${offlineNotice}
      ${statsHtml}
      ${renderTalentPricingHtml(profile)}
      ${tagsHtml ? `<div class="talent-tags">${tagsHtml}</div>` : ""}
    </div>`;
}

function renderYtCastSlots() {
  const container = document.getElementById("ytCastSlots");
  const section = document.getElementById("ytCastSlotsSection");
  const genBtn = document.getElementById("generateScriptButton");
  if (!container || !section) return;
  const count = getYtSpeakerCount();
  const slots = loadYtCastSlots(count);
  saveYtCastSlots(slots, count);
  section.classList.remove("hidden");
  if (genBtn) genBtn.classList.remove("hidden");

  container.innerHTML = slots
    .map((slot) => {
      const i = slot.speakerIndex;
      const pickHidden = slot.mode !== "pick" ? " hidden" : "";
      const talentPreview = renderCastSlotTalentPreview(slot);
      const showPlain = slot.mode === "pick" && !slot.talentId;
      return `
    <div class="cast-slot-card" data-speaker-index="${i}">
      <h4>${escapeHtml(getYtSpeakerLabel(i))} の声優</h4>
      ${renderYtCastSlotSuggestion(slot)}
      <div class="cast-slot-modes">
        <label><input type="radio" name="castSlotMode${i}" value="pick" ${slot.mode === "pick" ? "checked" : ""}> 自分で選ぶ</label>
        <label><input type="radio" name="castSlotMode${i}" value="omakase" ${slot.mode !== "pick" ? "checked" : ""}> おまかせ</label>
      </div>
      <div class="cast-slot-pick${pickHidden}" id="castSlotPick${i}">
        ${talentPreview || (showPlain ? `<p class="cast-slot-talent-name">未選択</p>` : "")}
        <button type="button" class="btn-ghost" data-pick-talent-slot="${i}">${slot.talentId ? "別の声優を選ぶ" : "声優一覧で選ぶ"}</button>
      </div>
    </div>`;
    })
    .join("");

  slots.forEach((slot) => {
    const i = slot.speakerIndex;
    container.querySelectorAll(`input[name="castSlotMode${i}"]`).forEach((radio) => {
      radio.addEventListener("change", () => {
        const updated = loadYtCastSlots(count);
        const target = updated.find((s) => s.speakerIndex === i);
        if (!target) return;
        target.mode = radio.value === "pick" ? "pick" : "omakase";
        if (target.mode === "omakase") {
          target.talentId = "";
          target.displayName = "";
        }
        saveYtCastSlots(updated, count);
        renderYtCastSlots();
      });
    });
  });

  container.querySelectorAll("[data-pick-talent-slot]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.getAttribute("data-pick-talent-slot"));
      sessionStorage.setItem("wavrick_pick_talent_slot", String(idx));
      showPage("talents");
    });
  });

  container.querySelectorAll("[data-apply-preset]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.getAttribute("data-apply-preset"));
      const SA = getSpeakerAssignApi();
      const slots = loadYtCastSlots(getYtSpeakerCount());
      const slot = slots.find((s) => s.speakerIndex === idx);
      if (!slot || !SA) return;
      const hit = SA.suggestVaPreset(slot.speakerName || `話者${idx}`);
      if (!hit?.talentId) return;
      slot.mode = "pick";
      slot.talentId = hit.talentId;
      slot.displayName = hit.displayName || hit.talentId;
      saveYtCastSlots(slots, getYtSpeakerCount());
      renderYtCastSlots();
      setMessage("ytMessage", `「${slot.speakerName}」に ${slot.displayName} を割り当てました（以前の利用履歴）。`, "ok");
    });
  });

  updateYtQuotePreview();
}

function getCastSlotsForRequest(request) {
  if (Array.isArray(request?.castSlots) && request.castSlots.length) return request.castSlots;
  const meta = parseCastMetaFromScript(request?.script || "");
  return meta?.castSlots || [];
}

function buildQuoteForCastAndScript(castSlots, script) {
  const P = getPricingApi();
  if (!P || !script?.trim()) return null;
  return P.computeProjectQuote({
    castSlots: castSlots || [],
    script,
    resolveVoice: resolveVoiceProfileByTalentId
  });
}

function buildQuoteForCurrentYtForm() {
  const script = document.getElementById("ytScript")?.value?.trim() || "";
  const count = getYtSpeakerCount();
  const slots = loadYtCastSlots(count);
  return buildQuoteForCastAndScript(slots, script);
}

function updateYtQuotePreview() {
  const box = document.getElementById("ytQuotePreview");
  const body = document.getElementById("ytQuotePreviewBody");
  const P = getPricingApi();
  if (!box || !body || !P) return;
  const quote = buildQuoteForCurrentYtForm();
  if (!quote || quote.totalBillableSeconds <= 0) {
    box.classList.add("hidden");
    return;
  }
  const count = getYtSpeakerCount();
  const formSlots = loadYtCastSlots(count);
  const Tx = getTransactionApi();
  const speakerRows = quote.speakers
    .map((s) => {
      const slot = formSlots.find((x) => x.speakerIndex === s.speakerIndex);
      let name = s.displayName;
      if (slot?.mode === "omakase") name = "おまかせ（確定前は非表示）";
      else if (Tx && slot) name = Tx.getCustomerSlotLabel({ ...slot, status: "pending_acceptance" }, formSlots);
      return `<tr><td>話者${s.speakerIndex}</td><td>${escapeHtml(name)}</td><td>${escapeHtml(P.formatBillableDuration(s.billableSeconds))}</td><td>${escapeHtml(P.formatUsd(s.subtotalUsd))}${s.minimumApplied ? ' <span class="quote-min">(最低価格)</span>' : ""}</td></tr>`;
    })
    .join("");
  body.innerHTML = `
    <table class="quote-table">
      <thead><tr><th>話者</th><th>声優</th><th>課金枠</th><th>小計</th></tr></thead>
      <tbody>${speakerRows}</tbody>
    </table>
    <p class="quote-total"><strong>お支払い総額: ${escapeHtml(P.formatUsd(quote.totalUsd))}</strong></p>
    <p class="section-desc">分配予定: 声優 ${escapeHtml(P.formatUsd(quote.voiceUsd))}（70%） / 運営 ${escapeHtml(P.formatUsd(quote.platformUsd))}（30%）</p>
  `;
  box.classList.remove("hidden");
  refreshYtProvisionalPayButton();
}

function isYtFormVerified() {
  if (isCustomerLoggedIn()) return true;
  const badge = document.getElementById("verifyBadge");
  return Boolean(badge?.classList.contains("done"));
}

async function handleStripePaymentReturn(requestId) {
  const Tx = getTransactionApi();
  const workflows = getWorkflows();
  const wf = workflows[requestId];
  if (wf) {
    wf.paymentStatus = "paid_provisional";
    wf.transactionPhase = Tx ? Tx.TRANSACTION_PHASE.awaiting_acceptance : "awaiting_acceptance";
    wf.provisionalPaidAt = new Date().toISOString();
    saveWorkflows(workflows);
    if (isSupabaseEnabled()) {
      await upsertRemote(
        TABLES.requestWorkflows,
        mapWorkflowToRemote(wf),
        "requestid"
      );
    }
    const castAcceptance = wf.castAcceptance || [];
    pushNotification(`決済完了・新規案件: ${requestId}`, requestId);
    for (const slot of castAcceptance) {
      if (slot.talentId) {
        pushNotification(`案件の回答依頼（話者${slot.speakerIndex}）`, requestId);
      }
    }
  }
  showPage("work");
  setWorkSelectedRequestId(requestId);
  setMessage("workMessage", "決済が完了しました。声優の受諾後に本取引が開始されます。", "ok");
}

function refreshYtProvisionalPayButton() {
  const payBtn = document.getElementById("ytProvisionalPayBtn");
  const quote = buildQuoteForCurrentYtForm();
  if (!payBtn) return;
  const show = Boolean(quote?.totalBillableSeconds > 0 && isYtFormVerified());
  payBtn.classList.toggle("hidden", !show);
}

function collectOmakaseCriteriaFromForm() {
  const gender = document.getElementById("ytOmakaseGender")?.value?.trim() || "";
  const budgetRaw = document.getElementById("ytOmakaseBudget")?.value;
  const genres = document.getElementById("ytOmakaseGenres")?.value?.trim() || "";
  const budgetMaxUsd = budgetRaw !== "" && budgetRaw != null ? Number(budgetRaw) : null;
  return {
    gender,
    budgetMaxUsd: budgetMaxUsd != null && !Number.isNaN(budgetMaxUsd) ? budgetMaxUsd : null,
    genres
  };
}

function syncRequestTalentIdsFromCastAcceptance(request, castAcceptance) {
  const ids = (castAcceptance || []).map((s) => s.talentId).filter(Boolean);
  request.selectedTalentId = [...new Set(ids)].join(",");
  request.selectedTalentName = (castAcceptance || [])
    .map((s) => {
      const Tx = getTransactionApi();
      const label = Tx ? Tx.getCustomerSlotLabel(s, castAcceptance) : s.displayName || "—";
      return `話者${s.speakerIndex}: ${label}`;
    })
    .join(" / ");
}

function maybeAdvanceTransactionPhase(wf) {
  const Tx = getTransactionApi();
  if (!Tx || !wf?.castAcceptance?.length) return wf;
  if (wf.transactionPhase === Tx.TRANSACTION_PHASE.cancelled) return wf;
  if (Tx.allSlotsAccepted(wf.castAcceptance)) {
    wf.transactionPhase = Tx.TRANSACTION_PHASE.in_production;
    if (REQUEST_STATUS_FLOW.indexOf(wf.status) < REQUEST_STATUS_FLOW.indexOf("進行中")) {
      wf.status = "進行中";
    }
  } else if (
    wf.transactionPhase === Tx.TRANSACTION_PHASE.paid_provisional ||
    wf.transactionPhase === Tx.TRANSACTION_PHASE.awaiting_acceptance
  ) {
    wf.transactionPhase = Tx.TRANSACTION_PHASE.awaiting_acceptance;
  }
  return wf;
}

function renderWorkTransactionPanel(request, session, wf) {
  const card = document.getElementById("workTransactionCard");
  const phaseEl = document.getElementById("workTransactionPhase");
  const listEl = document.getElementById("workCastAcceptanceList");
  const cancelBtn = document.getElementById("workCancelTransactionBtn");
  const Tx = getTransactionApi();
  if (!card || !phaseEl || !listEl || session?.role !== "customer") return;

  const phase = wf.transactionPhase || "draft";
  const show =
    phase === Tx?.TRANSACTION_PHASE.paid_provisional ||
    phase === Tx?.TRANSACTION_PHASE.awaiting_acceptance ||
    phase === Tx?.TRANSACTION_PHASE.in_production ||
    (wf.castAcceptance?.length > 0 && phase !== Tx?.TRANSACTION_PHASE.cancelled);

  card.classList.toggle("hidden", !show);
  if (!show) return;

  phaseEl.textContent = Tx
    ? `${Tx.transactionPhaseLabel(phase)} — 決済後、全員の受諾で本取引が開始されます。`
    : phase;

  const slots = wf.castAcceptance || [];
  const canSeeNames = Tx ? Tx.customerCanSeeTalentNames(slots) : true;

  listEl.innerHTML = slots.length
    ? slots
        .map((slot) => {
          const label = Tx ? Tx.getCustomerSlotLabel(slot, slots) : slot.displayName || "—";
          const statusLabel = Tx ? Tx.slotStatusLabel(slot.status) : slot.status;
          const recastBtn =
            slot.mode === "pick" && slot.status === Tx?.SLOT_STATUS.declined
              ? `<button type="button" class="btn-ghost btn-sm" data-recast-speaker="${slot.speakerIndex}">別の声優を選ぶ</button>`
              : "";
          return `<div class="cast-acceptance-row">
            <span class="cast-acceptance-speaker">話者${slot.speakerIndex}</span>
            <span class="cast-acceptance-name">${escapeHtml(canSeeNames ? label : label)}</span>
            <span class="cast-acceptance-status">${escapeHtml(statusLabel)}</span>
            ${recastBtn}
          </div>`;
        })
        .join("")
    : `<p class="section-desc">キャスティング情報はまだありません。</p>`;

  listEl.querySelectorAll("[data-recast-speaker]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.getAttribute("data-recast-speaker"));
      sessionStorage.setItem("wavrick_recast_speaker", String(idx));
      sessionStorage.setItem("wavrick_recast_request", request.requestId || "");
      showPage("talents");
    });
  });

  if (cancelBtn) {
    const cancelled = phase === Tx?.TRANSACTION_PHASE.cancelled;
    cancelBtn.classList.toggle("hidden", cancelled || phase === Tx?.TRANSACTION_PHASE.in_production);
  }
}

function renderWorkVoiceOfferCard(request, session, wf) {
  const card = document.getElementById("workVoiceOfferCard");
  const hint = document.getElementById("workVoiceOfferHint");
  const acceptBtn = document.getElementById("workVoiceAcceptBtn");
  const declineBtn = document.getElementById("workVoiceDeclineBtn");
  const Tx = getTransactionApi();
  if (!card || session?.role !== "voice") return;

  const talentId = resolveVoiceTalentIdForSession(session);
  const phase = wf.transactionPhase || "draft";
  const awaiting =
    phase === Tx?.TRANSACTION_PHASE.awaiting_acceptance ||
    phase === Tx?.TRANSACTION_PHASE.paid_provisional;
  const slots = wf.castAcceptance || [];
  const mySlot = Tx ? Tx.getVoiceSlotForTalent(slots, talentId) : slots.find((s) => s.talentId === talentId);

  if (!awaiting || !mySlot) {
    card.classList.add("hidden");
    return;
  }

  card.classList.remove("hidden");
  const onHold = Tx?.isTransactionOnHoldForVoice(slots, talentId);
  const pending = mySlot.status === Tx?.SLOT_STATUS.pending_acceptance;

  if (onHold) {
    hint.textContent = "他の声優の回答待ちです（取引保留中）。全員が受諾すると本取引が開始されます。";
    acceptBtn?.classList.add("hidden");
    declineBtn?.classList.add("hidden");
    return;
  }

  if (mySlot.status === Tx?.SLOT_STATUS.accepted) {
    hint.textContent = "この案件を受諾済みです。他の声優の回答を待っています。";
    acceptBtn?.classList.add("hidden");
    declineBtn?.classList.add("hidden");
    return;
  }

  if (mySlot.status === Tx?.SLOT_STATUS.declined) {
    card.classList.add("hidden");
    return;
  }

  hint.textContent = `話者${mySlot.speakerIndex} として依頼が届いています。24時間以内の回答をお願いします（デモ）。`;
  acceptBtn?.classList.remove("hidden");
  declineBtn?.classList.remove("hidden");
  acceptBtn.disabled = !pending;
  declineBtn.disabled = !pending;
}

function bindYtPipelineWizard() {
  const scriptField = document.getElementById("ytScript");
  if (scriptField && scriptField.dataset.quoteBound !== "1") {
    scriptField.dataset.quoteBound = "1";
    scriptField.addEventListener("input", () => updateYtQuotePreview());
  }
  const transcribeBtn = document.getElementById("ytTranscribeButton");
  const assignUndoBtn = document.getElementById("ytAssignUndoBtn");
  const assignApplyBtn = document.getElementById("ytAssignApplyBtn");
  const genBtn = document.getElementById("generateScriptButton");
  const status = document.getElementById("aiStatus");
  const afterBox = document.getElementById("pipelineAfterTranscribe");
  const scriptPreview = document.getElementById("scriptPreview");
  const videoUrlField = document.getElementById("ytVideoUrl");
  const transcriptField = document.getElementById("ytTranscriptEdit");
  const speakerCountEl = document.getElementById("ytSpeakerCount");
  const step1 = document.getElementById("aiStep1");
  if (!transcribeBtn || !genBtn || !videoUrlField || !transcriptField) return;

  bindYtSpeakerPickerOnce();
  bindYtTranscriptDragSelectOnce();
  bindYtTranscriptClickModeOnce();
  bindYtAssignSummaryOnce();
  syncYtAssignModeUi();
  renderYtSpeakerPicker();
  renderYtSpeakerNames();
  updateYtAssignHint();

  transcriptField.addEventListener("blur", () => {
    const afterBox = document.getElementById("pipelineAfterTranscribe");
    if (!afterBox || afterBox.classList.contains("hidden")) return;
    if (!transcriptField.value.trim()) return;
    startYtSpeakerAssignFromTranscript(transcriptField);
  });
  transcriptField.addEventListener("input", () => {
    _wavrickSaveFormState();
  });

  if (speakerCountEl) {
    speakerCountEl.addEventListener("change", () => {
      const count = getYtSpeakerCount();
      saveYtCastSlots(loadYtCastSlots(count), count);
      if (ytActiveSpeaker > count) ytActiveSpeaker = count;
      renderYtSpeakerPicker();
      renderYtSpeakerNames();
      if (ytAssignRanges.length) {
        ytAssignRanges = ytAssignRanges.filter((r) => r.speakerIndex <= count);
        ytAssignRangeHistory = ytAssignRangeHistory.filter((id) =>
          ytAssignRanges.some((r) => r.id === id)
        );
        renderYtTranscriptAssignView();
      }
      renderYtCastSlots();
    });
  }

  transcribeBtn.addEventListener("click", async () => {
    const sourceMode = getYtSourceMode();
    const videoUrl = videoUrlField.value.trim();
    const mismatchEl = document.getElementById("ytChannelMismatch");
    const CA = getCustomerAccountApi();
    let pipelineBody = { mode: "transcribe" };

    if (sourceMode === "audio") {
      const fileInput = document.getElementById("ytAudioFile");
      const file = fileInput?.files?.[0];
      if (!file) {
        setMessage("ytMessage", "音声ファイルを選択してください。", "err");
        return;
      }
      setMessage("ytMessage", "音声をアップロードしています…", "ok");
      try {
        const uploaded = await uploadCustomerAudioWithFallback(file);
        pipelineBody = { mode: "transcribe", audioUrl: uploaded.url };
      } catch (err) {
        setMessage("ytMessage", err instanceof Error ? err.message : String(err), "err");
        return;
      }
    } else {
      if (!isYouTubeUrl(videoUrl)) {
        setMessage(
          "ytMessage",
          "YouTube の動画URLとして認識できませんでした。例: https://www.youtube.com/watch?v=…",
          "err"
        );
        return;
      }
      if (isCustomerLoggedIn() && !isYtChannelCheckBypassed()) {
        const channels = getCustomerChannels();
        if (!channels.length) {
          setMessage(
            "ytMessage",
            "YouTube 利用にはチャンネル登録が必要です。マイページから追加してください。",
            "err"
          );
          showPage("account");
          return;
        }
        if (CA) {
          try {
            const meta = await CA.fetchVideoMeta(videoUrl);
            const match = CA.videoUploaderMatchesChannels(meta, channels);
            if (!match.ok) {
              if (mismatchEl) mismatchEl.classList.remove("hidden");
              setMessage(
                "ytMessage",
                "この動画のチャンネルは登録一覧と一致しません。マイページからチャンネルを追加するか、テスト用の「チャンネル不一致ロックを無効化」をオンにしてください。",
                "err"
              );
              return;
            }
            if (mismatchEl) mismatchEl.classList.add("hidden");
          } catch (err) {
            setMessage("ytMessage", err instanceof Error ? err.message : String(err), "err");
            return;
          }
        }
      } else if (mismatchEl) {
        mismatchEl.classList.add("hidden");
      }
      pipelineBody = { mode: "transcribe", videoUrl };
    }

    if (!isLocalWavrickDevHost() && !initSupabaseClient()) {
      setMessage("ytMessage", "Supabase に接続するか、ローカル開発サーバ (8889) で開いてください。", "err");
      return;
    }

    setMessage("ytMessage", "");
    if (status) status.classList.remove("hidden");
    if (afterBox) afterBox.classList.add("hidden");
    if (scriptPreview) scriptPreview.classList.add("hidden");
    transcribeBtn.disabled = true;
    const label = transcribeBtn.textContent;
    transcribeBtn.textContent = "文字起こし中...";
    if (step1) {
      step1.textContent =
        sourceMode === "audio"
          ? "音声ファイルを WhisperX で文字起こし中..."
          : "動画から音声を取得し、WhisperX で文字起こし中...";
      step1.classList.add("ai-step-active");
    }

    try {
      const { data, error } = await invokeMediaPipeline(pipelineBody);
      if (error && (!data || data.ok === undefined)) {
        setMessage("ytMessage", formatMediaPipelineErrorMessage(error.message) || "文字起こしに失敗しました。", "err");
        return;
      }
      if (data && data.ok === false) {
        setMessage("ytMessage", formatMediaPipelineErrorMessage(data.error) || "文字起こしに失敗しました。", "err");
        return;
      }
      if (!data?.ok || !data.whisperTranscript) {
        setMessage(
          "ytMessage",
          "文字起こし結果がありません。Edge Function media-pipeline を再デプロイしたか確認してください（mode=transcribe 対応）。",
          "err"
        );
        return;
      }

      await ingestWhisperTimingFromTranscribe(data);
      ytTranscriptPlain = String(data.whisperTranscript || "").trim();
      ytTranscriptPlainAtWhisper = ytTranscriptPlain;
      transcriptField.value = ytTranscriptSrt || ytTranscriptPlain;
      if (data.rawAudioUrl || data.cleanedAudioUrl) {
        storeReferenceAudioUrls(data.rawAudioUrl, data.cleanedAudioUrl);
      }
      if (afterBox) afterBox.classList.remove("hidden");
      startYtSpeakerAssignFromTranscript(transcriptField);
      _wavrickSavePipelineState();
      const ms = typeof data.durationMs === "number" ? Math.round(data.durationMs / 1000) : null;
      const build = data.transcribeBuild;
      const lineCount = data.timelineLineCount;
      const gaps = data.silenceGapCount;
      const buildHint =
        build >= 8
          ? ` 末尾の [Wavrick-${build}] が見えれば最新パイプラインです。`
          : build != null
            ? `（build=${build} は古いです → ./scripts/restart-local-ai.sh）`
            : "（build 不明・WhisperX 未接続の可能性）";
      setMessage(
        "ytMessage",
        `文字起こしが完了しました${ms != null ? `（約${ms}秒）` : ""}。` +
          (lineCount != null ? ` ${lineCount} 行` : "") +
          (gaps != null ? `・無音検出 ${gaps} 箇所` : "") +
          buildHint +
          " 話者割り当ては下の欄でドラッグしてください。",
        "ok"
      );
    } catch (err) {
      setMessage("ytMessage", err instanceof Error ? err.message : String(err), "err");
    } finally {
      if (status) status.classList.add("hidden");
      transcribeBtn.disabled = false;
      transcribeBtn.textContent = label;
      if (step1) step1.classList.remove("ai-step-active");
    }
  });

  if (assignUndoBtn) {
    assignUndoBtn.addEventListener("click", () => {
      const result = undoYtSpeakerAssign();
      setMessage("ytMessage", result.message, result.ok ? "ok" : "err");
    });
  }

  if (assignApplyBtn) {
    assignApplyBtn.addEventListener("click", () => {
      toggleYtAssignClickMode();
    });
  }

  document.getElementById("ytOpenRecordWorkspaceBtn")?.addEventListener("click", () => {
    openRecordWorkspaceFromYtForm();
  });

  genBtn.addEventListener("click", async () => {
    const videoUrl = videoUrlField.value.trim();
    const count = getYtSpeakerCount();
    if (!hasYtSpeakerAssignments()) {
      setMessage(
        "ytMessage",
        "先に話者ボタンを選び、文字起こしをドラッグして全文に話者を割り当ててください。",
        "err"
      );
      return;
    }
    const castCheck = validateYtCastSlots(count);
    if (!castCheck.ok) {
      setMessage("ytMessage", castCheck.message, "err");
      return;
    }
    const speakers = collectSpeakersFromRanges(count);
    if (!speakers.length) {
      setMessage("ytMessage", "話者に割り当てられたセリフがありません。", "err");
      return;
    }
    if (!initSupabaseClient()) {
      setMessage("ytMessage", "Supabase に接続してから利用してください。", "err");
      return;
    }
    if (!Array.isArray(ytWhisperSegments) || !ytWhisperSegments.length) {
      setMessage(
        "ytMessage",
        "先に「素材から文字起こし（Whisper）」を実行してください。Grok は Whisper のタイムスタンプ付きデータを使って台本を作ります。",
        "err"
      );
      return;
    }

    const tone = document.getElementById("ytTone")?.value || "";
    setMessage("ytMessage", "");
    genBtn.disabled = true;
    const genLabel = genBtn.textContent;
    genBtn.textContent = "台本生成中...";

    try {
      const { data, error } = await invokeMediaPipeline({
        mode: "script",
        videoUrl: videoUrl || undefined,
        speakerCount: count,
        speakers,
        tone,
        whisperSegments: ytWhisperSegments.slice(0, 2500),
        whisperDurationSec: ytWhisperDurationSec || 0,
        whisperTimeline: ytWhisperTimeline || ytTranscriptSrt || undefined
      });
      if (error && (!data || data.ok === undefined)) {
        setMessage("ytMessage", formatMediaPipelineErrorMessage(error.message) || "台本生成に失敗しました。", "err");
        return;
      }
      if (data && data.ok === false) {
        setMessage("ytMessage", formatMediaPipelineErrorMessage(data.error) || "台本生成に失敗しました。", "err");
        return;
      }
      if (!data?.ok) {
        setMessage("ytMessage", "想定外の応答です。media-pipeline の script モードを確認してください。", "err");
        return;
      }

      scriptField.value = formatPipelineScriptForField(data, count, castCheck.slots);
      await applyTimecodedScriptToYtField();
      try{const rr=JSON.parse(localStorage.getItem("wavrick_youtube_requests")||"[]");const m=rr.find(r=>r.videoUrl===videoUrl);if(m){m.script=scriptField.value;if(Array.isArray(ytWhisperSegments)&&ytWhisperSegments.length){m.whisperSegments=ytWhisperSegments.slice(0,2500);m.whisperDurationSec=ytWhisperDurationSec||0}}else if(videoUrl){rr.push({requestId:`gen_${Date.now()}`,videoUrl,script:scriptField.value,name:"台本生成",createdAt:new Date().toISOString(),whisperSegments:Array.isArray(ytWhisperSegments)?ytWhisperSegments.slice(0,2500):null,whisperDurationSec:ytWhisperDurationSec||0})}localStorage.setItem("wavrick_youtube_requests",JSON.stringify(rr))}catch(e){}
      if (scriptPreview) scriptPreview.classList.remove("hidden");
      updateYtQuotePreview();
      _wavrickSavePipelineState();
      const ms = typeof data.durationMs === "number" ? Math.round(data.durationMs / 1000) : null;
      setMessage(
        "ytMessage",
        `話者別の台本を生成しました${ms != null ? `（約${ms}秒）` : ""}。見積もりを確認してから依頼を送信できます。`,
        "ok"
      );
    } catch (err) {
      setMessage("ytMessage", err instanceof Error ? err.message : String(err), "err");
    } finally {
      genBtn.disabled = false;
      genBtn.textContent = genLabel;
    }
  });
}

function bindMediaPipelineUi() {
  bindYtPipelineWizard();
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

  function refreshVerificationUi() {
    const verified = isCustomerLoggedIn() || (verifyState.email && verifyState.channel);
    if (submitButton) {
      submitButton.disabled = !verified;
      submitButton.textContent = verified ? "依頼を送信する" : "本人確認後に依頼を送信";
    }
    if (verifyBadge) {
      verifyBadge.textContent = verified ? "完了" : "未完了";
      verifyBadge.classList.toggle("done", verified);
    }
    refreshYtProvisionalPayButton();
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
      const session = getCurrentSession();
      if (session?.role === "customer" && session.email) return session.email;
      const el = document.getElementById("ytEmail");
      return el ? el.value.trim() : "";
    },
    markEmailDone: () => {
      if (verifyEmailBtn) markStepDone("email", verifyEmailBtn, "1) メール認証");
    }
  };

  if (verifyEmailBtn && isEmailVerifiedForForm(ytEmailVerificationBridge.getFormEmail())) {
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
      const idle = wavrickI18n("yt_channel_btn");
      const started = startYoutubeOAuthPopup({
        channelKey: key,
        linkAll: false,
        btn: verifyChannelBtn,
        idleLabel: idle,
        onResult: (d) => {
          verifyChannelBtn.disabled = false;
          verifyChannelBtn.textContent = idle;
          if (d.ok) {
            verifyState.verifiedChannelKey = key;
            verifyState.verifiedChannelId = d.channelId || "";
            markStepDone("channel", verifyChannelBtn, wavrickI18n("yt_channel_done"));
            let okMsg = wavrickI18n("yt_oauth_success");
            if (verifyState.verifiedChannelId) {
              okMsg +=
                wavrickI18n("yt_oauth_channel_id_prefix") +
                verifyState.verifiedChannelId +
                wavrickI18n("yt_oauth_channel_id_suffix");
            }
            setMessage("ytMessage", okMsg, "ok");
          } else {
            const extra = d.detail ? ` (${d.detail})` : "";
            const errText = d.code ? youtubeOAuthMessageFromCode(d.code) : wavrickI18n("yt_oauth_fail");
            setMessage("ytMessage", errText + extra, "err");
          }
        }
      });
      if (!started.ok) {
        verifyChannelBtn.disabled = false;
        verifyChannelBtn.textContent = idle;
        setMessage("ytMessage", started.message, "err");
      }
    });
  }

  refreshVerificationUi();

  const provisionalPayBtn = document.getElementById("ytProvisionalPayBtn");
  if (provisionalPayBtn) {
    provisionalPayBtn.addEventListener("click", async () => {
      setMessage("ytMessage", "");
      initSupabaseClient();
      const collected = collectYtRequestDataFromForm(form);
      if (!collected.ok) {
        setMessage("ytMessage", collected.message, "err");
        return;
      }
      const data = collected.data;
      if (ytFormNeedsValidVideoUrl() && !isYouTubeUrl(data.videoUrl)) {
        setMessage("ytMessage", "翻訳したい YouTube 動画 URL の形式を確認してください。", "err");
        return;
      }
      const script = document.getElementById("ytScript")?.value?.trim() || "";
      if (!script) {
        setMessage("ytMessage", "台本を生成してから決済してください。", "err");
        return;
      }
      const quote = buildQuoteForCurrentYtForm();
      if (!quote || quote.totalBillableSeconds <= 0) {
        setMessage("ytMessage", "見積もりが確定していません。台本のタイムコードを確認してください。", "err");
        return;
      }
      const Tx = getTransactionApi();
      if (!Tx) {
        setMessage("ytMessage", "取引モジュールを読み込めませんでした。", "err");
        return;
      }

      const speakerCount = getYtSpeakerCount();
      const castCheck = validateYtCastSlots(speakerCount);
      if (!castCheck.ok) {
        setMessage("ytMessage", castCheck.message, "err");
        return;
      }

      provisionalPayBtn.disabled = true;
      const prevLabel = provisionalPayBtn.textContent;
      provisionalPayBtn.textContent = "決済処理中…";

      data.speakerCount = speakerCount;
      data.castMode = "multi";
      data.castSlots = castCheck.slots;
      data.requestId = generateRequestId();
      data.status = REQUEST_STATUS_FLOW[0];
      data.script = script;
      const omakaseCriteria = collectOmakaseCriteriaFromForm();
      const castAcceptance = Tx.initCastAcceptanceFromSlots(castCheck.slots, {
        omakaseCriteria,
        allProfiles: loadVoiceProfilesForMatch()
      });
      syncRequestTalentIdsFromCastAcceptance(data, castAcceptance);

      const { password: _pw, ...ytDataForSave } = data;
      ytDataForSave.identityProofText = "顧客ログイン済み";
      ytDataForSave.quoteBreakdown = quote;
      ytDataForSave.billableSeconds = quote.totalBillableSeconds;
      ytDataForSave.quoteAmountUsd = quote.totalUsd;

      saveLocal("wavrick_youtube_requests", ytDataForSave);
      const workflows = getWorkflows();
      workflows[ytDataForSave.requestId] = {
        requestId: ytDataForSave.requestId,
        status: ytDataForSave.status,
        messages: [],
        quoteAmount: String(quote.totalUsd),
        quoteAmountUsd: quote.totalUsd,
        quoteBreakdown: quote,
        billableSeconds: quote.totalBillableSeconds,
        paymentStatus: "pending_checkout",
        stripeUrl: "",
        deliveries: [],
        revisionCount: 0,
        freeRetakesUsed: 0,
        retakePaymentStatus: "none",
        retakeFeeUsd: 0,
        transactionPhase: Tx.TRANSACTION_PHASE.quoted,
        castAcceptance,
        omakaseCriteria,
        provisionalPaidAt: null,
        stripePaymentIntentId: "",
        updatedAt: new Date().toISOString()
      };
      saveWorkflows(workflows);
      if (isSupabaseEnabled()) {
        await upsertRemote(
          TABLES.requestWorkflows,
          mapWorkflowToRemote(workflows[ytDataForSave.requestId]),
          "requestid"
        );
        await insertRemote(TABLES.youtubeRequests, mapYoutubeRequestToRemote(ytDataForSave));
      }
      upsertLocalByEmail("wavrick_customer_accounts", {
        role: "customer",
        email: ytDataForSave.email,
        name: ytDataForSave.name,
        channelUrl: ytDataForSave.channelUrl
      });

      if (isSupabaseEnabled() && supabaseClient) {
        try {
          const { data: stripeResult, error: stripeErr } = await supabaseClient.functions.invoke("stripe-checkout", {
            body: {
              requestId: ytDataForSave.requestId,
              amountUsd: quote.totalUsd,
              customerEmail: ytDataForSave.email,
              description: `${ytDataForSave.name} — YouTube 吹替`,
              paymentType: "initial"
            }
          });
          if (stripeErr || !stripeResult?.ok || !stripeResult?.url) {
            const errMsg = stripeResult?.error || stripeErr?.message || "Stripe Checkout の作成に失敗しました。";
            setMessage("ytMessage", errMsg, "err");
            provisionalPayBtn.disabled = false;
            provisionalPayBtn.textContent = prevLabel;
            return;
          }
          setWorkSelectedRequestId(ytDataForSave.requestId);
          window.location.href = stripeResult.url;
          return;
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e);
          setMessage("ytMessage", `Stripe 連携エラー: ${errMsg}`, "err");
          provisionalPayBtn.disabled = false;
          provisionalPayBtn.textContent = prevLabel;
          return;
        }
      }

      workflows[ytDataForSave.requestId].paymentStatus = "paid_provisional";
      workflows[ytDataForSave.requestId].transactionPhase = Tx.TRANSACTION_PHASE.awaiting_acceptance;
      workflows[ytDataForSave.requestId].provisionalPaidAt = new Date().toISOString();
      saveWorkflows(workflows);

      pushNotification(`決済完了・新規案件: ${ytDataForSave.name}`, ytDataForSave.requestId);
      for (const slot of castAcceptance) {
        if (slot.talentId) {
          pushNotification(`案件の回答依頼（話者${slot.speakerIndex}）`, ytDataForSave.requestId);
        }
      }

      provisionalPayBtn.disabled = false;
      provisionalPayBtn.textContent = prevLabel;
      setMessage(
        "ytMessage",
        "決済が完了しました。声優の受諾後に本取引が開始されます。案件管理ページで進捗を確認できます。",
        "ok"
      );
      setWorkSelectedRequestId(ytDataForSave.requestId);
      refreshYtProvisionalPayButton();
    });
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    setMessage("ytMessage", "");
    initSupabaseClient();
    const collected = collectYtRequestDataFromForm(form);
    if (!collected.ok) {
      setMessage("ytMessage", collected.message, "err");
      return;
    }
    const data = collected.data;
    if (ytFormNeedsValidVideoUrl() && !isYouTubeUrl(data.videoUrl)) {
      setMessage("ytMessage", "翻訳したい YouTube 動画 URL の形式を確認してください。", "err");
      return;
    }

    const speakerCount = getYtSpeakerCount();
    const castCheck = validateYtCastSlots(speakerCount);
    if (!castCheck.ok) {
      setMessage("ytMessage", castCheck.message, "err");
      return;
    }
    data.sourceMode = getYtSourceMode();
    data.speakerCount = speakerCount;
    data.castMode = "multi";
    data.castSlots = castCheck.slots;
    data.selectedTalentId = castCheck.slots
      .filter((s) => s.mode === "pick" && s.talentId)
      .map((s) => s.talentId)
      .join(",");
    data.selectedTalentName = castCheck.slots
      .map((s) =>
        `話者${s.speakerIndex}: ${s.mode === "omakase" ? "おまかせ" : s.displayName || s.talentId || "未選択"}`
      )
      .join(" / ");
    data.requestId = generateRequestId();
    data.status = REQUEST_STATUS_FLOW[0];

    const signupResult = { ok: true, skipped: true };

    const { password: _customerPassword, ...ytDataForSave } = data;
    ytDataForSave.identityProofText = "顧客ログイン済み";
    const quote = buildQuoteForCastAndScript(castCheck.slots, ytDataForSave.script || "");
    if (quote) {
      ytDataForSave.quoteBreakdown = quote;
      ytDataForSave.billableSeconds = quote.totalBillableSeconds;
      ytDataForSave.quoteAmountUsd = quote.totalUsd;
    }
    saveLocal("wavrick_youtube_requests", ytDataForSave);
    const workflows = getWorkflows();
    workflows[ytDataForSave.requestId] = {
      requestId: ytDataForSave.requestId,
      status: ytDataForSave.status,
      messages: [],
      quoteAmount: quote ? String(quote.totalUsd) : "",
      quoteAmountUsd: quote?.totalUsd ?? null,
      quoteBreakdown: quote,
      billableSeconds: quote?.totalBillableSeconds ?? 0,
      paymentStatus: "unpaid",
      stripeUrl: "",
      deliveries: [],
      revisionCount: 0,
      freeRetakesUsed: 0,
      retakePaymentStatus: "none",
      retakeFeeUsd: 0,
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

  const scInit = getYtSpeakerCount();
  saveYtCastSlots(loadYtCastSlots(scInit), scInit);

  // ===== Demo skip (no need to fill) =====
  const ytSkipBtn = document.getElementById("ytSkipButton");
  if (ytSkipBtn) {
    ytSkipBtn.addEventListener("click", () => {
      const demoVideoUrl = `https://www.youtube.com/watch?v=dQw4w9WgXcQ`;
      const ytVideoUrlEl = document.getElementById("ytVideoUrl");
      if (ytVideoUrlEl) ytVideoUrlEl.value = demoVideoUrl;
      setMessage("ytMessage", "デモ動画URLを入力しました。文字起こしから続けてください。", "ok");
    });
  }
}

function bindCustomerSignupForm() {
  const form = document.getElementById("customerSignupForm");
  if (!form || form.dataset.bound === "1") return;
  form.dataset.bound = "1";

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    setMessage("customerSignupMessage", "");
    initSupabaseClient();

    const data = Object.fromEntries(new FormData(form).entries());
    const name = String(data.name || "").trim();
    const email = String(data.email || "").toLowerCase().trim();
    const password = String(data.password || "");
    const passwordConfirm = String(data.passwordConfirm || "");

    if (!name) {
      setMessage("customerSignupMessage", "表示名を入力してください。", "err");
      return;
    }
    if (!email.includes("@")) {
      setMessage("customerSignupMessage", "メールアドレスの形式を確認してください。", "err");
      return;
    }
    if (password.length < 6) {
      setMessage("customerSignupMessage", "パスワードは6文字以上にしてください。", "err");
      return;
    }
    if (password !== passwordConfirm) {
      setMessage("customerSignupMessage", "パスワード（確認）が一致しません。", "err");
      return;
    }

    const submitBtn = form.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;

    if (isSupabaseEnabled()) {
      const signupResult = await signUpUserWithSupabase(email, password, "customer");
      if (!signupResult.ok && !signupResult.alreadyExists) {
        const detail = signupResult.error?.message ? ` (${signupResult.error.message})` : "";
        setMessage("customerSignupMessage", `アカウント作成に失敗しました。${detail}`, "err");
        if (submitBtn) submitBtn.disabled = false;
        return;
      }
      const signInResult = await signInUserWithSupabase(email, password);
      if (!signInResult.ok) {
        setMessage(
          "customerSignupMessage",
          "登録は完了しましたが、自動ログインに失敗しました。ログイン画面からメール・パスワードで入ってください。",
          "ok"
        );
      }
    }

    const account = { role: "customer", email, name, channelUrl: "" };
    upsertLocalByEmail("wavrick_customer_accounts", account);
    markVerifiedEmailInStorage(email);
    persistCustomerSession(account, email);

    if (isSupabaseEnabled()) {
      await insertRemote(TABLES.customerAccounts, mapCustomerAccountToRemote(account));
    }

    form.reset();
    if (submitBtn) submitBtn.disabled = false;
    setMessage("customerSignupMessage", "アカウントを作成しました。まずマイページで YouTube チャンネルを登録できます。", "ok");
    syncYtPageAuthUi();
    syncAccountPageUi();
    syncMainNav();
    showPage("account");
  });
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

async function getVisibleRequestsForCurrentSession() {
  const session = getCurrentSession();
  const rows = await getMergedYoutubeRequests();
  if (!session) return [];
  if (session.role === "admin") return rows;
  if (session.role === "customer") {
    return rows.filter((r) => (r.email || "").toLowerCase() === (session.email || "").toLowerCase());
  }
  if (session.role === "voice") {
    const talentId = resolveVoiceTalentIdForSession(session);
    return rows.filter((r) => requestAssignedToVoice(r, talentId));
  }
  return [];
}

function formatWorkRequestOptionLabel(request) {
  const id = request.requestId || "—";
  const customer = request.name || request.email || "顧客";
  const video = request.videoUrl || "";
  let videoShort = video;
  try {
    if (video) videoShort = new URL(video).hostname + new URL(video).pathname.slice(0, 24);
  } catch {
    videoShort = video.slice(0, 40);
  }
  return `${id} — ${customer} — ${videoShort || "動画未設定"}`;
}

function syncWorkRoleVisibility(session) {
  const role = session?.role || "guest";
  document.querySelectorAll(".work-role-voice").forEach((el) => {
    el.classList.toggle("hidden", role !== "voice");
  });
  document.querySelectorAll(".work-role-customer").forEach((el) => {
    el.classList.toggle("hidden", role !== "customer");
  });
  document.querySelectorAll(".work-role-admin").forEach((el) => {
    el.classList.toggle("hidden", role !== "admin");
  });
  const subtitle = document.getElementById("workPageSubtitle");
  if (subtitle) {
    if (role === "voice") {
      subtitle.textContent = "担当案件を選び、進捗確認・顧客連絡・収録・合成音声の提出を行います。";
    } else if (role === "customer") {
      subtitle.textContent =
        "依頼案件の進捗・キャスティング状況・チャット・修正依頼を管理します。決済後は声優の受諾を待ちます。";
    } else if (role === "admin") {
      subtitle.textContent = "全案件の進捗・チャット・見積/支払い・納品を管理します。";
    } else {
      subtitle.textContent = "ログイン後に案件を表示します。";
    }
  }
}

function renderWorkCaseHeader(request, session) {
  const host = document.getElementById("workCaseHeader");
  if (!host || !request) return;
  const wf = getWorkflowForRequest(request.requestId, request.status);
  const talentId = session?.role === "voice" ? resolveVoiceTalentIdForSession(session) : "";
  const wfSlots = wf.castAcceptance?.length ? wf.castAcceptance : getCastSlotsForRequest(request);
  const Tx = getTransactionApi();
  const slots = session?.role === "voice" ? getVoiceSpeakerSlotsForRequest(request, talentId) : [];
  let slotLabel = slots.length
    ? slots.map((s) => `話者${s.speakerIndex}`).join("・")
    : request.selectedTalentName || "担当";
  if (session?.role === "customer" && Tx && wfSlots.length) {
    slotLabel = wfSlots.map((s) => `話者${s.speakerIndex}: ${Tx.getCustomerSlotLabel(s, wfSlots)}`).join(" / ");
  }
  if (session?.role === "voice" && Tx && talentId && wfSlots.length) {
    const onHold = Tx.isTransactionOnHoldForVoice(wfSlots, talentId);
    if (onHold) slotLabel = "取引保留中";
  }
  const badges = [
    `<span class="work-case-badge is-active">${escapeHtml(wf.status || REQUEST_STATUS_FLOW[0])}</span>`,
    `<span class="work-case-badge">${escapeHtml(slotLabel)}</span>`
  ];
  if (request.deadline) badges.push(`<span class="work-case-badge">納期 ${escapeHtml(request.deadline)}</span>`);
  const P = getPricingApi();
  const quoteUsd = wf.quoteAmountUsd ?? request.quoteAmountUsd;
  const quoteLine =
    quoteUsd != null && P
      ? `<div><strong>見積（USD）:</strong> ${escapeHtml(P.formatUsd(quoteUsd))}${
          wf.billableSeconds ? ` / 課金枠 ${escapeHtml(P.formatBillableDuration(wf.billableSeconds))}` : ""
        }</div>`
      : wf.quoteAmount
        ? `<div><strong>見積:</strong> ${escapeHtml(wf.quoteAmount)}</div>`
        : "";
  host.innerHTML = `
    <p class="work-case-header-title">${escapeHtml(request.name || "依頼案件")}</p>
    <div class="work-case-header-meta">
      <div><strong>案件ID:</strong> ${escapeHtml(request.requestId || "—")}</div>
      <div><strong>顧客:</strong> ${escapeHtml(request.name || "—")}（${escapeHtml(request.email || "—")}）</div>
      <div><strong>動画:</strong> ${
        request.videoUrl
          ? `<a href="${escapeAttr(request.videoUrl)}" target="_blank" rel="noreferrer">${escapeHtml(request.videoUrl)}</a>`
          : "未設定"
      }</div>
      ${request.tone ? `<div><strong>トーン:</strong> ${escapeHtml(request.tone)}</div>` : ""}
      ${quoteLine}
    </div>
    <div class="work-case-badge-row">${badges.join("")}</div>
  `;
}

function syncWorkRetakeComposer(request, wf) {
  const lock = document.getElementById("workRetakePaymentLock");
  const addBtn = document.getElementById("addRevisionRequestBtn");
  const paidBtn = document.getElementById("markRetakePaidBtn");
  const P = getPricingApi();
  if (!lock || !P || !request) return;
  const slots = getWorkflowCastSlots(request, wf);
  const fee = P.computePaidRetakeFeeUsd(slots, resolveVoiceProfileByTalentId);
  const used = P.countRevisionSessions(wf.messages);
  const needsPay = used >= P.FREE_RETAKE_LIMIT && wf.retakePaymentStatus !== "paid";
  if (needsPay) {
    lock.classList.remove("hidden");
    lock.textContent = `無料修正は${P.FREE_RETAKE_LIMIT}回までです。次の1回は ${P.formatUsd(fee)} の決済が必要です（複数セリフの指示を1回にまとめてOK）。運営が決済記録後に送信できます。`;
    if (addBtn) addBtn.disabled = true;
    if (paidBtn) paidBtn.classList.toggle("hidden", false);
  } else {
    lock.classList.add("hidden");
    if (addBtn) addBtn.disabled = false;
    if (paidBtn) paidBtn.classList.add("hidden");
  }
}

function renderWorkStatusTimeline(status) {
  const wrap = document.getElementById("workStatusTimeline");
  if (!wrap) return;
  const activeIndex = REQUEST_STATUS_FLOW.indexOf(status);
  wrap.innerHTML = REQUEST_STATUS_FLOW
    .map((label, idx) => `<span class="status-pill ${idx <= activeIndex ? "done" : ""}">${escapeHtml(label)}</span>`)
    .join("");
}

function renderDeliveryItemHtml(d) {
  if (d.kind === "audio_mix" && d.audioDataUrl) {
    return `<div class="delivery-item">
      <span class="delivery-item-kind">合成音声</span>
      ${formatDateTime(d.createdAt)} — ${escapeHtml(d.fileName || "mix.wav")}
      ${d.note ? ` / ${escapeHtml(d.note)}` : ""}
      <audio controls preload="metadata" src="${escapeAttr(d.audioDataUrl)}"></audio>
    </div>`;
  }
  if (d.kind === "audio_mix" && d.url) {
    return `<div class="delivery-item">
      <span class="delivery-item-kind">合成音声</span>
      ${formatDateTime(d.createdAt)} — <a href="${escapeAttr(d.url)}" target="_blank" rel="noreferrer">${escapeHtml(d.fileName || d.url)}</a>
      ${d.note ? ` / ${escapeHtml(d.note)}` : ""}
    </div>`;
  }
  return `<div class="delivery-item">${formatDateTime(d.createdAt)} / <a href="${escapeAttr(d.url)}" target="_blank" rel="noreferrer">${escapeHtml(d.url)}</a> / ${escapeHtml(d.note)}</div>`;
}

function renderWorkDetails(request, session) {
  const wf = getWorkflowForRequest(request.requestId, request.status);

  const statusSelect = document.getElementById("workStatusSelect");
  if (statusSelect) statusSelect.value = wf.status || REQUEST_STATUS_FLOW[0];
  renderWorkStatusTimeline(wf.status || REQUEST_STATUS_FLOW[0]);
  renderWorkCaseHeader(request, session);

  const chatMessages = (wf.messages || []).filter((m) => m.kind !== "revision");
  const revisionMessages = (wf.messages || []).filter((m) => m.kind === "revision");

  const chatList = document.getElementById("workChatList");
  if (chatList) {
    chatList.innerHTML = chatMessages.length
      ? chatMessages
          .map(
            (m) =>
              `<div class="chat-item"><strong>${escapeHtml(m.sender)}</strong> (${formatDateTime(m.createdAt)}): ${escapeHtml(m.text)}</div>`
          )
          .join("")
      : `<div class="chat-item">まだメッセージはありません。</div>`;
  }

  const revisionList = document.getElementById("workRevisionList");
  if (revisionList) {
    revisionList.innerHTML = revisionMessages.length
      ? revisionMessages
          .map(
            (m) =>
              `<div class="revision-item"><strong>${escapeHtml(m.sender)}</strong> (${formatDateTime(m.createdAt)}): ${escapeHtml(m.text)}</div>`
          )
          .join("")
      : `<div class="revision-item">修正依頼はまだありません。</div>`;
  }

  const deliveriesList = document.getElementById("workDeliveriesList");
  if (deliveriesList) {
    const rows = wf.deliveries || [];
    deliveriesList.innerHTML = rows.length
      ? rows.map((d) => renderDeliveryItemHtml(d)).join("")
      : `<div class="delivery-item">納品物はまだありません。</div>`;
  }

  const revision = document.getElementById("workRevisionCount");
  if (revision) {
    const P = getPricingApi();
    const freeMax = P ? P.FREE_RETAKE_LIMIT : 3;
    const used = revisionMessages.length;
    const freeLeft = Math.max(0, freeMax - used);
    revision.textContent = `修正依頼: ${used} 件 / 無料枠 残り ${freeLeft} 回（${freeMax}回まで無料）`;
  }
  syncWorkRetakeComposer(request, wf);
  renderWorkTransactionPanel(request, session, wf);
  renderWorkVoiceOfferCard(request, session, wf);
}

function attachBlobToDeliveryFileInput(blob, fileName) {
  const fileInput = document.getElementById("workDeliveryAudioFile");
  if (!fileInput || !blob) return false;
  try {
    const dt = new DataTransfer();
    const file =
      blob instanceof File
        ? blob
        : new File([blob], fileName || "mix.wav", { type: blob.type || "audio/wav" });
    dt.items.add(file);
    fileInput.files = dt.files;
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  } catch {
    return false;
  }
}

function updateWorkDeliveryFileReadyLabel(fileName) {
  const label = document.getElementById("workDeliveryFileReady");
  if (!label) return;
  if (fileName) {
    label.textContent = `セット済み: ${fileName}`;
    label.classList.remove("hidden");
  } else {
    label.textContent = "";
    label.classList.add("hidden");
  }
}

async function applyPendingMixToDeliveryInput(requestId) {
  if (!requestId || !globalThis.WavrickDeliveryHandoff) return false;
  try {
    const pending = await globalThis.WavrickDeliveryHandoff.get();
    if (!pending?.blob || pending.requestId !== requestId) {
      updateWorkDeliveryFileReadyLabel("");
      return false;
    }
    const fileName = pending.fileName || `wavrick-${requestId}.wav`;
    const ok = attachBlobToDeliveryFileInput(pending.blob, fileName);
    if (ok) {
      updateWorkDeliveryFileReadyLabel(fileName);
      const hint = document.getElementById("workPendingDeliveryHint");
      if (hint) {
        hint.classList.remove("hidden");
        hint.textContent =
          "収録ブースの合成音声を提出欄にセットしました。提出メモを書いて「合成トラックを顧客に提出」を押してください。";
      }
    }
    return ok;
  } catch {
    return false;
  }
}

async function refreshWorkPendingDeliveryHint(requestId) {
  const hint = document.getElementById("workPendingDeliveryHint");
  const fileInput = document.getElementById("workDeliveryAudioFile");
  const hasFile = Boolean(fileInput?.files?.length);
  if (!hint || !globalThis.WavrickDeliveryHandoff) {
    if (!hasFile) updateWorkDeliveryFileReadyLabel("");
    return;
  }
  try {
    const pending = await globalThis.WavrickDeliveryHandoff.get();
    const show = pending && pending.requestId === requestId && pending.blob;
    if (show && hasFile) {
      hint.classList.add("hidden");
      return;
    }
    if (show) {
      await applyPendingMixToDeliveryInput(requestId);
      return;
    }
    hint.classList.add("hidden");
    if (!hasFile) updateWorkDeliveryFileReadyLabel("");
  } catch {
    hint.classList.add("hidden");
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("読み込みに失敗しました"));
    reader.readAsDataURL(blob);
  });
}

async function uploadDeliveryWavToStorage(requestId, blob, fileName) {
  if (!isSupabaseEnabled() || !supabaseClient) return null;
  const path = `deliveries/${encodeURIComponent(requestId)}/${Date.now()}_${fileName.replace(/[^\w.-]+/g, "_")}`;
  const { error } = await supabaseClient.storage.from(DELIVERY_STORAGE_BUCKET).upload(path, blob, {
    upsert: true,
    contentType: blob.type || "audio/wav"
  });
  if (error) throw new Error(error.message);
  const { data } = supabaseClient.storage.from(DELIVERY_STORAGE_BUCKET).getPublicUrl(path);
  return { storagePath: path, url: data?.publicUrl || "" };
}

async function buildAudioDeliveryEntry(blob, fileName, note, session, requestId) {
  const submittedBy = session?.displayName || session?.roleLabel || "声優";
  let url = "";
  let storagePath = "";
  let audioDataUrl = "";
  const maxEmbed = 4 * 1024 * 1024;
  try {
    const uploaded = await uploadDeliveryWavToStorage(requestId, blob, fileName);
    if (uploaded?.url) {
      url = uploaded.url;
      storagePath = uploaded.storagePath;
    }
  } catch {
    /* fall back to inline */
  }
  if (!url && blob.size <= maxEmbed) {
    audioDataUrl = await blobToDataUrl(blob);
  } else if (!url) {
    throw new Error("ファイルが大きすぎます。Supabase を設定するか、4MB 未満の WAV にしてください。");
  }
  return {
    kind: "audio_mix",
    url,
    storagePath,
    audioDataUrl,
    fileName,
    note,
    submittedBy,
    submitterEmail: (session?.email || "").toLowerCase().trim(),
    durationSec: null,
    createdAt: new Date().toISOString()
  };
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
  const addRevisionBtn = document.getElementById("addRevisionRequestBtn");
  const markReadBtn = document.getElementById("markAllNoticeReadBtn");
  const refreshBtn = document.getElementById("workRefreshCasesBtn");
  const casePanel = document.getElementById("workCasePanel");
  const caseEmpty = document.getElementById("workCaseEmpty");
  if (!requestSelect) return;

  if (statusSelect) {
    statusSelect.innerHTML = REQUEST_STATUS_FLOW.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join("");
  }

  let visibleRows = [];

  async function findCurrentRequest() {
    const rows = visibleRows.length ? visibleRows : await getVisibleRequestsForCurrentSession();
    return rows.find((r) => r.requestId === requestSelect.value) || null;
  }

  async function selectRequest(request, session) {
    if (!request) return;
    setWorkSelectedRequestId(request.requestId);
    requestSelect.value = request.requestId;
    renderWorkDetails(request, session);
    renderWorkNotifications(request.requestId);
    await refreshWorkPendingDeliveryHint(request.requestId);
    await applyPendingMixToDeliveryInput(request.requestId);
    casePanel?.classList.remove("hidden");
    caseEmpty?.classList.add("hidden");
  }

  async function refreshRequestOptions() {
    const session = getCurrentSession();
    syncWorkRoleVisibility(session);
    await hydrateRemoteWorkData();
    visibleRows = await getVisibleRequestsForCurrentSession();

    if (!session) {
      requestSelect.innerHTML = `<option value="">ログインしてください</option>`;
      casePanel?.classList.add("hidden");
      caseEmpty?.classList.remove("hidden");
      setMessage("workMessage", "案件管理を使うには、先にログインしてください。", "err");
      return;
    }

    if (!visibleRows.length) {
      requestSelect.innerHTML = `<option value="">案件がありません</option>`;
      casePanel?.classList.add("hidden");
      caseEmpty?.classList.remove("hidden");
      renderWorkNotifications("");
      return;
    }

    const preferredId = getWorkSelectedRequestId();
    requestSelect.innerHTML = visibleRows
      .map(
        (r) =>
          `<option value="${escapeAttr(r.requestId)}">${escapeHtml(formatWorkRequestOptionLabel(r))}</option>`
      )
      .join("");

    const selected =
      visibleRows.find((r) => r.requestId === preferredId) ||
      visibleRows.find((r) => r.requestId === requestSelect.value) ||
      visibleRows[0];
    await selectRequest(selected, session);
    setMessage("workMessage", `${visibleRows.length} 件の案件を表示中です。`, "ok");
  }

  async function updateWorkflow(mutator) {
    const session = getCurrentSession();
    const request = await findCurrentRequest();
    if (!request) {
      setMessage("workMessage", "対象案件がありません。", "err");
      return null;
    }
    const workflows = getWorkflows();
    const current = getWorkflowForRequest(request.requestId, request.status);
    const next = mutator({ ...current });
    next.updatedAt = new Date().toISOString();
    workflows[request.requestId] = next;
    saveWorkflows(workflows);
    if (isSupabaseEnabled()) {
      await upsertRemote(TABLES.requestWorkflows, mapWorkflowToRemote(next), "requestid");
    }
    renderWorkDetails(request, session);
    renderWorkNotifications(request.requestId);
    await refreshWorkPendingDeliveryHint(request.requestId);
    return request;
  }

  async function submitAudioDelivery(blob, fileName, note) {
    const session = getCurrentSession();
    const request = await findCurrentRequest();
    if (!request) {
      setMessage("workMessage", "対象案件がありません。", "err");
      return;
    }
    const entry = await buildAudioDeliveryEntry(blob, fileName, note, session, request.requestId);
    const req = await updateWorkflow((wf) => {
      wf.deliveries = [...(wf.deliveries || []), entry];
      if (session?.role === "voice" && REQUEST_STATUS_FLOW.indexOf(wf.status) < REQUEST_STATUS_FLOW.indexOf("納品")) {
        wf.status = "納品";
      }
      return wf;
    });
    if (!req) return;
    pushNotification("合成音声が顧客に提出されました", req.requestId);
    setMessage("workMessage", "合成トラックを顧客に提出しました。", "ok");
  }

  document.getElementById("workDeliveryAudioFile")?.addEventListener("change", () => {
    const file = document.getElementById("workDeliveryAudioFile")?.files?.[0];
    updateWorkDeliveryFileReadyLabel(file ? file.name : "");
  });

  document.getElementById("workOpenRecordWorkspaceBtn")?.addEventListener("click", (event) => {
    event.preventDefault();
    void openRecordWorkspaceFromWorkPage().catch((err) => {
      setMessage("workMessage", err instanceof Error ? err.message : String(err), "err");
    });
  });

  refreshBtn?.addEventListener("click", () => refreshRequestOptions());

  requestSelect.addEventListener("change", async () => {
    const session = getCurrentSession();
    const request = await findCurrentRequest();
    if (!request) return;
    await selectRequest(request, session);
  });

  saveStatusBtn?.addEventListener("click", async () => {
    const status = statusSelect?.value;
    const req = await updateWorkflow((wf) => {
      wf.status = status;
      return wf;
    });
    if (!req) return;
    pushNotification(`案件ステータスが「${status}」に更新されました`, req.requestId);
    setMessage("workMessage", "ステータスを更新しました。", "ok");
  });

  sendChatBtn?.addEventListener("click", async () => {
    const input = document.getElementById("workChatInput");
    const text = input ? input.value.trim() : "";
    if (!text) {
      setMessage("workMessage", "メッセージを入力してください。", "err");
      return;
    }
    const session = getCurrentSession();
    const req = await updateWorkflow((wf) => {
      const sender = session ? session.displayName || session.roleLabel || "ユーザー" : "ユーザー";
      wf.messages = [
        ...(wf.messages || []),
        { sender, text, createdAt: new Date().toISOString(), kind: "chat" }
      ];
      return wf;
    });
    if (!req) return;
    if (input) input.value = "";
    pushNotification("新しいメッセージが届きました", req.requestId);
    setMessage("workMessage", "メッセージを送信しました。", "ok");
  });

  addRevisionBtn?.addEventListener("click", async () => {
    const input = document.getElementById("workRevisionInput");
    const text = input ? input.value.trim() : "";
    if (!text) {
      setMessage("workMessage", "修正依頼の内容を入力してください。", "err");
      return;
    }
    const request = await findCurrentRequest();
    if (!request) return;
    const P = getPricingApi();
    const wf = getWorkflowForRequest(request.requestId, request.status);
    const slots = getCastSlotsForRequest(request);
    const fee = P ? P.computePaidRetakeFeeUsd(slots, resolveVoiceProfileByTalentId) : 0;
    const used = P ? P.countRevisionSessions(wf.messages) : 0;
    if (used >= (P?.FREE_RETAKE_LIMIT ?? 3) && wf.retakePaymentStatus !== "paid") {
      setMessage(
        "workMessage",
        `無料修正は${P?.FREE_RETAKE_LIMIT ?? 3}回までです。追加リテイク ${P ? P.formatUsd(fee) : ""} の決済記録後に送信してください。`,
        "err"
      );
      syncWorkRetakeComposer(request, wf);
      return;
    }
    const session = getCurrentSession();
    const sender =
      session?.role === "customer"
        ? session.displayName || "顧客"
        : session?.role === "admin"
          ? "運営"
          : session?.displayName || "ユーザー";
    const req = await updateWorkflow((wf) => {
      wf.revisionCount = Number(wf.revisionCount || 0) + 1;
      wf.freeRetakesUsed = used + 1;
      if (used >= (P?.FREE_RETAKE_LIMIT ?? 3)) {
        wf.retakePaymentStatus = "none";
      }
      wf.messages = [
        ...(wf.messages || []),
        { sender, text, createdAt: new Date().toISOString(), kind: "revision" }
      ];
      return wf;
    });
    if (!req) return;
    if (input) input.value = "";
    pushNotification("修正依頼が届きました", req.requestId);
    setMessage("workMessage", "修正依頼を送信しました。", "ok");
  });

  document.getElementById("markRetakePaidBtn")?.addEventListener("click", async () => {
    const request = await findCurrentRequest();
    if (!request) return;
    const wf = getWorkflowForRequest(request.requestId, request.status);
    const P = getPricingApi();
    const slots = getCastSlotsForRequest(request);
    const fee = P ? P.computePaidRetakeFeeUsd(slots, resolveVoiceProfileByTalentId) : 0;

    if (isSupabaseEnabled() && supabaseClient && fee > 0) {
      try {
        const session = getCurrentSession();
        const { data: stripeResult, error: stripeErr } = await supabaseClient.functions.invoke("stripe-checkout", {
          body: {
            requestId: request.requestId,
            amountUsd: fee,
            customerEmail: session?.email || request.email,
            description: `リテイク料金 — ${request.name || request.requestId}`,
            paymentType: "retake"
          }
        });
        if (stripeErr || !stripeResult?.ok || !stripeResult?.url) {
          setMessage("workMessage", stripeResult?.error || "Stripe Checkout の作成に失敗しました。", "err");
          return;
        }
        window.location.href = stripeResult.url;
        return;
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        setMessage("workMessage", `Stripe 連携エラー: ${errMsg}`, "err");
        return;
      }
    }

    const req = await updateWorkflow((wf2) => {
      wf2.retakePaymentStatus = "paid";
      return wf2;
    });
    if (!req) return;
    setMessage("workMessage", "リテイク料金の支払いを記録しました。修正依頼を送信できます。", "ok");
  });

  document.getElementById("submitWorkAudioDeliveryBtn")?.addEventListener("click", async () => {
    const fileInput = document.getElementById("workDeliveryAudioFile");
    const note = document.getElementById("workDeliveryNote")?.value?.trim() || "";
    const file = fileInput?.files?.[0];
    let blob = file || null;
    let fileName = file?.name || "delivery.wav";

    if (!blob && globalThis.WavrickDeliveryHandoff) {
      try {
        const pending = await globalThis.WavrickDeliveryHandoff.get();
        const request = await findCurrentRequest();
        if (pending?.blob && request && pending.requestId === request.requestId) {
          blob = pending.blob;
          fileName = pending.fileName || "mix.wav";
        }
      } catch {
        /* ignore */
      }
    }

    if (!blob) {
      setMessage(
        "workMessage",
        "提出する WAV を選択するか、収録ブースで「案件として提出」を実行してください。",
        "err"
      );
      return;
    }
    try {
      await submitAudioDelivery(blob, fileName, note);
      if (fileInput) fileInput.value = "";
      updateWorkDeliveryFileReadyLabel("");
      if (globalThis.WavrickDeliveryHandoff) await globalThis.WavrickDeliveryHandoff.clear();
      const request = await findCurrentRequest();
      if (request) await refreshWorkPendingDeliveryHint(request.requestId);
    } catch (err) {
      setMessage("workMessage", err instanceof Error ? err.message : String(err), "err");
    }
  });

  document.getElementById("workVoiceAcceptBtn")?.addEventListener("click", async () => {
    const session = getCurrentSession();
    const talentId = resolveVoiceTalentIdForSession(session);
    const Tx = getTransactionApi();
    if (!Tx || !talentId) return;
    const req = await updateWorkflow((wf) => {
      wf.castAcceptance = Tx.applyVoiceAccept(wf.castAcceptance || [], talentId);
      return maybeAdvanceTransactionPhase(wf);
    });
    if (!req) return;
    pushNotification("声優が案件を受諾しました", req.requestId);
    setMessage("workMessage", "案件を受諾しました。", "ok");
  });

  document.getElementById("workVoiceDeclineBtn")?.addEventListener("click", async () => {
    const session = getCurrentSession();
    const talentId = resolveVoiceTalentIdForSession(session);
    const Tx = getTransactionApi();
    if (!Tx || !talentId) return;
    const request = await findCurrentRequest();
    if (!request) return;
    const wfBefore = getWorkflowForRequest(request.requestId, request.status);
    const result = Tx.applyVoiceDecline(wfBefore.castAcceptance || [], talentId, {
      omakaseCriteria: wfBefore.omakaseCriteria,
      allProfiles: loadVoiceProfilesForMatch()
    });
    const req = await updateWorkflow((wf) => {
      wf.castAcceptance = result.slots;
      return maybeAdvanceTransactionPhase(wf);
    });
    if (!req) return;
    const rows = JSON.parse(localStorage.getItem("wavrick_youtube_requests") || "[]");
    const reqIdx = rows.findIndex((r) => r.requestId === req.requestId);
    if (reqIdx >= 0) {
      syncRequestTalentIdsFromCastAcceptance(rows[reqIdx], result.slots);
      localStorage.setItem("wavrick_youtube_requests", JSON.stringify(rows));
    }
    if (result.rematchedOmakase) {
      pushNotification("お任せ枠を別の声優に再マッチしました（顧客には非表示）", req.requestId);
      setMessage("workMessage", "辞退を記録しました。お任せ枠は自動で別候補に再割り当てされます。", "ok");
    } else if (result.needsCustomerRecast) {
      pushNotification("声優が辞退しました。顧客が再選定できます", req.requestId);
      setMessage("workMessage", "辞退を記録しました。顧客が別の声優を選び直せます。", "ok");
    } else {
      setMessage("workMessage", "辞退を記録しました。", "ok");
    }
  });

  document.getElementById("workCancelTransactionBtn")?.addEventListener("click", async () => {
    const Tx = getTransactionApi();
    if (!Tx) return;
    if (!window.confirm("取引をキャンセルしますか？この操作は取り消せません（デモ）。")) return;
    const req = await updateWorkflow((wf) => {
      wf.transactionPhase = Tx.TRANSACTION_PHASE.cancelled;
      wf.paymentStatus = "cancelled";
      return wf;
    });
    if (!req) return;
    pushNotification("取引がキャンセルされました", req.requestId);
    setMessage("workMessage", "取引をキャンセルしました。", "ok");
  });

  markReadBtn?.addEventListener("click", async () => {
    const req = await findCurrentRequest();
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
    const session = getCurrentSession();
    const loginAccountButton = document.getElementById("loginAccountButton");
    syncMainNav();
    if (!session) {
      sessionCard.classList.add("hidden");
      loginAccountButton?.classList.add("hidden");
      return;
    }
    sessionCard.classList.remove("hidden");
    sessionText.textContent = `${session.roleLabel}: ${session.displayName} でログイン中`;
    loginAccountButton?.classList.toggle(
      "hidden",
      session.role !== "customer" && session.role !== "admin"
    );
    if (session.role === "voice") jumpButton.textContent = "案件管理へ";
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

      if (!isSupabaseEnabled()) {
        setLoginMessage("運営ログインにはSupabase接続が必要です。", "err");
        return;
      }
      const supabaseAdminResult = await signInAdminWithSupabase(email, password);
      if (supabaseAdminResult.ok) {
        account = supabaseAdminResult.account;
      } else {
        setLoginMessage("運営メールまたはパスワードが違います。", "err");
        return;
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
    const sessionPayload = {
      role,
      roleLabel,
      email,
      displayName,
      createdAt: new Date().toISOString()
    };
    if (role === "voice") {
      sessionPayload.talentId = resolveVoiceTalentIdForSession({ role: "voice", email });
    }
    localStorage.setItem("wavrick_session", JSON.stringify(sessionPayload));
    setLoginMessage("ログインしました。", "ok");
    renderSession();
    syncYtPageAuthUi();
    syncAccountPageUi();
    syncMainNav();
  });

  jumpButton.addEventListener("click", () => {
    const session = JSON.parse(localStorage.getItem("wavrick_session") || "null");
    if (!session) return;
    if (session.role === "voice") showPage("work");
    else if (session.role === "admin") showPage("admin");
    else showPage("yt");
  });

  logoutButton.addEventListener("click", () => {
    performWavrickLogout({ loginMessage: "ログアウトしました。" });
    renderSession();
  });

  window.addEventListener("wavrick-logout", () => {
    renderSession();
  });

  renderSession();
  updateRoleUi();
  roleSelect.addEventListener("change", updateRoleUi);
}

async function init() {
  window.scrollTo({ top: 0, behavior: "instant" });
  if ("scrollRestoration" in history) history.scrollRestoration = "manual";
  initSupabaseClient();
  initYoutubeOAuthBridge();
  syncMainNav();
  bindNavigation();
  bindVoiceForm();
  bindMediaPipelineUi();
  bindCustomerSignupForm();
  bindAccountPage();
  bindYtSourceMode();
  bindYtForm();
  bindSupabaseAuthForYtEmail();
  if (new URLSearchParams(window.location.search).get("auth") === "yt_email") {
    showPage("yt");
  }
  const paymentStatus = new URLSearchParams(window.location.search).get("payment");
  const paymentRequestId = new URLSearchParams(window.location.search).get("requestId");
  if (paymentStatus && paymentRequestId) {
    window.history.replaceState({}, "", window.location.pathname);
    if (paymentStatus === "success") {
      await handleStripePaymentReturn(paymentRequestId);
    } else if (paymentStatus === "cancelled") {
      showPage("work");
      setWorkSelectedRequestId(paymentRequestId);
      setMessage("workMessage", "決済がキャンセルされました。案件管理から再度お試しください。", "err");
    }
  }
  const deepGo = sessionStorage.getItem("wavrick_go");
  if (deepGo) {
    sessionStorage.removeItem("wavrick_go");
    showPage(deepGo);
  }
  await syncYtEmailVerificationFromSupabaseSession();
  bindWorkPage();
  bindAdminDashboard();
  bindSupabaseConfig();
  bindLogin();
  bindTalentPageInteractions();
  bindTalentProfileModal();
  bindTalentSliderClicks();
  seedMockWorkflowStats();
  renderTalents();
  if (isSupabaseEnabled()) {
    await refreshRemoteVoiceProfiles();
    await hydrateRemoteWorkData();
  }

  _wavrickBindFormAutosave();
  _wavrickRestoreFormState();
  _wavrickRestorePipelineState();

  const hashPage = (window.location.hash || "").replace(/^#/, "");
  if (hashPage && pageMap[hashPage]) {
    showPage(hashPage);
  } else {
    const lastPage = sessionStorage.getItem("wavrick_active_page");
    if (lastPage && pageMap[lastPage]) {
      _suppressHistoryPush = true;
      showPage(lastPage, { skipHistory: true });
      _suppressHistoryPush = false;
    }
  }

  if (!history.state || !history.state.wavrickPage) {
    const activePage = (window.location.hash || "").replace(/^#/, "") || sessionStorage.getItem("wavrick_active_page") || "home";
    if (pageMap[activePage]) {
      history.replaceState({ wavrickPage: activePage }, "", "#" + activePage);
    }
  }
}

init();