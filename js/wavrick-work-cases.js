/**
 * 案件一覧・選択（index 案件管理 / 収録ブース 共通）
 */
(function initWavrickWorkCases(global) {
  const WORK_SELECTED_REQUEST_KEY = "wavrick_work_selected_request_id";

  function getSession() {
    try {
      return JSON.parse(localStorage.getItem("wavrick_session") || "null");
    } catch {
      return null;
    }
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

  function parseSelectedTalentIds(value) {
    return String(value || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function resolveVoiceTalentId(session) {
    if (!session || session.role !== "voice") return "";
    if (session.talentId) return String(session.talentId);
    const email = (session.email || "").toLowerCase().trim();
    if (email) return `voice:${email}`;
    return "";
  }

  function requestAssignedToVoice(request, talentId) {
    if (!talentId || !request) return false;
    const ids = parseSelectedTalentIds(request.selectedTalentId);
    if (ids.includes(talentId)) return true;
    const cast = parseCastMetaFromScript(request.script);
    if (cast?.castSlots?.some((s) => s.mode === "pick" && String(s.talentId) === talentId)) return true;
    return false;
  }

  function getMergedYoutubeRequestsSync() {
    try {
      const rows = JSON.parse(localStorage.getItem("wavrick_youtube_requests") || "[]");
      return Array.isArray(rows) ? rows : [];
    } catch {
      return [];
    }
  }

  function getVisibleCasesSync() {
    const session = getSession();
    const rows = getMergedYoutubeRequestsSync();
    if (!session) return [];
    if (session.role === "admin") return rows;
    if (session.role === "customer") {
      const email = (session.email || "").toLowerCase();
      return rows.filter((r) => (r.email || "").toLowerCase() === email);
    }
    if (session.role === "voice") {
      const talentId = resolveVoiceTalentId(session);
      return rows.filter((r) => requestAssignedToVoice(r, talentId));
    }
    return [];
  }

  function findCaseById(requestId) {
    if (!requestId) return null;
    return getMergedYoutubeRequestsSync().find((r) => r.requestId === requestId) || null;
  }

  function formatCaseLabel(request) {
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

  function getSelectedCaseId() {
    return (
      sessionStorage.getItem(WORK_SELECTED_REQUEST_KEY) ||
      localStorage.getItem(WORK_SELECTED_REQUEST_KEY) ||
      ""
    );
  }

  function setSelectedCaseId(requestId) {
    if (!requestId) return;
    sessionStorage.setItem(WORK_SELECTED_REQUEST_KEY, requestId);
    localStorage.setItem(WORK_SELECTED_REQUEST_KEY, requestId);
  }

  global.WavrickWorkCases = {
    WORK_SELECTED_REQUEST_KEY,
    getSession,
    getMergedYoutubeRequestsSync,
    getVisibleCasesSync,
    findCaseById,
    formatCaseLabel,
    getSelectedCaseId,
    setSelectedCaseId,
    resolveVoiceTalentId,
    requestAssignedToVoice
  };
})(typeof window !== "undefined" ? window : globalThis);
