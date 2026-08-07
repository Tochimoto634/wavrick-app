/**
 * 上部ナビのお知らせ（📢）— 未読バッジ・90%モーダル・詳細画面
 */
(function initWavrickAnnouncements(global) {
  const READ_IDS_KEY = "wavrick_announcements_read_ids";
  const PENDING_DOT_IDS_KEY = "wavrick_announcements_pending_dots";

  let panelOpen = false;
  let detailOpen = false;
  let detailNotificationId = "";
  let openGeneration = 0;
  let requestIdCache = null;
  let requestIdCacheAt = 0;
  let suppressHistoryPop = false;
  let historyDepth = 0;

  /** @type {Map<string, object>} */
  const notificationCache = new Map();

  const CATEGORY_TITLE_FALLBACK = {
    ja: {
      maintenance: "メンテナンス予定のお知らせ",
      important: "重要",
      case: "案件関係",
      system: "システム変更のお知らせ",
      other: "その他"
    },
    en: {
      maintenance: "Maintenance notice",
      important: "Important",
      case: "Project update",
      system: "System update notice",
      other: "Other"
    },
    ko: {
      maintenance: "점검 예정 알림",
      important: "중요",
      case: "프로젝트 관련",
      system: "시스템 변경 알림",
      other: "기타"
    },
    zh: {
      maintenance: "维护计划通知",
      important: "重要",
      case: "项目相关",
      system: "系统变更通知",
      other: "其他"
    },
    es: {
      maintenance: "Aviso de mantenimiento",
      important: "Importante",
      case: "Relacionado con el proyecto",
      system: "Aviso de cambio del sistema",
      other: "Otro"
    }
  };

  function getAnnouncementLocale() {
    if (global.WavrickI18n?.getLocale) return global.WavrickI18n.getLocale();
    try {
      const stored = localStorage.getItem("wavrick_locale");
      if (stored) return stored;
    } catch {
      /* ignore */
    }
    return global.WAVRICK_INITIAL_LOCALE || "ja";
  }

  function normalizeAnnouncementLocale(code) {
    const c = String(code || "").toLowerCase().trim();
    if (c === "ja" || c === "en" || c === "ko" || c === "zh" || c === "es") return c;
    if (c.startsWith("zh")) return "zh";
    if (c.startsWith("en")) return "en";
    if (c.startsWith("ko")) return "ko";
    if (c.startsWith("es")) return "es";
    if (c.startsWith("ja")) return "ja";
    return "ja";
  }

  function looksLikeI18nKey(value) {
    return typeof value === "string" && /^[a-z][\w-]*(\.[\w-]+)+$/.test(value);
  }

  function t(key, vars) {
    if (global.WavrickI18n) {
      const translated = global.WavrickI18n.t(key, vars);
      if (translated && translated !== key && !looksLikeI18nKey(translated)) return translated;
    }
    if (typeof global.t === "function") {
      const translated = global.t(key, vars);
      if (translated && translated !== key && !looksLikeI18nKey(translated)) return translated;
    }
    return key;
  }

  function announcementCategoryTitle(cat) {
    const normalized = String(cat || "other").toLowerCase().trim();
    const safe =
      normalized === "maintenance" ||
      normalized === "important" ||
      normalized === "case" ||
      normalized === "system" ||
      normalized === "other"
        ? normalized
        : "other";
    const locale = normalizeAnnouncementLocale(getAnnouncementLocale());
    const table = CATEGORY_TITLE_FALLBACK[locale] || CATEGORY_TITLE_FALLBACK.ja;

    const titleKey = `announcements.category_title.${safe}`;
    const titleTranslated = t(titleKey);
    if (titleTranslated && titleTranslated !== titleKey) return titleTranslated;

    const shortKey = `announcements.category.${safe}`;
    const shortTranslated = t(shortKey);
    if (shortTranslated && shortTranslated !== shortKey) return shortTranslated;

    return table[safe] || table.other;
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function formatMessageHtml(text) {
    const raw = String(text || "");
    const urlPattern = /(https?:\/\/[^\s<>"']+)/g;
    let result = "";
    let lastIndex = 0;
    let match;
    while ((match = urlPattern.exec(raw)) !== null) {
      result += escapeHtml(raw.slice(lastIndex, match.index));
      const url = match[1];
      result += `<a href="${escapeHtml(url)}" class="nav-announce-link" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`;
      lastIndex = match.index + url.length;
    }
    result += escapeHtml(raw.slice(lastIndex));
    return result;
  }

  function formatDateTime(iso) {
    if (typeof global.formatDateTime === "function") return global.formatDateTime(iso);
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleString();
  }

  function getSession() {
    if (typeof global.getCurrentSession === "function") return global.getCurrentSession();
    try {
      return JSON.parse(localStorage.getItem("wavrick_session") || "null");
    } catch {
      return null;
    }
  }

  function getNotifications() {
    if (typeof global.getNotifications === "function") return global.getNotifications();
    const session = getSession();
    const email = String(session?.email || "")
      .toLowerCase()
      .trim();
    const key = email ? `wavrick_notifications:v1:${email}` : "wavrick_notifications";
    try {
      return JSON.parse(localStorage.getItem(key) || "[]");
    } catch {
      return [];
    }
  }

  function normalizeEmails(list) {
    if (typeof global.normalizeNotificationEmails === "function") {
      return global.normalizeNotificationEmails(list);
    }
    if (!Array.isArray(list)) return [];
    return [
      ...new Set(list.map((e) => String(e || "").toLowerCase().trim()).filter(Boolean))
    ];
  }

  function getCategory(n) {
    if (isAccountSuspendedNotification(n)) return "important";
    const cat = String(n?.category || "").toLowerCase().trim();
    if (cat === "maintenance" || cat === "important" || cat === "case" || cat === "system" || cat === "other") {
      return cat;
    }
    if (n?.adminSent) return "other";
    return "other";
  }

  function getReadMap(email) {
    const normalized = (email || "").toLowerCase().trim();
    if (!normalized) return {};
    try {
      const map = JSON.parse(localStorage.getItem(READ_IDS_KEY) || "{}");
      const entry = map[normalized];
      return entry && typeof entry === "object" ? entry : {};
    } catch {
      return {};
    }
  }

  function setReadMap(email, readMap) {
    const normalized = (email || "").toLowerCase().trim();
    if (!normalized) return;
    try {
      const map = JSON.parse(localStorage.getItem(READ_IDS_KEY) || "{}");
      const ids = Object.keys(readMap || {});
      const trimmed = {};
      for (const id of ids.slice(-500)) trimmed[id] = true;
      map[normalized] = trimmed;
      localStorage.setItem(READ_IDS_KEY, JSON.stringify(map));
    } catch {
      /* ignore */
    }
  }

  function getPendingDotMap(email) {
    const normalized = (email || "").toLowerCase().trim();
    if (!normalized) return {};
    try {
      const map = JSON.parse(localStorage.getItem(PENDING_DOT_IDS_KEY) || "{}");
      const entry = map[normalized];
      return entry && typeof entry === "object" ? entry : {};
    } catch {
      return {};
    }
  }

  function setPendingDotMap(email, dotMap) {
    const normalized = (email || "").toLowerCase().trim();
    if (!normalized) return;
    try {
      const map = JSON.parse(localStorage.getItem(PENDING_DOT_IDS_KEY) || "{}");
      const ids = Object.keys(dotMap || {});
      const trimmed = {};
      for (const id of ids.slice(-500)) trimmed[id] = true;
      map[normalized] = trimmed;
      localStorage.setItem(PENDING_DOT_IDS_KEY, JSON.stringify(map));
    } catch {
      /* ignore */
    }
  }

  function addPendingDots(email, ids) {
    if (!ids?.length) return;
    const dotMap = getPendingDotMap(email);
    let changed = false;
    for (const rawId of ids) {
      const id = String(rawId || "").trim();
      if (!id || dotMap[id]) continue;
      dotMap[id] = true;
      changed = true;
    }
    if (changed) setPendingDotMap(email, dotMap);
  }

  /** 一覧を開いたタイミングでドット対象を差し替え（前回のドットは消える） */
  function replacePendingDots(email, ids) {
    const dotMap = {};
    for (const rawId of ids || []) {
      const id = String(rawId || "").trim();
      if (id) dotMap[id] = true;
    }
    setPendingDotMap(email, dotMap);
  }

  function removePendingDot(email, notificationId) {
    const id = String(notificationId || "").trim();
    if (!id) return;
    const dotMap = getPendingDotMap(email);
    if (!dotMap[id]) return;
    delete dotMap[id];
    setPendingDotMap(email, dotMap);
  }

  function clearPendingDots(email) {
    const normalized = (email || "").toLowerCase().trim();
    if (!normalized) return;
    setPendingDotMap(normalized, {});
  }

  function syncPendingDotsWhilePanelOpen(rows, email) {
    if (!panelOpen && !isPanelDomOpen()) return;
    const unreadIds = rows.filter((n) => isUnread(n, email)).map((n) => n.id).filter(Boolean);
    if (!unreadIds.length) return;
    // パネル表示中に届いた新着もドットを付けたうえで既読化する
    addPendingDots(email, unreadIds);
    markIdsRead(email, unreadIds);
  }

  function markNotificationRead(email, notificationId) {
    const id = String(notificationId || "").trim();
    if (!email || !id) return;
    const readMap = getReadMap(email);
    if (readMap[id]) return;
    readMap[id] = true;
    setReadMap(email, readMap);
    if (typeof global.wavrickPersistNotificationRead === "function") {
      void global.wavrickPersistNotificationRead(email, id);
    }
  }

  async function persistReadIds(email, toPersist) {
    if (!toPersist?.length) return;
    let persisted = true;
    if (typeof global.wavrickPersistNotificationReadBatch === "function") {
      persisted = await global.wavrickPersistNotificationReadBatch(email, toPersist);
    } else {
      for (const id of toPersist) {
        if (typeof global.wavrickPersistNotificationRead === "function") {
          const ok = await global.wavrickPersistNotificationRead(email, id);
          if (!ok) persisted = false;
        }
      }
    }
    if (!persisted && typeof global.wavrickEnqueueNotificationReadSync === "function") {
      global.wavrickEnqueueNotificationReadSync(email, toPersist);
    }
    if (typeof global.wavrickReconcileNotificationReadState === "function") {
      void global.wavrickReconcileNotificationReadState(true);
    }
  }

  /** 既読マップに追記のみ（未読へ戻すことはない）。ドットには触れない */
  function markIdsRead(email, ids) {
    if (!email || !ids?.length) return;
    const readMap = getReadMap(email);
    const toPersist = [];
    for (const rawId of ids) {
      const id = String(rawId || "").trim();
      if (!id || readMap[id]) continue;
      readMap[id] = true;
      toPersist.push(id);
    }
    if (!toPersist.length) return;
    setReadMap(email, readMap);
    void persistReadIds(email, toPersist);
  }

  async function markAllVisibleRead(email, rows) {
    if (!email || !rows?.length) return;
    const readMap = getReadMap(email);
    const toPersist = [];
    const newlyUnreadIds = [];

    for (const n of rows) {
      const id = String(n?.id || "").trim();
      if (!id) continue;
      if (!readMap[id]) {
        newlyUnreadIds.push(id);
        readMap[id] = true;
        toPersist.push(id);
      }
    }

    replacePendingDots(email, newlyUnreadIds);
    if (toPersist.length) {
      setReadMap(email, readMap);
      await persistReadIds(email, toPersist);
    }

    const session = getSession();
    if (session && typeof global.enforceNotificationRetentionForSession === "function") {
      void global.enforceNotificationRetentionForSession(session, requestIdCache);
    }
  }

  async function getRelevantRequestIds(session) {
    if (!session) return new Set();
    const isAdmin =
      session.role === "admin" ||
      (typeof global.sessionHasRole === "function" && global.sessionHasRole(session, "admin"));
    if (isAdmin) return null;
    const now = Date.now();
    const bootstrapDone =
      typeof global.wavrickIsCloudBootstrapDone === "function" && global.wavrickIsCloudBootstrapDone();

    if (requestIdCache && now - requestIdCacheAt < 15000) {
      if (bootstrapDone || requestIdCache.size > 0) return requestIdCache;
      requestIdCache = null;
    }

    if (!bootstrapDone && typeof global.wavrickGetLocalVisibleRequestIds === "function") {
      const localIds = global.wavrickGetLocalVisibleRequestIds(session);
      if (localIds instanceof Set && localIds.size > 0) {
        requestIdCache = localIds;
        requestIdCacheAt = now;
        return requestIdCache;
      }
    }

    if (typeof global.getVisibleRequestsForCurrentSession !== "function") {
      requestIdCache = new Set();
      requestIdCacheAt = now;
      return requestIdCache;
    }
    const rows = await global.getVisibleRequestsForCurrentSession();
    requestIdCache = new Set(rows.map((r) => r.requestId).filter(Boolean));
    requestIdCacheAt = now;
    return requestIdCache;
  }

  function matchesTargetRole(n, session) {
    const target = n.targetRole || n.target_role || "all";
    if (target === "all") return true;
    if (typeof global.sessionHasRole === "function") {
      return global.sessionHasRole(session, target);
    }
    const roles = Array.isArray(session?.roles) ? session.roles : [];
    if (roles.includes(target)) return true;
    return (session?.role || "") === target;
  }

  function isAfterAccountSince(n, session) {
    if (typeof global.isNotificationAfterAccountSince === "function") {
      return global.isNotificationAfterAccountSince(n, session);
    }
    if (!session || session.role === "admin") return true;
    const raw = session.accountCreatedAt || session.account_created_at || "";
    const since = Date.parse(String(raw || ""));
    if (!Number.isFinite(since)) return true;
    const created = Date.parse(n?.createdAt || n?.created_at || 0);
    if (!Number.isFinite(created)) return true;
    return created >= since - 2 * 60 * 1000;
  }

  function isAccountScopedNotification(rid) {
    return String(rid || "").toLowerCase().startsWith("acct:");
  }

  function isAccountSuspendedNotification(n) {
    return String(n?.text || "").startsWith("[account_suspended]");
  }

  function formatAnnouncementText(n) {
    const raw = String(n?.text || "");
    if (!isAccountSuspendedNotification(n)) return raw;
    const reason = raw.replace(/^\[account_suspended\]\s*/i, "").trim();
    if (reason) return t("account.restriction_notify_body", { reason });
    return t("account.restriction_notify_body_no_reason");
  }

  function previewChars(text, max = 24) {
    const chars = [...String(text || "").replace(/\s+/g, " ").trim()];
    if (chars.length <= max) return chars.join("");
    return `${chars.slice(0, max).join("")}…`;
  }

  function isHighlightNotification(n) {
    return isAccountSuspendedNotification(n) || getCategory(n) === "important";
  }

  function isNotificationRelevant(n, requestIds, session) {
    if (!session) return false;
    const me = String(session.email || "")
      .toLowerCase()
      .trim();
    if (typeof global.isNotificationPrunedForUser === "function" && global.isNotificationPrunedForUser(me, n.id)) {
      return false;
    }
    if (!isAfterAccountSince(n, session)) return false;
    const emails = normalizeEmails(n.targetEmails || n.target_emails);
    if (emails.length) {
      return emails.includes(me);
    }

    if (!matchesTargetRole(n, session)) return false;

    const rid = String(n.requestId || "").trim();
    if (!rid) return true;
    if (isAccountScopedNotification(rid)) {
      const targetEmail = rid.slice(5).toLowerCase().trim();
      return targetEmail === me;
    }
    if (session.role === "admin") return true;
    if (requestIds === null) return true;
    return requestIds.has(rid);
  }

  function isUnread(n, email) {
    const id = String(n?.id || "").trim();
    if (!id) return false;
    return !getReadMap(email)[id];
  }

  function hasPendingDot(n, email) {
    const id = String(n?.id || "").trim();
    if (!id) return false;
    return Boolean(getPendingDotMap(email)[id]);
  }

  function categoryTitle(n) {
    if (isAccountSuspendedNotification(n)) {
      const restricted = t("account.restriction_notify_title");
      if (restricted && restricted !== "account.restriction_notify_title") return restricted;
      return announcementCategoryTitle("important");
    }
    return announcementCategoryTitle(getCategory(n));
  }

  async function getVisibleAnnouncements() {
    const session = getSession();
    if (!session?.email) return [];
    const requestIds = await getRelevantRequestIds(session);
    const rows = getNotifications()
      .filter((n) => isNotificationRelevant(n, requestIds, session))
      .map((n) => {
        const emails = normalizeEmails(n.targetEmails || n.target_emails);
        const me = String(session.email || "")
          .toLowerCase()
          .trim();
        const safeEmails = emails.length ? emails.filter((e) => e === me) : [];
        const item = {
          ...n,
          targetEmails: safeEmails,
          unread: isUnread(n, session.email),
          pendingDot: hasPendingDot(n, session.email),
          category: getCategory(n),
          highlight: isHighlightNotification(n)
        };
        notificationCache.set(String(n.id), item);
        return item;
      });

    if (global.WavrickAccountRestriction?.isSessionSuspended?.(session)) {
      const hasSuspend = rows.some((n) => isAccountSuspendedNotification(n));
      if (!hasSuspend) {
        const localItem = {
          id: "ntf_local_account_suspended",
          text: String(session.suspendedReason || "").trim()
            ? `[account_suspended]\n${session.suspendedReason}`
            : "[account_suspended]",
          requestId: `acct:${String(session.email || "").toLowerCase().trim()}`,
          kind: "admin",
          adminSent: true,
          category: "important",
          targetEmails: [String(session.email || "").toLowerCase().trim()],
          createdAt: session.suspendedAt || new Date().toISOString(),
          unread: isUnread({ id: "ntf_local_account_suspended" }, session.email),
          pendingDot: hasPendingDot({ id: "ntf_local_account_suspended" }, session.email),
          highlight: true
        };
        notificationCache.set(localItem.id, localItem);
        rows.unshift(localItem);
      }
    }

    return rows.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  }

  /** バッジの数字 = 未読マーク（赤ドット）の数。未読 or ドット保持中を数える */
  function countBadgeRows(rows) {
    return rows.filter((n) => n.unread || n.pendingDot);
  }

  async function getUnreadCount() {
    const rows = await getVisibleAnnouncements();
    return countBadgeRows(rows).length;
  }

  function syncVisibility() {
    const wrap = document.getElementById("navAnnounceWrap");
    const session = getSession();
    wrap?.classList.toggle("hidden", !session?.email);
  }

  function isPanelDomOpen() {
    const panel = document.getElementById("navAnnouncePanel");
    return Boolean(panel?.classList.contains("nav-announce-panel--open"));
  }

  function isDetailDomOpen() {
    const panel = document.getElementById("navAnnounceDetailPanel");
    return Boolean(panel?.classList.contains("nav-announce-panel--open"));
  }

  function setPanelOpen(open) {
    panelOpen = open;
    const btn = document.getElementById("navAnnounceBtn");
    const panel = document.getElementById("navAnnouncePanel");
    const backdrop = document.getElementById("navAnnounceBackdrop");
    btn?.setAttribute("aria-expanded", open ? "true" : "false");
    panel?.classList.toggle("nav-announce-panel--open", open);
    if (panel) {
      panel.hidden = !open;
      panel.setAttribute("aria-hidden", open ? "false" : "true");
    }
    const backdropVisible = open || detailOpen;
    backdrop?.classList.toggle("nav-announce-backdrop--open", backdropVisible);
    if (backdrop) {
      backdrop.hidden = !backdropVisible;
      backdrop.setAttribute("aria-hidden", backdropVisible ? "false" : "true");
    }
    document.body.classList.toggle("nav-announce-open", backdropVisible);
  }

  function setDetailOpen(open) {
    detailOpen = open;
    const panel = document.getElementById("navAnnounceDetailPanel");
    panel?.classList.toggle("nav-announce-panel--open", open);
    if (panel) {
      panel.hidden = !open;
      panel.setAttribute("aria-hidden", open ? "false" : "true");
    }
    const backdrop = document.getElementById("navAnnounceBackdrop");
    const backdropVisible = panelOpen || open;
    backdrop?.classList.toggle("nav-announce-backdrop--open", backdropVisible);
    if (backdrop) {
      backdrop.hidden = !backdropVisible;
      backdrop.setAttribute("aria-hidden", backdropVisible ? "false" : "true");
    }
    document.body.classList.toggle("nav-announce-open", backdropVisible);
  }

  function pushOverlayHistory(kind, announceId) {
    if (suppressHistoryPop) return;
    // Keep hash (#work 等). Empty URL can drop it and fight page navigation.
    const url = `${global.location.pathname}${global.location.search}${global.location.hash}`;
    history.pushState({ wavrickOverlay: kind, announceId: announceId || null }, "", url);
    historyDepth += 1;
  }

  function popOverlayHistory() {
    if (historyDepth <= 0) return;
    suppressHistoryPop = true;
    history.back();
    historyDepth -= 1;
    global.setTimeout(() => {
      suppressHistoryPop = false;
    }, 0);
  }

  /** パネルを閉じた時点で赤ドットとバッジ数字を消す */
  function finalizeDotsOnPanelClose() {
    const session = getSession();
    if (session?.email) clearPendingDots(session.email);
    void refreshBadge();
  }

  /** Close overlays without history.back — use when navigating to another page. */
  function discardOverlaysForNavigation() {
    openGeneration += 1;
    detailNotificationId = "";
    setDetailOpen(false);
    setPanelOpen(false);
    historyDepth = 0;
    finalizeDotsOnPanelClose();
  }

  function renderItem(n) {
    const title = categoryTitle(n);
    const bodyText = formatAnnouncementText(n);
    const highlight = Boolean(n.highlight);
    const showDot = Boolean(n.pendingDot);
    const itemClass = [
      "nav-announce-item",
      showDot ? "nav-announce-item--has-dot" : "",
      highlight ? "nav-announce-item--restriction" : "",
      highlight ? "nav-announce-item--important" : ""
    ]
      .filter(Boolean)
      .join(" ");

    const unreadDot = showDot
      ? `<span class="nav-announce-unread-dot${highlight ? " nav-announce-unread-dot--important" : ""}" aria-hidden="true"></span>`
      : `<span class="nav-announce-unread-dot nav-announce-unread-dot--empty" aria-hidden="true"></span>`;

    const preview = previewChars(bodyText, 28);

    return `<article class="${itemClass}" data-announce-id="${escapeHtml(n.id)}" role="button" tabindex="0">
      <div class="nav-announce-item-row">
        ${unreadDot}
        <div class="nav-announce-item-main">
          <div class="nav-announce-item-head">
            <p class="nav-announce-title">${escapeHtml(title)}</p>
            <time class="nav-announce-time" datetime="${escapeHtml(n.createdAt || "")}">${escapeHtml(formatDateTime(n.createdAt))}</time>
          </div>
          <p class="nav-announce-preview">${escapeHtml(preview)}</p>
        </div>
        <span class="nav-announce-chevron" aria-hidden="true">›</span>
      </div>
    </article>`;
  }

  function buildDetailActions(n) {
    const rid = String(n.requestId || "").trim();
    const isSuspend = isAccountSuspendedNotification(n);
    const showCase = rid && !isAccountScopedNotification(rid);

    if (showCase && typeof global.showPage === "function") {
      return `<button type="button" class="nav-announce-open-work link-btn" data-request-id="${escapeHtml(rid)}">${escapeHtml(t("announcements.open_work"))}</button>`;
    }
    if (isSuspend) {
      return `<button type="button" class="nav-announce-open-work link-btn" data-go="account">${escapeHtml(t("account.restriction_go_work"))}</button>`;
    }
    return "";
  }

  function renderDetailPanel(n) {
    const titleEl = document.getElementById("navAnnounceDetailTitle");
    const timeEl = document.getElementById("navAnnounceDetailTime");
    const textEl = document.getElementById("navAnnounceDetailText");
    const actionsEl = document.getElementById("navAnnounceDetailActions");
    if (!titleEl || !timeEl || !textEl) return;

    const title = categoryTitle(n);
    const bodyText = formatAnnouncementText(n);
    const highlight = Boolean(n.highlight);

    titleEl.textContent = title;
    titleEl.classList.toggle("nav-announce-detail-title--important", highlight);
    timeEl.textContent = formatDateTime(n.createdAt);
    timeEl.setAttribute("datetime", n.createdAt || "");
    textEl.innerHTML = formatMessageHtml(bodyText);

    const rid = String(n.requestId || "").trim();
    const showCase = rid && !isAccountScopedNotification(rid) && !isAccountSuspendedNotification(n);
    if (actionsEl) {
      const actions = buildDetailActions(n);
      const caseLine = showCase
        ? `<p class="nav-announce-case">${escapeHtml(t("announcements.case_label"))}: ${escapeHtml(rid)}</p>`
        : "";
      actionsEl.innerHTML = caseLine + actions;
    }
  }

  async function renderPanel() {
    const list = document.getElementById("navAnnounceList");
    const empty = document.getElementById("navAnnounceEmpty");
    if (!list) return;

    const session = getSession();
    if (!session?.email) {
      list.innerHTML = "";
      if (empty) {
        empty.hidden = false;
        empty.textContent = t("announcements.login_prompt");
      }
      return;
    }

    const rows = await getVisibleAnnouncements();
    syncPendingDotsWhilePanelOpen(rows, session.email);
    for (const n of rows) {
      n.pendingDot = hasPendingDot(n, session.email);
    }
    if (empty) {
      empty.hidden = rows.length > 0;
      if (!rows.length) empty.textContent = t("announcements.empty");
    }

    list.innerHTML = rows.length ? rows.map((n) => renderItem(n)).join("") : "";
  }

  async function refreshBadge() {
    syncVisibility();
    const badge = document.getElementById("navAnnounceBadge");
    if (!badge) return;
    const session = getSession();
    if (!session?.email) {
      badge.classList.add("hidden");
      badge.classList.remove("nav-announce-badge--restriction");
      badge.textContent = "0";
      return;
    }
    const rows = await getVisibleAnnouncements();
    const suspended = Boolean(global.WavrickAccountRestriction?.isSessionSuspended?.(session));
    const restrictionRows = rows.filter((n) => isAccountSuspendedNotification(n));
    const hasActiveRestrictionNotice = suspended && restrictionRows.length > 0;
    const unreadRows = countBadgeRows(rows);
    const unreadCount = unreadRows.length;
    const hasHighlightUnread =
      hasActiveRestrictionNotice || unreadRows.some((n) => isHighlightNotification(n));
    const count = hasActiveRestrictionNotice
      ? Math.max(unreadCount, restrictionRows.length)
      : unreadCount;
    badge.classList.toggle("nav-announce-badge--restriction", hasHighlightUnread);
    if (count > 0) {
      badge.textContent = count > 99 ? "99+" : String(count);
      badge.classList.remove("hidden");
    } else {
      badge.classList.add("hidden");
      badge.classList.remove("nav-announce-badge--restriction");
      badge.textContent = "0";
    }
  }

  async function refresh() {
    syncVisibility();
    const session = getSession();
    const panelVisible = panelOpen || isPanelDomOpen();
    const detailVisible = detailOpen || isDetailDomOpen();
    await refreshBadge();
    if (panelVisible) await renderPanel();
    if (detailVisible && detailNotificationId) {
      const n = notificationCache.get(detailNotificationId);
      if (n) renderDetailPanel(n);
    }
    if (session?.email && typeof global.wavrickRefreshNotifications === "function") {
      void global.wavrickRefreshNotifications(panelVisible).then((changed) => {
        if (typeof global.wavrickSyncNotificationReadState === "function") {
          void global.wavrickSyncNotificationReadState().then((readChanged) => {
            if (!readChanged && !changed) return;
            void refreshBadge();
            if (panelOpen || isPanelDomOpen()) void renderPanel();
          });
          return;
        }
        if (!changed) return;
        void refreshBadge();
        if (panelOpen || isPanelDomOpen()) void renderPanel();
      });
    }
  }

  async function openPanel() {
    const gen = ++openGeneration;
    const session = getSession();
    if (!session?.email) return;

    setPanelOpen(true);
    pushOverlayHistory("announcements");

    // Pull cloud rows first — otherwise welcome/identity auto-sends look "missing"
    // until a later refresh, and a !changed short-circuit left the panel empty.
    if (typeof global.wavrickRefreshNotifications === "function") {
      try {
        await global.wavrickRefreshNotifications(true);
      } catch (error) {
        console.warn("[wavrick] announcements refresh on open failed", error);
      }
    }
    if (gen !== openGeneration || !panelOpen) return;

    // 一覧を開いた時点で全件既読化。ただし赤ドット（pendingDot）は
    // パネルを閉じるか各メッセージを開くまで残し、バッジもドット数を表示し続ける。
    // ローカルの既読マップ/ドットは同期反映されるため、クラウド永続化は待たない。
    const rows = await getVisibleAnnouncements();
    void markAllVisibleRead(session.email, rows);

    if (gen !== openGeneration || !panelOpen) return;
    await renderPanel();
    await refreshBadge();
  }

  async function openAnnouncementDetail(id) {
    const session = getSession();
    if (!session?.email || !id) return;

    let n = notificationCache.get(id);
    if (!n) {
      const rows = await getVisibleAnnouncements();
      n = rows.find((row) => row.id === id);
    }
    if (!n) return;

    markNotificationRead(session.email, n.id);
    removePendingDot(session.email, n.id);
    n.unread = false;
    n.pendingDot = false;
    notificationCache.set(String(n.id), n);

    detailNotificationId = id;
    renderDetailPanel(n);
    setDetailOpen(true);
    pushOverlayHistory("announcement-detail", id);
    void refreshBadge();
    if (panelOpen || isPanelDomOpen()) await renderPanel();
  }

  function closeDetail(fromHistory) {
    if (!detailOpen && !isDetailDomOpen()) return;
    detailNotificationId = "";
    setDetailOpen(false);
    if (!fromHistory && historyDepth > 0) popOverlayHistory();
  }

  function closePanel(fromHistory) {
    openGeneration += 1;
    closeDetail(true);
    setPanelOpen(false);
    finalizeDotsOnPanelClose();
    if (fromHistory) return;
    if (historyDepth <= 0) return;
    // Panel + detail may each have pushed history — pop all at once.
    const n = historyDepth;
    historyDepth = 0;
    suppressHistoryPop = true;
    history.go(-n);
    global.setTimeout(() => {
      suppressHistoryPop = false;
    }, 0);
  }

  function handleBackdropClose() {
    if (detailOpen || isDetailDomOpen()) {
      closeDetail(false);
      return;
    }
    closePanel(false);
  }

  function bindSwipeToClose(element, onClose) {
    if (!element || element.dataset.swipeBound === "1") return;
    element.dataset.swipeBound = "1";
    let startX = 0;
    let startY = 0;
    let tracking = false;

    element.addEventListener(
      "touchstart",
      (e) => {
        if (e.touches.length !== 1) return;
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        tracking = startX <= 48 || Boolean(e.target.closest(".nav-announce-panel-head"));
      },
      { passive: true }
    );

    element.addEventListener(
      "touchend",
      (e) => {
        if (!tracking) return;
        const touch = e.changedTouches[0];
        const dx = touch.clientX - startX;
        const dy = Math.abs(touch.clientY - startY);
        tracking = false;
        if (dx > 72 && dy < 80) onClose();
      },
      { passive: true }
    );
  }

  function tryHandlePopstate() {
    if (suppressHistoryPop) return true;
    if (historyDepth <= 0) return false;
    if (detailOpen || isDetailDomOpen()) {
      closeDetail(true);
      historyDepth = Math.max(0, historyDepth - 1);
      return true;
    }
    if (panelOpen || isPanelDomOpen()) {
      closePanel(true);
      historyDepth = Math.max(0, historyDepth - 1);
      return true;
    }
    return false;
  }

  function bindUi() {
    const btn = document.getElementById("navAnnounceBtn");
    const markAllBtn = document.getElementById("navAnnounceMarkAllBtn");
    const closeBtn = document.getElementById("navAnnounceClose");
    const detailCloseBtn = document.getElementById("navAnnounceDetailClose");
    const detailBackBtn = document.getElementById("navAnnounceDetailBack");
    const backdrop = document.getElementById("navAnnounceBackdrop");
    const list = document.getElementById("navAnnounceList");
    const listPanel = document.getElementById("navAnnouncePanel");
    const detailPanel = document.getElementById("navAnnounceDetailPanel");
    if (!btn || btn.dataset.bound === "1") return;
    btn.dataset.bound = "1";

    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (panelOpen || isPanelDomOpen()) closePanel(false);
      else void openPanel();
    });

    markAllBtn?.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const session = getSession();
      if (!session?.email) return;
      const rows = await getVisibleAnnouncements();
      await markAllVisibleRead(session.email, rows);
      await renderPanel();
      await refreshBadge();
    });

    const handleListClose = (e) => {
      e.preventDefault();
      e.stopPropagation();
      closePanel(false);
    };
    closeBtn?.addEventListener("click", handleListClose);
    backdrop?.addEventListener("click", (e) => {
      e.preventDefault();
      handleBackdropClose();
    });

    detailCloseBtn?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeDetail(false);
    });
    detailBackBtn?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeDetail(false);
    });

    bindSwipeToClose(listPanel, () => closePanel(false));
    bindSwipeToClose(detailPanel, () => closeDetail(false));

    const handleWorkNav = (workBtn) => {
      // Do not history.back() here — that races with showPage/openWork and snaps away from 案件管理.
      discardOverlaysForNavigation();
      if (typeof global.wavrickCloseMobileNav === "function") {
        global.wavrickCloseMobileNav(true);
      }
      const goPage = workBtn.getAttribute("data-go") || "";
      const requestId = workBtn.dataset.requestId || "";
      if (goPage && typeof global.showPage === "function") {
        global.showPage(goPage);
      } else if (requestId) {
        if (typeof global.setWorkSelectedRequestId === "function") {
          global.setWorkSelectedRequestId(requestId);
        }
        if (typeof global.openWorkCaseById === "function") {
          void global.openWorkCaseById(requestId);
        } else if (typeof global.showPage === "function") {
          global.showPage("work");
        }
      }
    };

    list?.addEventListener("click", (e) => {
      const link = e.target.closest("a");
      if (link) return;

      const workBtn = e.target.closest(".nav-announce-open-work");
      if (workBtn) {
        e.preventDefault();
        e.stopPropagation();
        handleWorkNav(workBtn);
        return;
      }

      const item = e.target.closest(".nav-announce-item");
      if (!item) return;
      e.preventDefault();
      const id = item.getAttribute("data-announce-id") || "";
      void openAnnouncementDetail(id);
    });

    list?.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const item = e.target.closest(".nav-announce-item");
      if (!item) return;
      e.preventDefault();
      const id = item.getAttribute("data-announce-id") || "";
      void openAnnouncementDetail(id);
    });

    document.getElementById("navAnnounceDetailActions")?.addEventListener("click", (e) => {
      const workBtn = e.target.closest(".nav-announce-open-work");
      if (!workBtn) return;
      e.preventDefault();
      e.stopPropagation();
      handleWorkNav(workBtn);
    });

    global.addEventListener("wavrick:localechange", () => {
      void refresh();
    });

    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (detailOpen || isDetailDomOpen()) {
        closeDetail(false);
        return;
      }
      if (panelOpen || isPanelDomOpen()) closePanel(false);
    });

    global.addEventListener("wavrick-announcements-changed", () => {
      requestIdCache = null;
      void refresh();
    });
    global.addEventListener("wavrick-workdata-updated", () => {
      requestIdCache = null;
      void refresh();
    });
    global.addEventListener("wavrick:clouddata-ready", () => {
      requestIdCache = null;
      void refresh();
    });
  }

  function init() {
    bindUi();
    setPanelOpen(false);
    setDetailOpen(false);
    syncVisibility();
    const session = getSession();
    // ドットはパネル表示中のみ有効。リロード等で残った分は起動時に消す
    if (session?.email) clearPendingDots(session.email);
    const runRetention = (requestIds) => {
      if (session && typeof global.enforceNotificationRetentionForSession === "function") {
        void global.enforceNotificationRetentionForSession(session, requestIds);
      }
    };
    if (session) {
      const bootstrapDone =
        typeof global.wavrickIsCloudBootstrapDone === "function" && global.wavrickIsCloudBootstrapDone();
      if (bootstrapDone) {
        void getRelevantRequestIds(session).then(runRetention);
      } else {
        const onCloudReady = () => {
          global.removeEventListener("wavrick:clouddata-ready", onCloudReady);
          void getRelevantRequestIds(session).then(runRetention);
        };
        global.addEventListener("wavrick:clouddata-ready", onCloudReady);
      }
    }
    void refresh();
  }

  global.WavrickAnnouncements = {
    init,
    refresh,
    getUnreadCount,
    getVisibleAnnouncements,
    tryHandlePopstate,
    markAllRead: async () => {
      const session = getSession();
      if (!session?.email) return;
      const rows = await getVisibleAnnouncements();
      await markAllVisibleRead(session.email, rows);
      await refreshBadge();
      if (panelOpen || isPanelDomOpen()) await renderPanel();
    },
    syncVisibility,
    closePanel: (fromHistory) => closePanel(Boolean(fromHistory)),
    discardForNavigation: discardOverlaysForNavigation,
    closeDetail: (fromHistory) => closeDetail(Boolean(fromHistory))
  };
})(typeof window !== "undefined" ? window : globalThis);
