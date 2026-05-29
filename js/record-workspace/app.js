/**
 * WAVRICK — 声優用収録ワークスペース
 * YouTube ⟷ 波形 ⟷ タイムコード台本 + セリフ録音
 */

import {
  parseScriptLines,
  formatTimecode,
  buildScriptLine,
  scriptLinesToText,
  normalizeScriptLineTimings,
  expandScriptLinesWithInlineTimecodes,
  inferredLineEndSec,
  DEMO_SCRIPT,
  DEFAULT_YOUTUBE_URL,
  extractYouTubeVideoId,
  resolveTimelineDurationSec
} from "./timecode.js?v=rw-bracket-grok-2026-05-28";
import { YouTubeSyncPlayer, YT_STATE } from "./youtube-player.js?v=rw-chrome-take-2026-05-22";
import {
  DualTrackWaveform,
  fetchAudioBlobFromProxy,
  readProxyConfig,
  vocalSeparationHint,
  isSafariBrowser
} from "./waveform.js?v=rw-booth-v2-2026-05-22";
import { LineRecorder } from "./line-recorder.js?v=rw-cloud-trash-2026-05-22";
import {
  consumeHandoff,
  prepareScriptForWorkspace,
  persistTimecodedScriptToRequest
} from "./script-import.js?v=rw-tc-duration-2026-05-27t";
import {
  hideAdrOverlay,
  playCueBeep,
  sleep,
  updateAdrOverlay
} from "./adr-cues.js?v=rw-multitrack-2026-05-22";
import {
  buildConcatenatedTakes,
  buildTimelineMix
} from "./take-concat.js?v=rw-take-edit-2026-05-22";
import {
  mergeScriptLines,
  splitMergedLine,
  isAutoBlockBoundary,
  getTeleprompterRows,
  lineDisplayText,
  concatSamplesWithTimelineGaps,
  gapSecBetweenLines
} from "./script-cue-ops.js?v=rw-cue-merge-2026-05-24";
import { encodeWavBlob } from "./wav-encode.js?v=rw-cue-merge-2026-05-24";
import { getProcessedTakeSamples } from "./take-audio-edit.js?v=rw-cue-merge-2026-05-24";
import {
  createEditedPreviewUrl,
  detachEditedAudioPreview,
  getEffectiveTakeDurationSec,
  isTakeEditAtDefault,
  MIN_TAKE_CLIP_SEC,
  normalizeTakeEdit,
  playEditedAudioPreview,
  probeBlobDurationSec,
  storePreviewUrl
} from "./take-audio-edit.js?v=rw-take-playback-2026-05-22";
import {
  isCloudSaveAvailable,
  loadWorkspaceFromCloud,
  saveWorkspaceToCloud
} from "./workspace-cloud-save.js?v=rw-cloud-2026-05-22";
import {
  loadWorkspaceSessionCache,
  saveWorkspaceSessionCache
} from "./workspace-session-cache.js?v=rw-session-2026-05-27";
import {
  CueRetakeStore,
  cueSnapshotFromLine,
  projectIdFromRequest
} from "./cue-retake.js?v=rw-cue-retake-2026-05-22";
import { TakeEditPreview } from "./take-edit-preview.js?v=rw-take-edit-2026-05-22";
import { LiveMicWaveform } from "./live-mic-waveform.js?v=rw-features-2026-05-22";
import {
  loadWorkspaceFeatures,
  saveWorkspaceFeature,
  WORKSPACE_FEATURES
} from "./workspace-settings.js?v=rw-features-2026-05-22";
import {
  buildSessionExportJson,
  downloadSessionJson,
  playBpmClick,
  runPingPongPreview,
  startInputLevelMeter,
  startOverdubMonitor,
  stopInputLevelMeter,
  stopOverdubMonitor,
  suggestNoiseGateTrim
} from "./workspace-features.js?v=rw-features-2026-05-22";

const els = {
  ytUrl: document.getElementById("rwYoutubeUrl"),
  loadVideoBtn: document.getElementById("rwLoadVideoBtn"),
  loadWaveBtn: document.getElementById("rwLoadWaveBtn"),
  audioFile: document.getElementById("rwAudioFile"),
  playPauseBtn: document.getElementById("rwPlayPauseBtn"),
  playTakeTransportBtn: document.getElementById("rwPlayTakeTransportBtn"),
  recordBtn: document.getElementById("rwRecordBtn"),
  stopBtn: document.getElementById("rwStopBtn"),
  cueBtn: document.getElementById("rwCueBtn"),
  prevLineBtn: document.getElementById("rwPrevLineBtn"),
  nextLineBtn: document.getElementById("rwNextLineBtn"),
  timeDisplay: document.getElementById("rwTimeDisplay"),
  recordIndicator: document.getElementById("rwRecordIndicator"),
  progressLabel: document.getElementById("rwProgressLabel"),
  progressFill: document.getElementById("rwProgressFill"),
  preRoll: document.getElementById("rwPreRoll"),
  autoRecordAtCue: document.getElementById("rwAutoRecordAtCue"),
  accountSummary: document.getElementById("rwAccountSummary"),
  bugReportText: document.getElementById("rwBugReportText"),
  bugReportEmail: document.getElementById("rwBugReportEmail"),
  bugReportCopyBtn: document.getElementById("rwBugReportCopyBtn"),
  bugReportSendBtn: document.getElementById("rwBugReportSendBtn"),
  savePanel: document.getElementById("rwSavePanel"),
  saveBtn: document.getElementById("rwSaveBtn"),
  loadSaveBtn: document.getElementById("rwLoadSaveBtn"),
  saveStatus: document.getElementById("rwSaveStatus"),
  trashPanel: document.getElementById("rwTrashPanel"),
  trashList: document.getElementById("rwTrashList"),
  trashEmpty: document.getElementById("rwTrashEmpty"),
  retakeBanner: document.getElementById("rwRetakeBanner"),
  retakeCount: document.getElementById("rwRetakeCount"),
  retakeNextBtn: document.getElementById("rwRetakeNextBtn"),
  retakePanel: document.getElementById("rwRetakePanel"),
  retakeList: document.getElementById("rwRetakeList"),
  retakeSimulateBtn: document.getElementById("rwRetakeSimulateBtn"),
  multitrackSeekBar: document.getElementById("rwMultitrackSeekBar"),
  multitrackSeek: document.getElementById("rwMultitrackSeek"),
  seekTc: document.getElementById("rwSeekTc"),
  seekDuration: document.getElementById("rwSeekDuration"),
  cueIndex: document.getElementById("rwCueIndex"),
  cueTc: document.getElementById("rwCueTc"),
  cuePrev: document.getElementById("rwCuePrev"),
  cueCurrent: document.getElementById("rwCueCurrent"),
  cueNext: document.getElementById("rwCueNext"),
  playTakeBtn: document.getElementById("rwPlayTakeBtn"),
  takeCards: document.getElementById("rwTakeCards"),
  takeCardsEmpty: document.getElementById("rwTakeCardsEmpty"),
  takeDeskHint: document.getElementById("rwTakeDeskHint"),
  takeEditor: document.getElementById("rwTakeEditor"),
  takeEditorDur: document.getElementById("rwTakeEditorDur"),
  takeGain: document.getElementById("rwTakeGain"),
  takeGainVal: document.getElementById("rwTakeGainVal"),
  takeTrimStart: document.getElementById("rwTakeTrimStart"),
  takeTrimStartVal: document.getElementById("rwTakeTrimStartVal"),
  takeTrimEnd: document.getElementById("rwTakeTrimEnd"),
  takeTrimEndVal: document.getElementById("rwTakeTrimEndVal"),
  takeEditResetBtn: document.getElementById("rwTakeEditResetBtn"),
  takeEditApplyBtn: document.getElementById("rwTakeEditApplyBtn"),
  takeEditPreviewBtn: document.getElementById("rwTakeEditPreviewBtn"),
  takeEditWaveHost: document.getElementById("rwTakeEditWaveHost"),
  takeEditorPending: document.getElementById("rwTakeEditorPending"),
  takeEditorMeta: document.getElementById("rwTakeEditorMeta"),
  recordBoothBar: document.getElementById("rwRecordBoothBar"),
  boothStatus: document.getElementById("rwBoothStatus"),
  openBoothBtn: document.getElementById("rwOpenBoothBtn"),
  boothReadyBtn: document.getElementById("rwBoothReadyBtn"),
  boothStartBtn: document.getElementById("rwBoothStartBtn"),
  boothStopBtn: document.getElementById("rwBoothStopBtn"),
  boothCloseBtn: document.getElementById("rwBoothCloseBtn"),
  liveRecPanel: document.getElementById("rwLiveRecPanel"),
  liveRecCanvas: document.getElementById("rwLiveRecCanvas"),
  addScriptLineBtn: document.getElementById("rwAddScriptLineBtn"),
  status: document.getElementById("rwStatus"),
  playerHost: document.getElementById("rwPlayerHost"),
  refWaveHost: document.getElementById("rwRefWaveHost"),
  takeLane: document.getElementById("rwTakeLane"),
  takeLaneScroll: document.getElementById("rwTakeLaneScroll"),
  scriptEditor: document.getElementById("rwScriptEditor"),
  applyScriptBtn: document.getElementById("rwApplyScriptBtn"),
  scriptList: document.getElementById("rwScriptList"),
  scriptSelectModeBtn: document.getElementById("rwScriptSelectModeBtn"),
  scriptMergeBtn: document.getElementById("rwScriptMergeBtn"),
  scriptSplitBtn: document.getElementById("rwScriptSplitBtn"),
  undoBtn: document.getElementById("rwUndoBtn"),
  redoBtn: document.getElementById("rwRedoBtn"),
  saveSessionBtn: document.getElementById("rwSaveSessionBtn"),
  excelBarHint: document.getElementById("rwExcelBarHint"),
  teleprompterScroll: document.getElementById("rwTeleprompterScroll"),
  proxyUrl: document.getElementById("rwProxyUrl"),
  proxySecret: document.getElementById("rwProxySecret"),
  saveProxyBtn: document.getElementById("rwSaveProxyBtn"),
  audioOffset: document.getElementById("rwAudioOffset"),
  videoPanel: document.getElementById("rwVideoPanel"),
  videoPanelHead: document.getElementById("rwVideoPanelHead"),
  showVideoBtn: document.getElementById("rwShowVideoBtn"),
  waveDock: document.getElementById("rwWaveDock"),
  vocalBadge: document.getElementById("rwVocalBadge"),
  waveEmptyHint: document.getElementById("rwWaveEmptyHint"),
  takePreview: document.getElementById("rwTakePreview"),
  takePreviewWrap: document.getElementById("rwTakePreviewWrap"),
  adrOverlay: document.getElementById("rwAdrOverlay"),
  countdownBeeps: document.getElementById("rwCountdownBeeps"),
  holdToRecord: document.getElementById("rwHoldToRecord"),
  settingsPanel: document.getElementById("rwSettingsPanel"),
  sessionExportBtn: document.getElementById("rwSessionExportBtn"),
  pingPongBtn: document.getElementById("rwPingPongBtn"),
  noiseGateSuggestBtn: document.getElementById("rwNoiseGateSuggestBtn"),
  markerListPanel: document.getElementById("rwMarkerListPanel"),
  markerList: document.getElementById("rwMarkerList"),
  inputLevelMeter: document.getElementById("rwInputLevelMeter"),
  punchTime: document.getElementById("rwPunchTime"),
  punchScriptHint: document.getElementById("rwPunchScriptHint"),
  setPunchBtn: document.getElementById("rwSetPunchBtn"),
  jumpPunchBtn: document.getElementById("rwJumpPunchBtn"),
  resetPunchBtn: document.getElementById("rwResetPunchBtn"),
  flowList: document.getElementById("rwFlowList"),
  flowSummary: document.getElementById("rwFlowSummary"),
  playConcatBtn: document.getElementById("rwPlayConcatBtn"),
  downloadConcatBtn: document.getElementById("rwDownloadConcatBtn"),
  queueDeliveryBtn: document.getElementById("rwQueueDeliveryBtn"),
  caseSelect: document.getElementById("rwCaseSelect"),
  activeCaseLabel: document.getElementById("rwActiveCaseLabel"),
  caseManageLink: document.getElementById("rwCaseManageLink"),
  concatPreview: document.getElementById("rwConcatPreview"),
  concatPreviewWrap: document.getElementById("rwConcatPreviewWrap"),
  noiseToggleBtn: document.getElementById("rwNoiseToggleBtn")
};

/** @type {YouTubeSyncPlayer|null} */
let ytPlayer = null;
/** @type {DualTrackWaveform|null} */
let waveform = null;
/** @type {LineRecorder} */
const lineRecorder = new LineRecorder({
  previewAudio: document.getElementById("rwTakePreview")
});
lineRecorder.onTakeChange = (lineId, _count, blob) => {
  updateProgressBar();
  renderScriptList();
  renderSessionFlow();
  renderTakeDesk();
  renderTakeEditor();
  updateTakeUi();
  updateConcatButtons();
  syncTakePreviewPlayer(lineId);
  void reloadActiveTakeWave(lineId, blob);
};

/** @param {string} lineId @param {Blob|null|undefined} blob */
function getScriptLineNum(lineId) {
  const i = scriptLines.findIndex((l) => l.id === lineId);
  return i >= 0 ? i + 1 : 0;
}

async function reloadActiveTakeWave(lineId, blob) {
  if (!waveform?.ready) return;
  const line = scriptLines.find((l) => l.id === lineId);
  if (!blob || !line) {
    pendingTakeWaveIndex.delete(lineId);
    waveform.clearTakeForLine(lineId);
    return;
  }
  const idx = lineRecorder.getActiveTakeIndex(lineId);
  pendingTakeWaveIndex.set(lineId, idx);
  const edit = lineRecorder.getTakeEdit(lineId, idx);
  await waveform.setTakeForLine(lineId, blob, {
    positionSec: getTakeClipPositionSec(line) + audioOffsetSec,
    lineNum: getScriptLineNum(lineId),
    edit
  });
  waveform.setClipPosition(lineId, getTakeClipPositionSec(line) + audioOffsetSec);
  waveform.setClipEdit(lineId, edit);
}

/** @type {{ id: string, startSec: number, endSec: number|null, text: string, rawTc: string }[]} */
let scriptLines = [];
let scriptSelectMode = false;
/** @type {Set<number>} */
let scriptSelectedIndices = new Set();
/** @type {{ manifest: object, takeBlobs: Map<string, Blob> }[]} */
let workspaceUndoStack = [];
/** @type {{ manifest: object, takeBlobs: Map<string, Blob> }[]} */
let workspaceRedoStack = [];
let teleprompterManualScrollUntil = 0;

/** @type {string|null} */
let audioObjectUrl = null;
let isPlaying = false;
/** @type {string|null} */
let activeLineId = null;
let focusedLineIndex = 0;
let preRollSec = 3;
let autoRecordAtCue = false;
let countdownBeepsOn = true;
/** スペース長押しでプレロール→録音（離すと停止） */
let holdToRecordOn = false;
/** 長押し録音セッション中（keyup で停止 or キャンセル） */
let holdSpacePunchActive = false;

const HOLD_TO_RECORD_KEY = "wavrick_rw_hold_to_record";
const SCRIPT_STATE_KEY = "wavrick_rw_script_state";
let _suppressScriptSave = false;

/** @type {Record<string, boolean>} */
let workspaceFeatures = loadWorkspaceFeatures();

function isFeatureOn(id) {
  return Boolean(workspaceFeatures[id]);
}

function forceScriptStateSave() {
  try {
    const data = scriptLines.map(l => {
      const entry = { id: l.id, startSec: l.startSec, endSec: l.endSec, text: l.text, rawTc: l.rawTc };
      if (l.isMergedCue) entry.isMergedCue = true;
      if (l.mergedFrom) entry.mergedFrom = l.mergedFrom;
      if (l.segments && l.segments.length > 1) entry.segments = l.segments;
      return entry;
    });
    const payload = { scriptLines: data, focusedLineIndex, savedAt: Date.now() };
    localStorage.setItem(SCRIPT_STATE_KEY, JSON.stringify(payload));
    if (els.scriptEditor) {
      localStorage.setItem("wavrick_rw_editor_text", els.scriptEditor.value);
      localStorage.setItem("wavrick_rw_editor_saved_at", String(Date.now()));
    }
    localStorage.setItem("wavrick_rw_yturl", els.ytUrl?.value?.trim() || "");
  } catch (e) {
    console.warn("[wavrick] force script save failed:", e);
  }
}

function saveScriptStateToLocal() {
  if (_suppressScriptSave) return;
  try {
    const data = scriptLines.map(l => {
      const entry = { id: l.id, startSec: l.startSec, endSec: l.endSec, text: l.text, rawTc: l.rawTc };
      if (l.isMergedCue) entry.isMergedCue = true;
      if (l.mergedFrom) entry.mergedFrom = l.mergedFrom;
      if (l.segments && l.segments.length > 1) entry.segments = l.segments;
      return entry;
    });
    const payload = { scriptLines: data, focusedLineIndex, savedAt: Date.now() };
    localStorage.setItem(SCRIPT_STATE_KEY, JSON.stringify(payload));
    if (els.scriptEditor) {
      localStorage.setItem("wavrick_rw_editor_text", els.scriptEditor.value);
      localStorage.setItem("wavrick_rw_editor_saved_at", String(Date.now()));
    }
    localStorage.setItem("wavrick_rw_yturl", els.ytUrl?.value?.trim() || "");
  } catch (e) {
    console.error("[wavrick] script state save FAILED:", e);
  }
}

function loadScriptStateFromLocal() {
  try {
    const raw = localStorage.getItem(SCRIPT_STATE_KEY);
    if (raw) {
      const state = JSON.parse(raw);
      if (Array.isArray(state.scriptLines) && state.scriptLines.length > 0) {
        if (isScriptDemoData(state.scriptLines)) return null;
        return state;
      }
    }
  } catch (e) { /* ignore */ }
  try {
    const editorText = localStorage.getItem("wavrick_rw_editor_text");
    if (editorText && editorText.trim()) {
      if (/^\[00:02\.00\]\s*Hello/i.test(editorText.trim())) return null;
      const lines = parseScriptLines(editorText);
      if (lines.length > 0) return { scriptLines: lines, focusedLineIndex: 0, savedAt: 0 };
    }
  } catch (e) { /* ignore */ }
  return null;
}

function isScriptDemoData(lines) {
  if (!lines || lines.length === 0) return false;
  const first = lines[0];
  const t = (first.text || "").trim().toLowerCase();
  return t === "hello" || t.startsWith("hello") && lines.length <= 3;
}

function clearDemoScriptState() {
  try {
    const raw = localStorage.getItem(SCRIPT_STATE_KEY);
    if (raw) {
      const state = JSON.parse(raw);
      if (Array.isArray(state.scriptLines) && isScriptDemoData(state.scriptLines)) {
        localStorage.removeItem(SCRIPT_STATE_KEY);
      }
    }
  } catch { /* ignore */ }
  try {
    const editorText = localStorage.getItem("wavrick_rw_editor_text");
    if (editorText && /^\[00:02\.00\]\s*Hello/i.test(editorText.trim())) {
      localStorage.removeItem("wavrick_rw_editor_text");
    }
  } catch { /* ignore */ }
  try {
    const syncRaw = localStorage.getItem("wavrick_booth_sync");
    if (syncRaw) {
      const sync = JSON.parse(syncRaw);
      if (sync.scriptLines && sync.scriptLines.length > 0 &&
          String(sync.scriptLines[0].id).startsWith("demo-")) {
        localStorage.removeItem("wavrick_booth_sync");
      }
    }
  } catch { /* ignore */ }
}

function applyWorkspaceFeatureUi() {
  document.body.classList.toggle(
    "rw-feat-dual-screen",
    isFeatureOn("dualScreenMode")
  );
  document.body.classList.toggle(
    "rw-feat-take-colors",
    isFeatureOn("takeColorLabels")
  );
  if (els.markerListPanel) {
    els.markerListPanel.hidden = !isFeatureOn("markerList");
  }
  if (els.pingPongBtn) {
    els.pingPongBtn.hidden = !isFeatureOn("pingPongPreview");
  }
  if (els.noiseGateSuggestBtn) {
    els.noiseGateSuggestBtn.hidden = !isFeatureOn("noiseGateSuggest");
  }
  if (els.sessionExportBtn) {
    els.sessionExportBtn.hidden = !isFeatureOn("sessionExport");
  }
  if (!isFeatureOn("markerList")) renderMarkerList();
  else renderMarkerList();
  renderTakeDesk();
}

function renderMarkerList() {
  const ul = els.markerList;
  if (!ul || !isFeatureOn("markerList")) return;
  ul.innerHTML = scriptLines
    .map((line, i) => {
      const done = lineRecorder.hasRecording(line.id);
      const cur = i === focusedLineIndex;
      const label = `${i + 1}. ${line.text.slice(0, 28)}${line.text.length > 28 ? "…" : ""}`;
      return `<li><button type="button" class="${cur ? "is-current" : ""} ${done ? "is-done" : ""}" data-marker-index="${i}">${label}</button></li>`;
    })
    .join("");
}

function bindWorkspaceFeatureSettings() {
  for (const f of WORKSPACE_FEATURES) {
    const el = document.getElementById(`rwFeat_${f.id}`);
    if (!el || !(el instanceof HTMLInputElement)) continue;
    el.checked = isFeatureOn(f.id);
    el.addEventListener("change", () => {
      workspaceFeatures[f.id] = el.checked;
      saveWorkspaceFeature(f.id, el.checked);
      applyWorkspaceFeatureUi();
      setStatus(
        `${f.label}を${el.checked ? "オン" : "オフ"}にしました。`,
        "ok"
      );
    });
  }
  els.sessionExportBtn?.addEventListener("click", () => {
    const data = buildSessionExportJson({
      scriptLines,
      lineRecorder,
      features: { ...workspaceFeatures },
      preRollSec,
      audioOffsetSec,
      recordStartByLineId,
      takeClipPositionByLineId
    });
    downloadSessionJson(data);
    setStatus("セッション JSON をダウンロードしました。", "ok");
  });
  els.pingPongBtn?.addEventListener("click", () => void runPingPongPreviewFlow());
  els.noiseGateSuggestBtn?.addEventListener("click", () =>
    void applyNoiseGateSuggest()
  );
  els.markerList?.addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-marker-index]");
    if (!btn) return;
    const idx = Number(btn.getAttribute("data-marker-index"));
    if (Number.isFinite(idx)) setFocusedLineIndex(idx);
  });
}

async function runPingPongPreviewFlow() {
  const line = getFocusedLine();
  if (!line || !waveform?.ready) {
    setStatus("ピンポン試聴には台本行と ② 読込が必要です。", "err");
    return;
  }
  await runPingPongPreview({
    getFocusedLine: () => getFocusedLine(),
    stopRef: () => pauseReferencePlayback(),
    playTake: (id) => playTakeForLine(id),
    playRefFromLine: (ln) => {
      jumpToRecordStart(ln, { play: true });
      return true;
    }
  });
}

async function applyNoiseGateSuggest() {
  const line = getFocusedLine();
  if (!line) return;
  const idx = lineRecorder.getActiveTakeIndex(line.id);
  const take = lineRecorder.getTakes(line.id)[idx];
  if (!take?.blob) return;
  try {
    const { trimStartSec, trimEndSec } = await suggestNoiseGateTrim(take.blob);
    lineRecorder.setTakeEditDraft(line.id, idx, {
      ...lineRecorder.getTakeEditDraft(line.id, idx),
      trimStartSec,
      trimEndSec
    });
    void syncTakeEditStudio();
    setStatus(
      `無音カット候補: 頭 ${trimStartSec.toFixed(2)}s / 末尾 ${trimEndSec.toFixed(2)}s（適用で確定）`,
      "ok"
    );
  } catch (err) {
    setStatus(
      err instanceof Error ? err.message : "無音検出に失敗しました",
      "err"
    );
  }
}

function maybeLoopLineRegion(waveT) {
  if (!isFeatureOn("loopLineRegion") || !isPlaying) return;
  const line = getFocusedLine();
  if (!line || !waveform?.ready) return;
  const end = line.endSec ?? line.startSec + 4;
  const start = line.startSec + audioOffsetSec;
  const endWave = end + audioOffsetSec;
  if (waveT >= endWave - 0.05) {
    waveform.setTime(start, { scroll: false });
    const ytT = videoTimeFromWave(start);
    ytPlayer?.seekTo(ytT, true);
    lastYtPollT = ytT;
  }
}
const REF_PLAY_BTN_LABEL = "▶ 再生";
const REF_PAUSE_BTN_LABEL = "⏸ 一時停止";
const ADR_COUNTDOWN_SEC = 3;
/** @type {AbortController|null} */
let adrSessionAbort = null;
/** プレロール中の参照再生（isPlaying とは別管理） */
let adrReferencePlaying = false;
/** 台本と別に指定した収録スタート（秒・動画／台本タイムライン基準） */
const recordStartByLineId = new Map();
/** タイムライン上の Take クリップ表示位置（秒・台本基準） */
const takeClipPositionByLineId = new Map();
/** @type {string|null} */
let concatObjectUrl = null;
/** @type {Blob|null} */
let lastConcatBlob = null;
/** @type {ReturnType<typeof setInterval>|null} */
let cueWatchId = null;
const SEEK_SLIDER_STEPS = 10000;
let suppressSeekSlider = false;
const BUG_REPORT_EMAIL = "support@wavrick.com";
/** @type {string|null} */
let loadedWaveVideoId = null;
/** 抽出音声のタイムラインを動画に対してずらす（秒）。+で波形が早く、-で遅く。 */
let audioOffsetSec = 0;
/** @type {"normal"|"mini"|"hidden"} */
let videoMode = "normal";
let suppressYtPoll = false;
/** ユーザーが ▶/⏸ で一時停止した直後、YT の PAUSED で波形位置が 0 に上書きされるのを防ぐ */
let refPauseGuardUntil = 0;
/** @type {ReturnType<typeof setInterval>|null} */
let ytPollId = null;
let lastYtPollT = 0;
/** 録音のため YouTube 同期を一時停止したか */
let ytPollPausedForMic = false;
/** 録音ボタン押下直後（Space 等で playFromCue が誤発火するのを防ぐ） */
let micRecordIntent = false;
/** @type {Promise<void>|null} */
let micStartJob = null;
/** @type {Promise<void>|null} */
let studioLoadJob = null;
/** ② の読込が差し替えられたときに古い処理を無視する */
let studioLoadGeneration = 0;
/** 直近の波形が AI ボーカル分離済みか */
let lastVocalSeparated = false;
/** ノイズ除去 ON/OFF: 保存済みの raw / cleaned 音声 URL */
let referenceAudioRawUrl = null;
let referenceAudioCleanedUrl = null;
let noiseRemovalActive = false;
/** @type {TakeEditPreview|null} */
let takeEditPreview = null;
/** @type {Blob|null} */
let takeEditPreviewBlob = null;
/** @type {string|null} */
let boothSessionLineId = null;
/** ブース内で ● 録音 を押したあと 3-2-1 ボタンを表示する */
let boothShowCountdown = false;
/** @type {LiveMicWaveform|null} */
let liveMicWaveform = null;
/** @type {Map<string, number>} lineId → 波形読込開始時の Take index */
const pendingTakeWaveIndex = new Map();
/** @type {string|null} */
let lastCloudSavedAt = null;
let cloudSaveInFlight = false;
/** @type {string} */
let workspaceProjectId = projectIdFromRequest(null);
/** @type {string|null} */
let workspaceRequestId = null;
/** @type {CueRetakeStore|null} */
let cueRetakeStore = null;

function takePreviewUrlKey(lineId, takeIndex) {
  return `rw-take-preview:${lineId}:${takeIndex}`;
}

/** クリック直後（await 前）に getUserMedia を開始 — Chrome で必須 */
function requestMicStreamInUserGesture() {
  if (!navigator.mediaDevices?.getUserMedia) {
    return Promise.reject(
      new Error("このブラウザはマイク録音に対応していません。")
    );
  }
  return navigator.mediaDevices.getUserMedia({ audio: true });
}
const VIDEO_MODE_KEY = "wavrick_rw_video_mode";

function setStatus(message, type = "info") {
  if (!els.status) return;
  els.status.textContent = message;
  els.status.dataset.type = type;
}

function updateVocalBadge() {
  const badge = els.vocalBadge;
  if (!badge) return;
  badge.removeAttribute("hidden");
  badge.style.display = "inline-block";
  if (!waveform?.ready) {
    badge.textContent = "ボーカル分離: 未取得";
    badge.dataset.state = "pending";
    return;
  }
  badge.textContent = lastVocalSeparated ? "ボーカル分離: ON" : "ボーカル分離: OFF";
  badge.dataset.state = lastVocalSeparated ? "on" : "off";
}

/** いずれかのセリフを録音中か */
function isMicCaptureActive() {
  return scriptLines.some((l) => lineRecorder.isRecording(l.id));
}

/** 録音開始前: 参照音声の再生だけ止める（muted にしない） */
function pauseReferencePlaybackForMic() {
  clearCueWatch();
  isPlaying = false;
  suppressYtPoll = true;
  ytPlayer?.pause();
  waveform?.pause();
  els.takePreview?.pause();
  if (els.playPauseBtn) els.playPauseBtn.textContent = REF_PLAY_BTN_LABEL;
  if (ytPollId) {
    stopYtPoll();
    ytPollPausedForMic = true;
  }
}

/** 録音終了後: 波形のミュート解除 + YouTube 同期を再開 */
function restoreReferencePlayback() {
  suppressYtPoll = false;
  const media = waveform?.ws?.getMediaElement?.();
  if (media) {
    media.muted = false;
    media.volume = 1;
  }
  if (ytPollPausedForMic && ytPlayer?.ready) {
    startYtPoll();
    ytPollPausedForMic = false;
  }
}

function revokeAudioUrl() {
  if (audioObjectUrl) {
    URL.revokeObjectURL(audioObjectUrl);
    audioObjectUrl = null;
  }
}

function updateTimeDisplay(seconds) {
  if (!els.timeDisplay) return;
  const dur = ytPlayer?.getDuration() || waveform?.getDuration() || 0;
  els.timeDisplay.textContent = `${formatTimecode(seconds)} / ${formatTimecode(dur)}`;
  syncMultitrackSeekSlider(seconds, dur);
}

function syncMultitrackSeekSlider(videoSec, durOverride) {
  if (!els.multitrackSeek || suppressSeekSlider) return;
  const dur = durOverride ?? ytPlayer?.getDuration() ?? waveform?.getDuration() ?? 0;
  if (dur <= 0 || !waveform?.ready) {
    els.multitrackSeekBar?.setAttribute("hidden", "");
    return;
  }
  els.multitrackSeekBar?.removeAttribute("hidden");
  const t = Math.max(0, Math.min(videoSec, dur));
  els.multitrackSeek.value = String(Math.round((t / dur) * SEEK_SLIDER_STEPS));
  if (els.seekTc) els.seekTc.textContent = formatTimecode(t);
  if (els.seekDuration) els.seekDuration.textContent = formatTimecode(dur);
}

function onMultitrackSeekInput() {
  const dur = ytPlayer?.getDuration() || waveform?.getDuration() || 0;
  if (dur <= 0 || !els.multitrackSeek) return;
  const frac = Number(els.multitrackSeek.value) / SEEK_SLIDER_STEPS;
  const ytT = frac * dur;
  suppressSeekSlider = true;
  seekBoth(ytT);
  suppressSeekSlider = false;
}

function getSessionAccount() {
  try {
    const session = JSON.parse(localStorage.getItem("wavrick_session") || "null");
    if (session?.email) {
      return {
        email: session.email,
        displayName: session.displayName || session.name || session.email,
        role: session.role || "voice"
      };
    }
  } catch {
    /* ignore */
  }
  try {
    const voice = JSON.parse(localStorage.getItem("wavrick_voice_accounts") || "[]");
    const row = voice[0];
    if (row?.email) {
      return {
        email: row.email,
        displayName: row.displayName || row.name || row.email,
        role: "voice"
      };
    }
  } catch {
    /* ignore */
  }
  return null;
}

function refreshAccountPanel() {
  if (!els.accountSummary) return;
  const acc = getSessionAccount();
  if (!acc) {
    els.accountSummary.textContent =
      "未ログインです。トップページから声優ログインしてください。";
    return;
  }
  const roleLabel = acc.role === "customer" ? "クライアント" : "声優";
  els.accountSummary.textContent = `${acc.displayName}（${roleLabel}）\n${acc.email}`;
}

function buildBugReportBody() {
  const text = (els.bugReportText?.value || "").trim();
  const contact = (els.bugReportEmail?.value || getSessionAccount()?.email || "").trim();
  const acc = getSessionAccount();
  return [
    "【WAVRICK 収録ブース バグ報告】",
    "",
    text || "（内容未入力）",
    "",
    "---",
    `連絡先: ${contact || "未記入"}`,
    `アカウント: ${acc ? `${acc.displayName} <${acc.email}>` : "未ログイン"}`,
    `URL: ${location.href}`,
    `ブラウザ: ${navigator.userAgent}`,
    `日時: ${new Date().toISOString()}`
  ].join("\n");
}

function closeAllTopbarPanels(except) {
  document.querySelectorAll(".rw-topbar-panel").forEach((panel) => {
    if (except && panel === except) return;
    panel.removeAttribute("open");
  });
  const portal = document.getElementById("rwPanelPortal");
  if (portal) portal.innerHTML = "";
  const backdrop = document.getElementById("rwPanelBackdrop");
  if (backdrop) backdrop.hidden = true;
}

function portalPanelBody(panel) {
  let portal = document.getElementById("rwPanelPortal");
  if (!portal) {
    portal = document.createElement("div");
    portal.id = "rwPanelPortal";
    document.body.appendChild(portal);
  }
  let backdrop = document.getElementById("rwPanelBackdrop");
  if (!backdrop) {
    backdrop = document.createElement("div");
    backdrop.id = "rwPanelBackdrop";
    backdrop.className = "rw-panel-backdrop";
    backdrop.addEventListener("pointerdown", () => closeAllTopbarPanels());
    document.body.appendChild(backdrop);
  }
  portal.innerHTML = "";
  const body = panel.querySelector(".rw-topbar-panel-body");
  if (body) {
    const clone = body.cloneNode(true);
    clone.style.display = "block";
    portal.appendChild(clone);
    backdrop.hidden = false;
  }
}

function bindTopbarPanels() {
  refreshAccountPanel();
  renderTrashPanel();
  updateSavePanelStatus();

  document.addEventListener(
    "pointerdown",
    (ev) => {
      const target = ev.target;
      if (!(target instanceof Node)) return;
      if (target.closest?.(".rw-topbar-panel")) return;
      if (target.closest?.("#rwPanelPortal")) return;
      if (target.id === "rwPanelBackdrop") return;
      closeAllTopbarPanels();
    },
    true
  );

  document.querySelectorAll(".rw-topbar-panel").forEach((panel) => {
    panel.addEventListener("toggle", () => {
      if (panel.open) {
        closeAllTopbarPanels(panel);
        if (panel.id === "rwTrashPanel") renderTrashPanel();
        if (panel.id === "rwRetakePanel") renderRetakePanel();
        if (panel.id === "rwSavePanel") updateSavePanelStatus();
        portalPanelBody(panel);
      } else {
        const portal = document.getElementById("rwPanelPortal");
        if (portal) portal.innerHTML = "";
        const backdrop = document.getElementById("rwPanelBackdrop");
        if (backdrop) backdrop.hidden = true;
      }
    });
  });

  els.bugReportCopyBtn?.addEventListener("click", async () => {
    const body = buildBugReportBody();
    try {
      await navigator.clipboard.writeText(body);
      setStatus("バグ報告の内容をクリップボードにコピーしました。", "ok");
    } catch {
      setStatus("コピーに失敗しました。内容を手動で選択してください。", "err");
    }
  });
  els.bugReportSendBtn?.addEventListener("click", () => {
    const body = buildBugReportBody();
    const contact = (els.bugReportEmail?.value || getSessionAccount()?.email || "").trim();
    const subject = encodeURIComponent("WAVRICK 収録ブース バグ報告");
    const mailBody = encodeURIComponent(body);
    const mailto = `mailto:${BUG_REPORT_EMAIL}?subject=${subject}&body=${mailBody}`;
    window.location.href = mailto;
    setStatus("メールアプリを開きました。送信できない場合は「内容をコピー」を使ってください。", "info");
  });
  els.multitrackSeek?.addEventListener("input", onMultitrackSeekInput);
  els.multitrackSeek?.addEventListener("change", onMultitrackSeekInput);

  els.saveBtn?.addEventListener("click", () => void saveWorkspaceToAccount());
  els.loadSaveBtn?.addEventListener("click", () =>
    void tryRestoreWorkspaceFromCloud({ quiet: false })
  );
  els.trashList?.addEventListener("click", onTrashListClick);

  els.retakeNextBtn?.addEventListener("click", () => jumpToNextRetakeCue());
  els.retakeSimulateBtn?.addEventListener("click", () => simulateCustomerRetakeForFocusedLine());
  els.retakeList?.addEventListener("click", onRetakeListClick);
}

function initCueRetakeForProject(projectId, { requestId = null, batch = null } = {}) {
  workspaceProjectId = projectId || projectIdFromRequest(requestId);
  workspaceRequestId = requestId;
  cueRetakeStore = new CueRetakeStore(workspaceProjectId, {
    requestId,
    batch: batch || CueRetakeStore.loadLocal(workspaceProjectId)
  });
  syncRetakeUi();
  syncActiveCaseUi();
}

function syncRetakeUi() {
  const pending = cueRetakeStore?.getPendingCueIds() ?? new Set();
  const count = cueRetakeStore?.getPendingCount() ?? 0;

  if (els.retakeBanner) {
    els.retakeBanner.hidden = count === 0;
  }
  if (els.retakeCount) els.retakeCount.textContent = String(count);
  document.body.classList.toggle("rw-has-retake-cues", count > 0);

  waveform?.setRetakeCueIds?.(pending);
  renderRetakePanel();
  renderScriptList();
  renderSessionFlow();
}

function renderRetakePanel() {
  if (!els.retakeList || !cueRetakeStore) return;
  const open = cueRetakeStore.getOpenRequests();
  els.retakeList.innerHTML = open.length
    ? open
        .map((req) => {
          const lineNum =
            req.cueSnapshot?.lineIndex != null
              ? req.cueSnapshot.lineIndex + 1
              : getScriptLineNum(req.cueId);
          const note = req.note
            ? `<p class="rw-retake-note">${escapeHtml(req.note)}</p>`
            : "";
          return `<li class="rw-retake-item" data-cue-id="${escapeAttr(req.cueId)}">
            <div class="rw-retake-item-head">
              <strong>音声 ${lineNum}</strong>
              <span class="rw-retake-badge">要修正</span>
            </div>
            <p class="rw-retake-cue-text">${escapeHtml(req.cueSnapshot?.text || "")}</p>
            ${note}
            <button type="button" class="rw-btn rw-btn-ghost rw-retake-jump-btn" data-jump-cue="${escapeAttr(req.cueId)}">この枠へ</button>
          </li>`;
        })
        .join("")
    : `<li class="rw-retake-empty">差し戻し中の枠はありません。</li>`;
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/`/g, "&#096;");
}

function jumpToCueId(cueId) {
  const idx = scriptLines.findIndex((l) => l.id === cueId);
  if (idx < 0) {
    setStatus("指定された目安枠が台本に見つかりません。", "err");
    return;
  }
  cueRetakeStore?.markCueInProgress(cueId);
  cueRetakeStore?.persistLocal();
  setFocusedLineIndex(idx, { seek: true });
  syncRetakeUi();
  setStatus(`要修正の枠（音声 ${idx + 1}）へ移動しました。収録ブースから録り直せます。`, "info");
}

function jumpToNextRetakeCue() {
  const cueId = cueRetakeStore?.findNextOpenCueId(scriptLines, lineRecorder);
  if (!cueId) {
    setStatus("要修正の枠はありません。", "info");
    return;
  }
  jumpToCueId(cueId);
}

function onRetakeListClick(ev) {
  const btn = ev.target.closest("[data-jump-cue]");
  if (!btn) return;
  const cueId = btn.getAttribute("data-jump-cue");
  if (cueId) jumpToCueId(cueId);
}

/** 開発用: フォーカス中の枠に顧客差し戻しを模擬 */
function simulateCustomerRetakeForFocusedLine() {
  const line = getFocusedLine();
  if (!line || !cueRetakeStore) {
    setStatus("台本の行を選んでから実行してください。", "err");
    return;
  }
  const note =
    window.prompt(
      "顧客からの修正メモ（例: 語尾が硬い / もう少し早口で）",
      "イントネーションを柔らかく"
    ) || "";
  const idx = scriptLines.findIndex((l) => l.id === line.id);
  const added = cueRetakeStore.ingestCustomerRequests(
    [
      {
        cueId: line.id,
        note,
        cueSnapshot: cueSnapshotFromLine(line, idx)
      }
    ],
    { requestedBy: "customer-demo", deliveryId: "delivery-demo" }
  );
  cueRetakeStore.persistLocal();
  syncRetakeUi();
  setStatus(
    added
      ? `音声 ${idx + 1} を「要修正」にしました（顧客差し戻しの模擬）。`
      : "この枠はすでに要修正です。",
    added ? "ok" : "info"
  );
}

function updateSavePanelStatus() {
  if (!els.saveStatus) return;
  const acc = getSessionAccount();
  if (!acc) {
    els.saveStatus.textContent =
      "未ログインです。トップでログインすると、別の PC からも同じ状態を復元できます。";
    if (els.saveBtn) els.saveBtn.disabled = true;
    return;
  }
  if (els.saveBtn) els.saveBtn.disabled = cloudSaveInFlight;
  const cloudOk = isCloudSaveAvailable();
  const when = lastCloudSavedAt
    ? new Date(lastCloudSavedAt).toLocaleString("ja-JP")
    : "まだ保存していません";
  els.saveStatus.textContent = cloudOk
    ? `${acc.email}\n最終保存: ${when}\n保存すると台本・Take・編集・ゴミ箱までアカウントに同期されます。② の波形は URL を保存するため、復元後に「② 読込」が必要な場合があります。`
    : `${acc.email}\nSupabase 未設定のためクラウド保存できません（index.html の WAVRICK_CONFIG を確認）。\n最終保存: ${when}`;
}

function buildWorkspaceSnapshot() {
  const lines = {};
  for (const line of scriptLines) {
    const takes = lineRecorder.getTakes(line.id);
    lines[line.id] = {
      activeIndex: lineRecorder.getActiveTakeIndex(line.id),
      takes: takes.map((t) => ({
        id: t.id,
        label: t.label,
        status: t.status,
        durationSec: t.durationSec,
        size: t.size,
        edit: t.edit,
        editDraft: t.editDraft,
        mimeType: t.blob?.type || "audio/webm"
      }))
    };
  }
  const trash = lineRecorder.getTrash().map((e) => ({
    id: e.id,
    lineId: e.lineId,
    originalIndex: e.originalIndex,
    deletedAt: e.deletedAt,
    take: {
      id: e.take.id,
      label: e.take.label,
      status: e.take.status,
      durationSec: e.take.durationSec,
      size: e.take.size,
      edit: e.take.edit,
      editDraft: e.take.editDraft,
      mimeType: e.take.blob?.type || "audio/webm"
    }
  }));

  return {
    version: 2,
    savedAt: new Date().toISOString(),
    projectId: workspaceProjectId,
    requestId: workspaceRequestId,
    retakeBatch: cueRetakeStore?.toJSON() ?? null,
    youtubeUrl: els.ytUrl?.value?.trim() || "",
    proxyUrl: els.proxyUrl?.value?.trim() || "",
    proxySecret: els.proxySecret?.value?.trim() || "",
    audioOffsetSec,
    preRollSec,
    holdToRecordOn,
    countdownBeepsOn,
    autoRecordAtCue,
    videoMode: els.videoPanel?.dataset?.mode || localStorage.getItem(VIDEO_MODE_KEY) || "",
    workspaceFeatures: { ...workspaceFeatures },
    focusedLineIndex,
    activeLineId,
    scriptLines,
    recordStartByLineId: Object.fromEntries(recordStartByLineId),
    takeClipPositionByLineId: Object.fromEntries(takeClipPositionByLineId),
    lines,
    trash
  };
}

function collectTakeBlobsForSave() {
  const map = new Map();
  const add = (take) => {
    if (take?.id && take.blob?.size > 0 && !map.has(take.id)) {
      map.set(take.id, take.blob);
    }
  };
  for (const line of scriptLines) {
    for (const t of lineRecorder.getTakes(line.id)) add(t);
  }
  for (const e of lineRecorder.getTrash()) add(e.take);
  return map;
}

async function saveWorkspaceToAccount() {
  const acc = getSessionAccount();
  if (!acc) {
    setStatus("保存するにはトップページでログインしてください。", "err");
    return;
  }
  if (!isCloudSaveAvailable()) {
    setStatus("Supabase が未設定のためクラウド保存できません。", "err");
    updateSavePanelStatus();
    return;
  }
  if (cloudSaveInFlight) return;
  cloudSaveInFlight = true;
  if (els.saveBtn) els.saveBtn.disabled = true;
  setStatus("アカウントに保存中…（Take 音声をアップロードしています）", "info");

  try {
    cueRetakeStore?.persistLocal();
    const manifest = buildWorkspaceSnapshot();
    const takeBlobs = collectTakeBlobsForSave();
    const result = await saveWorkspaceToCloud(acc.email, manifest, takeBlobs);
    lastCloudSavedAt = result.savedAt;
    updateSavePanelStatus();
    setStatus(
      `保存しました（Take ${result.takeCount} 件）。別の PC で同じアカウントにログインすると復元できます。`,
      "ok"
    );
  } catch (err) {
    setStatus(
      `保存に失敗: ${err instanceof Error ? err.message : String(err)}`,
      "err"
    );
  } finally {
    cloudSaveInFlight = false;
    if (els.saveBtn) els.saveBtn.disabled = !getSessionAccount();
    updateSavePanelStatus();
  }
}

async function applyWorkspaceSnapshot(manifest, takeBlobs) {
  stopAll();
  lineRecorder.clearAllTakes();

  scriptLines = Array.isArray(manifest.scriptLines)
    ? manifest.scriptLines.map((l) => ({ ...l }))
    : [];
  if (els.scriptEditor && scriptLines.length) {
    els.scriptEditor.value = scriptLinesToText(scriptLines);
  }

  recordStartByLineId.clear();
  if (manifest.recordStartByLineId) {
    for (const [k, v] of Object.entries(manifest.recordStartByLineId)) {
      recordStartByLineId.set(k, Number(v));
    }
  }
  takeClipPositionByLineId.clear();
  if (manifest.takeClipPositionByLineId) {
    for (const [k, v] of Object.entries(manifest.takeClipPositionByLineId)) {
      takeClipPositionByLineId.set(k, Number(v));
    }
  }

  preRollSec = Math.max(0, Number(manifest.preRollSec) || 0);
  if (els.preRoll) els.preRoll.value = String(preRollSec);
  audioOffsetSec = Number(manifest.audioOffsetSec) || 0;
  if (els.audioOffset) els.audioOffset.value = String(audioOffsetSec);
  holdToRecordOn = Boolean(manifest.holdToRecordOn);
  if (els.holdToRecord) els.holdToRecord.checked = holdToRecordOn;
  countdownBeepsOn = manifest.countdownBeepsOn !== false;
  if (els.countdownBeeps) els.countdownBeeps.checked = countdownBeepsOn;
  autoRecordAtCue = Boolean(manifest.autoRecordAtCue);
  if (els.autoRecordAtCue) els.autoRecordAtCue.checked = autoRecordAtCue;

  if (manifest.workspaceFeatures) {
    workspaceFeatures = { ...workspaceFeatures, ...manifest.workspaceFeatures };
    for (const [id, on] of Object.entries(manifest.workspaceFeatures)) {
      saveWorkspaceFeature(id, Boolean(on));
    }
    applyWorkspaceFeatureUi();
  }

  if (manifest.youtubeUrl && els.ytUrl) els.ytUrl.value = manifest.youtubeUrl;
  if (manifest.proxyUrl && els.proxyUrl) els.proxyUrl.value = manifest.proxyUrl;
  if (manifest.proxySecret && els.proxySecret) {
    els.proxySecret.value = manifest.proxySecret;
  }

  const linePacks = manifest.lines || {};
  for (const line of scriptLines) {
    const pack = linePacks[line.id];
    if (!pack?.takes?.length) continue;
    for (const meta of pack.takes) {
      const blob = takeBlobs.get(meta.id);
      if (!blob) continue;
      lineRecorder.importTake(line.id, meta, blob);
    }
    const state = lineRecorder.getLineState(line.id);
    if (state.takes.length && pack.activeIndex != null) {
      lineRecorder.setActiveTake(line.id, Math.min(pack.activeIndex, state.takes.length - 1));
    }
  }

  lineRecorder.setTrash(
    (manifest.trash || [])
      .map((e) => {
        const blob = takeBlobs.get(e.take?.id);
        let take = e.take;
        if (blob && take) {
          const url = URL.createObjectURL(blob);
          take = {
            ...take,
            url,
            blob,
            edit: normalizeTakeEdit(take.edit, take.durationSec ?? 0),
            editDraft: normalizeTakeEdit(take.editDraft, take.durationSec ?? 0)
          };
        }
        return { ...e, take };
      })
      .filter((e) => e.take?.blob && e.take?.url)
  );

  focusedLineIndex = Math.min(
    Math.max(0, Number(manifest.focusedLineIndex) || 0),
    Math.max(0, scriptLines.length - 1)
  );
  activeLineId = manifest.activeLineId || scriptLines[focusedLineIndex]?.id || null;
  lastCloudSavedAt = manifest.savedAt || null;

  initCueRetakeForProject(
    manifest.projectId || projectIdFromRequest(manifest.requestId),
    {
      requestId: manifest.requestId || null,
      batch: manifest.retakeBatch || null
    }
  );

  refreshScriptUiAfterLinesChange();
  renderTrashPanel();
  updateSavePanelStatus();

  if (waveform?.ready) {
    for (const line of scriptLines) {
      if (!lineRecorder.hasRecording(line.id)) continue;
      const idx = lineRecorder.getActiveTakeIndex(line.id);
      const take = lineRecorder.getTakes(line.id)[idx];
      if (take?.blob) {
        await waveform.setTakeForLine(line.id, take.blob, {
          positionSec: getTakeClipPositionSec(line) + audioOffsetSec,
          lineNum: getScriptLineNum(line.id),
          edit: lineRecorder.getTakeEdit(line.id, idx)
        });
      }
    }
  }
  syncRetakeUi();
}

async function tryRestoreWorkspaceFromCloud({ quiet = false } = {}) {
  const acc = getSessionAccount();
  if (!acc || !isCloudSaveAvailable()) return false;

  try {
    const loaded = await loadWorkspaceFromCloud(acc.email);
    if (!loaded?.manifest) return false;

    const hasTakes =
      Object.values(loaded.manifest.lines || {}).some((p) => p?.takes?.length) ||
      (loaded.manifest.trash || []).length > 0;
    const hasScript = (loaded.manifest.scriptLines || []).length > 0;
    if (!hasTakes && !hasScript) return false;

    if (!quiet) {
      const when = loaded.manifest.savedAt
        ? new Date(loaded.manifest.savedAt).toLocaleString("ja-JP")
        : "不明";
      const ok = window.confirm(
        `${acc.email} の保存データ（${when}）を復元しますか？\n現在の未保存の変更は上書きされます。`
      );
      if (!ok) return false;
    }

    await applyWorkspaceSnapshot(loaded.manifest, loaded.takeBlobs);
    if (!quiet) {
      setStatus("クラウドから作業状態を復元しました。② の波形が必要なら読込してください。", "ok");
    }
    return true;
  } catch (err) {
    if (!quiet) {
      setStatus(
        `復元に失敗: ${err instanceof Error ? err.message : String(err)}`,
        "err"
      );
    }
    return false;
  }
}

function renderTrashPanel() {
  if (!els.trashList) return;
  const entries = lineRecorder.getTrash();
  if (els.trashEmpty) els.trashEmpty.hidden = entries.length > 0;
  els.trashList.innerHTML = "";

  for (const entry of entries.slice().reverse()) {
    const lineNum = getScriptLineNum(entry.lineId);
    const label =
      entry.take?.label?.trim() ||
      `Take ${entry.originalIndex + 1}`;
    const li = document.createElement("li");
    li.className = "rw-trash-item";
    li.dataset.trashId = entry.id;
    const when = entry.deletedAt
      ? new Date(entry.deletedAt).toLocaleString("ja-JP", {
          month: "numeric",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit"
        })
      : "";
    li.innerHTML = `
      <div class="rw-trash-item-main">
        <strong>音声 ${lineNum}</strong>
        <span>${label}</span>
        <span class="rw-trash-when">${when}</span>
      </div>
      <div class="rw-trash-item-actions">
        <button type="button" class="rw-btn rw-btn-ghost" data-restore-trash="${entry.id}">復元</button>
        <button type="button" class="rw-btn rw-btn-ghost" data-purge-trash="${entry.id}">完全削除</button>
      </div>`;
    els.trashList.appendChild(li);
  }
}

function onTrashListClick(ev) {
  const restoreBtn = ev.target.closest("[data-restore-trash]");
  const purgeBtn = ev.target.closest("[data-purge-trash]");
  if (restoreBtn) {
    const id = restoreBtn.getAttribute("data-restore-trash");
    if (!id) return;
    const entry = lineRecorder.getTrash().find((e) => e.id === id);
    const lineId = entry?.lineId;
    if (lineRecorder.restoreFromTrash(id)) {
      renderTrashPanel();
      updateTakeUi();
      renderTakeDesk();
      void (async () => {
        const line = scriptLines.find((l) => l.id === lineId);
        if (line && waveform?.ready) {
          const idx = lineRecorder.getActiveTakeIndex(line.id);
          const take = lineRecorder.getTakes(line.id)[idx];
          if (take?.blob) {
            await waveform.setTakeForLine(line.id, take.blob, {
              positionSec: getTakeClipPositionSec(line) + audioOffsetSec,
              lineNum: getScriptLineNum(line.id),
              edit: lineRecorder.getTakeEdit(line.id, idx)
            });
          }
        }
        void syncTakeEditStudio();
      })();
      setStatus("ゴミ箱から Take を復元しました。", "ok");
    }
    return;
  }
  if (purgeBtn) {
    const id = purgeBtn.getAttribute("data-purge-trash");
    if (!id) return;
    if (!window.confirm("ゴミ箱から完全に削除しますか？元に戻せません。")) return;
    lineRecorder.purgeTrashEntry(id);
    renderTrashPanel();
    setStatus("ゴミ箱から完全に削除しました。", "ok");
  }
}

function getCurrentVideoId() {
  return extractYouTubeVideoId(els.ytUrl?.value?.trim() || DEFAULT_YOUTUBE_URL);
}

function waveTimeFromVideo(ytSec) {
  const dur = waveform?.getDuration() || 0;
  return Math.max(0, dur ? Math.min(dur, ytSec + audioOffsetSec) : ytSec + audioOffsetSec);
}

function checkDurationAlignment() {
  const ytDur = ytPlayer?.getDuration() || 0;
  const waveDur = waveform?.getDuration() || 0;
  if (ytDur < 1 || waveDur < 1) return "";
  const diff = Math.abs(ytDur - waveDur);
  if (diff > 3) {
    return `注意: 動画(${Math.round(ytDur)}秒)と抽出音声(${Math.round(waveDur)}秒)の長さが ${Math.round(diff)}秒 ずれています。別バージョンの音源の可能性があります。`;
  }
  if (diff > 0.5) {
    return `動画と抽出音声の長さが約 ${diff.toFixed(1)}秒 異なります。下の「音声ズレ」スライダーで合わせてください。`;
  }
  return "";
}

function seekBoth(seconds) {
  const t = Math.max(0, seconds);
  suppressYtPoll = true;
  ytPlayer?.seekTo(t, true);
  const waveT = waveTimeFromVideo(t);
  waveform?.setTime(waveT, { scroll: !isPlaying });
  const line = getFocusedLine();
  if (line && waveform?.ready) {
    waveform.focusScriptLine(line.id, line.startSec + audioOffsetSec, {
      seek: false,
      scroll: true
    });
  }
  lastYtPollT = t;
  updateTimeDisplay(t);
  highlightActiveLineByTime(t);
  requestAnimationFrame(() => {
    suppressYtPoll = false;
  });
}

function getFocusedLine() {
  return scriptLines[focusedLineIndex] || null;
}

/** 収録パンチイン位置（未指定なら台本の startSec） */
function getRecordStartSec(line) {
  if (!line) return 0;
  if (recordStartByLineId.has(line.id)) {
    return recordStartByLineId.get(line.id);
  }
  return line.startSec;
}

function isCustomRecordStart(line) {
  if (!line) return false;
  if (!recordStartByLineId.has(line.id)) return false;
  return Math.abs(getRecordStartSec(line) - line.startSec) > 0.08;
}

/** 下段に表示する Take クリップの位置（台本タイムライン秒） */
function getTakeClipPositionSec(line) {
  if (!line) return 0;
  if (takeClipPositionByLineId.has(line.id)) {
    return takeClipPositionByLineId.get(line.id);
  }
  return getRecordStartSec(line);
}

function onTakeClipMoved(lineId, positionSec) {
  const line = scriptLines.find((l) => l.id === lineId);
  takeClipPositionByLineId.set(lineId, Math.max(0, positionSec));
  if (waveform?.ready) {
    waveform.setClipPosition(lineId, positionSec + audioOffsetSec);
  }
  if (line) {
    setStatus(
      `Take の位置を ${formatTimecode(positionSec)} に移動しました（ドラッグで微調整できます）`,
      "ok"
    );
  }
}

/** @param {string} lineId @param {{ trimStartSec: number, trimEndSec: number, gain: number }} edit */
function onTakeClipEditFromWave(lineId, edit) {
  const idx = lineRecorder.getActiveTakeIndex(lineId);
  if (idx < 0) return;
  lineRecorder.setTakeEdit(lineId, idx, edit, { notify: false });
  lineRecorder.setTakeEditDraft(lineId, idx, edit);
  renderTakeEditor();
  lastConcatBlob = null;
}

function readTakeEditDraftFromPanel() {
  const line = getFocusedLine();
  if (!line) return null;
  const idx = lineRecorder.getActiveTakeIndex(line.id);
  if (idx < 0) return null;
  const take = lineRecorder.getActiveTake(line.id);
  const srcDur =
    take?.durationSec ?? takeEditPreview?.getSourceDurationSec() ?? 0;
  const gainPct = Number(els.takeGain?.value ?? 100);
  const trimStartSec = Number(els.takeTrimStart?.value ?? 0);
  const trimEndSec = Number(els.takeTrimEnd?.value ?? 0);
  return normalizeTakeEdit(
    {
      trimStartSec,
      trimEndSec,
      gain: gainPct / 100
    },
    srcDur
  );
}

function updateTakeEditPendingUi() {
  const line = getFocusedLine();
  const idx = line ? lineRecorder.getActiveTakeIndex(line.id) : -1;
  const pending =
    line && idx >= 0 && lineRecorder.hasUnappliedEditDraft(line.id, idx);
  if (els.takeEditorPending) els.takeEditorPending.hidden = !pending;
  if (els.takeEditApplyBtn) {
    els.takeEditApplyBtn.toggleAttribute("disabled", !pending);
  }
}

function updateTakeEditDraftFromPanel() {
  const line = getFocusedLine();
  if (!line) return;
  const idx = lineRecorder.getActiveTakeIndex(line.id);
  if (idx < 0) return;
  const edit = readTakeEditDraftFromPanel();
  if (!edit) return;
  lineRecorder.setTakeEditDraft(line.id, idx, edit);
  takeEditPreview?.setEdit(edit);
  updateTakeEditPanelLabels(edit);
  updateTakeEditPendingUi();
}

function updateTakeEditPanelLabels(edit) {
  const line = getFocusedLine();
  if (!line) return;
  const idx = lineRecorder.getActiveTakeIndex(line.id);
  const take = lineRecorder.getActiveTake(line.id);
  const srcDur =
    take?.durationSec ?? takeEditPreview?.getSourceDurationSec() ?? 0;
  const eff = getEffectiveTakeDurationSec(srcDur, edit);
  if (els.takeGainVal) {
    els.takeGainVal.textContent = `${Math.round(edit.gain * 100)}%`;
  }
  if (els.takeTrimStartVal) {
    els.takeTrimStartVal.textContent = `${edit.trimStartSec.toFixed(2)}s`;
  }
  if (els.takeTrimEndVal) {
    els.takeTrimEndVal.textContent = `${edit.trimEndSec.toFixed(2)}s`;
  }
  if (els.takeEditorDur) {
    els.takeEditorDur.textContent = srcDur
      ? `有効な長さ: ${eff.toFixed(2)}s（元 ${srcDur.toFixed(2)}s）`
      : "有効な長さ: 波形読込後に表示";
  }
}

async function syncTakeEditStudio() {
  const panel = els.takeEditor;
  const line = getFocusedLine();
  if (!panel) return;

  const take = line ? lineRecorder.getActiveTake(line.id) : null;
  const idx = line ? lineRecorder.getActiveTakeIndex(line.id) : -1;
  const active = Boolean(line && take && idx >= 0);
  document.body.classList.toggle("rw-take-edit-active", active && !panel.hidden);

  if (!active) {
    panel.hidden = true;
    takeEditPreview?.destroy();
    takeEditPreview = null;
    takeEditPreviewBlob = null;
    document.body.classList.remove("rw-take-edit-active");
    return;
  }

  panel.hidden = false;

  if (els.takeEditorMeta) {
    const n = getScriptLineNum(line.id);
    els.takeEditorMeta.textContent = `音声 ${n} — ${line.text.slice(0, 48)}${line.text.length > 48 ? "…" : ""}`;
  }

  if (els.takeEditWaveHost) {
    if (!takeEditPreview) {
      takeEditPreview = new TakeEditPreview(els.takeEditWaveHost);
    }
    if (takeEditPreviewBlob !== take.blob) {
      await takeEditPreview.load(take.blob);
      takeEditPreviewBlob = take.blob;
      const dur = takeEditPreview.getSourceDurationSec();
      if (dur > 0) lineRecorder.setTakeDuration(line.id, idx, dur);
    }
    const draft = lineRecorder.getTakeEditDraft(line.id, idx);
    takeEditPreview.setEdit(draft);
  }

  const srcDur =
    take.durationSec ?? takeEditPreview?.getSourceDurationSec() ?? 0;
  const draft = lineRecorder.getTakeEditDraft(line.id, idx);
  if (els.takeGain) {
    els.takeGain.value = String(Math.round(draft.gain * 100));
  }
  if (els.takeTrimStart) {
    els.takeTrimStart.max = String(Math.max(0, srcDur - MIN_TAKE_CLIP_SEC));
    els.takeTrimStart.value = String(draft.trimStartSec);
  }
  if (els.takeTrimEnd) {
    els.takeTrimEnd.max = String(Math.max(0, srcDur - MIN_TAKE_CLIP_SEC));
    els.takeTrimEnd.value = String(draft.trimEndSec);
  }
  updateTakeEditPanelLabels(draft);
  updateTakeEditPendingUi();
  syncTakePreviewPlayer(line.id);
}

function selectTakeForEditing(lineId, takeIndex) {
  const lineIdx = scriptLines.findIndex((l) => l.id === lineId);
  if (lineIdx < 0) return;
  setFocusedLineIndex(lineIdx, { seek: false });
  const line = scriptLines[lineIdx];
  if (takeIndex != null && takeIndex >= 0) {
    lineRecorder.setActiveTake(lineId, takeIndex);
    void reloadActiveTakeWave(lineId, lineRecorder.getTakes(lineId)[takeIndex]?.blob);
  }
  syncTakePreviewPlayer(lineId);
  void syncTakeEditStudio();
  renderTakeDesk();
  els.takeEditor?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  const idx = lineRecorder.getActiveTakeIndex(lineId);
  setStatus(
    `${lineRecorder.getTakeLabel(lineId, idx)} を編集対象にしました（下の試聴プレイヤーで確認）`,
    "ok"
  );
}

function renderTakeEditor() {
  void syncTakeEditStudio();
}

function applyTakeEditsFromPanel() {
  const line = getFocusedLine();
  if (!line) return;
  const idx = lineRecorder.getActiveTakeIndex(line.id);
  if (idx < 0) return;
  const edit = readTakeEditDraftFromPanel();
  if (!edit) return;

  lineRecorder.setTakeEditDraft(line.id, idx, edit);
  lineRecorder.applyTakeEditDraft(line.id, idx, { notify: false });
  lastConcatBlob = null;

  if (waveform?.ready) {
    waveform.setClipEdit(line.id, edit);
  }
  updateTakeEditPendingUi();
  setStatus(
    `音声 ${getScriptLineNum(line.id)} の編集を適用しました（②・全編試聴に反映）`,
    "ok"
  );
}

function renderTakeDesk() {
  const line = getFocusedLine();
  const host = els.takeCards;
  const empty = els.takeCardsEmpty;
  if (!host) return;

  if (!line) {
    host.innerHTML = "";
    if (empty) {
      empty.hidden = false;
      empty.textContent = "セリフを選ぶと Take が表示されます。";
    }
    if (els.takeDeskHint) els.takeDeskHint.textContent = "—";
    renderTakeEditor();
    return;
  }

  const takes = lineRecorder.getTakes(line.id);
  const activeIdx = lineRecorder.getActiveTakeIndex(line.id);

  if (els.takeDeskHint) {
    els.takeDeskHint.textContent =
      takes.length > 0
        ? `${lineRecorder.getTakeLabel(line.id, activeIdx)}（${activeIdx + 1}/${takes.length}）`
        : "録音すると Take が並びます";
  }

  if (!takes.length) {
    host.innerHTML = "";
    if (empty) {
      empty.hidden = false;
      empty.textContent = "まだ Take がありません。下の「収録ブースを開く」から追加。";
    }
    renderTakeEditor();
    return;
  }

  if (empty) empty.hidden = true;

  host.innerHTML = takes
    .map((take, i) => {
      const active = i === activeIdx;
      const kb = Math.max(1, Math.round(take.size / 1024));
      const defaultName = `Take ${i + 1}`;
      const displayName = lineRecorder.getTakeLabel(line.id, i);
      const customLabel = (take.label || "").trim();
      const st = take.status ? ` rw-take-status--${take.status}` : "";
      return `
        <article class="rw-take-card${active ? " is-active" : ""}${st}" role="listitem" data-take-index="${i}">
          <div class="rw-take-card-main">
            <input
              type="text"
              class="rw-take-card-name"
              data-rename-take="${i}"
              value="${escapeHtml(displayName)}"
              placeholder="${defaultName}"
              maxlength="48"
              aria-label="Take 名"
            />
            ${active ? '<span class="rw-take-card-badge">採用</span>' : ""}
            <button type="button" class="rw-take-card-select" data-select-take="${i}" title="この Take を採用">採用</button>
          </div>
          <span class="rw-take-card-meta">${kb} KB</span>
          <div class="rw-take-card-actions">
            <button type="button" class="rw-take-card-play" data-play-take="${i}" title="試聴">▶</button>
            <button type="button" class="rw-take-card-del" data-del-take="${i}" title="削除">✕</button>
          </div>
        </article>
      `;
    })
    .join("");
  renderTakeEditor();
}

function getMixTimelineDurationSec() {
  const waveDur = waveform?.getDuration() || 0;
  if (waveDur > 0) return waveDur;
  const ytDur = ytPlayer?.getDuration() || 0;
  let maxEnd = ytDur;
  for (const line of scriptLines) {
    const end = line.endSec ?? line.startSec + 4;
    maxEnd = Math.max(maxEnd, end, getTakeClipPositionSec(line) + 4);
    const take = lineRecorder.getActiveTake(line.id);
    if (take?.durationSec) {
      const edit = lineRecorder.getTakeEdit(
        line.id,
        lineRecorder.getActiveTakeIndex(line.id)
      );
      maxEnd = Math.max(
        maxEnd,
        getTakeClipPositionSec(line) +
          getEffectiveTakeDurationSec(take.durationSec, edit)
      );
    }
  }
  return Math.max(maxEnd, 30);
}

function syncPunchInUi() {
  const line = getFocusedLine();
  if (!line) {
    if (els.punchTime) els.punchTime.textContent = "—";
    if (els.punchScriptHint) els.punchScriptHint.textContent = "台本目安: —";
    return;
  }
  const recStart = getRecordStartSec(line);
  const custom = isCustomRecordStart(line);
  if (els.punchTime) {
    els.punchTime.textContent = formatTimecode(recStart);
    els.punchTime.classList.toggle("is-custom", custom);
  }
  if (els.punchScriptHint) {
    els.punchScriptHint.textContent = custom
      ? `台本目安: ${formatTimecode(line.startSec)}（ずらして指定中）`
      : `台本目安: ${formatTimecode(line.startSec)}`;
  }
}

function syncPunchInMarkers() {
  if (!waveform?.ready) return;
  const m = new Map();
  for (const line of scriptLines) {
    m.set(line.id, getRecordStartSec(line) + audioOffsetSec);
  }
  waveform.setPunchInMarkers(m);
}

function setPunchInFromPlayhead() {
  const line = getFocusedLine();
  if (!line) {
    setStatus("セリフを選んでからスタート位置を指定してください。", "err");
    return;
  }
  const t = getScriptTimelineSec();
  recordStartByLineId.set(line.id, t);
  syncPunchInUi();
  syncPunchInMarkers();
  setStatus(
    `収録スタートを ${formatTimecode(t)} に設定しました（● 録音はここからパンチイン）`,
    "ok"
  );
}

function resetPunchInToScript() {
  const line = getFocusedLine();
  if (!line) return;
  recordStartByLineId.delete(line.id);
  syncPunchInUi();
  syncPunchInMarkers();
  setStatus(`収録スタートを台本の ${formatTimecode(line.startSec)} に戻しました。`, "ok");
}

function jumpToRecordStart(line, { play = false } = {}) {
  const target = line || getFocusedLine();
  if (!target) return;
  const sec = Math.max(0, getRecordStartSec(target) - preRollSec);
  if (play && (isPlaying || waveform?.isPlayingNow?.())) {
    pauseReferencePlayback();
  }
  refPauseGuardUntil = 0;
  seekBoth(sec);
  if (play && waveform?.ready) void togglePlayPause();
}

function revokeConcatUrl() {
  if (concatObjectUrl) {
    URL.revokeObjectURL(concatObjectUrl);
    concatObjectUrl = null;
  }
}

function updateConcatButtons() {
  const recorded = scriptLines.filter((l) => lineRecorder.hasRecording(l.id)).length;
  const canConcat = recorded > 0;
  els.playConcatBtn?.toggleAttribute("disabled", !canConcat);
  els.downloadConcatBtn?.toggleAttribute("disabled", !canConcat);
  els.queueDeliveryBtn?.toggleAttribute("disabled", !canConcat || !workspaceRequestId);
}

function syncActiveCaseUi() {
  if (!els.activeCaseLabel) return;
  if (workspaceRequestId) {
    els.activeCaseLabel.hidden = false;
    els.activeCaseLabel.textContent = `案件: ${workspaceRequestId}`;
  } else {
    els.activeCaseLabel.hidden = true;
    els.activeCaseLabel.textContent = "";
  }
}

function renderSessionFlow() {
  if (!els.flowList) return;
  const total = scriptLines.length;
  const done = scriptLines.filter((l) => lineRecorder.hasRecording(l.id)).length;
  if (els.flowSummary) {
    els.flowSummary.textContent =
      total > 0 ? `${done} / ${total} 完了` : "0 / 0 完了";
  }

  els.flowList.innerHTML = scriptLines
    .map((line, i) => {
      const hasRec = lineRecorder.hasRecording(line.id);
      const isCurrent = i === focusedLineIndex;
      const startLabel = formatTimecode(getRecordStartSec(line));
      const needsRetake = cueRetakeStore?.isCueNeedsRetake(line.id);
      return `
        <li class="rw-flow-item${hasRec ? " rw-flow-item--done" : ""}${isCurrent ? " rw-flow-item--current" : ""}${needsRetake ? " rw-flow-item--retake" : ""}" data-line-index="${i}">
          <span class="rw-flow-num">音声 ${i + 1}</span>
          <span class="rw-flow-text">${escapeHtml(line.text)}</span>
          <span class="rw-flow-status">${needsRetake ? "⚠ 要修正" : hasRec ? "✓ 完了" : "○ 未収録"}</span>
          <span class="rw-flow-start" title="収録スタート">▶ ${startLabel}</span>
        </li>
      `;
    })
    .join("");

  if (total > 0 && done === total) {
    if (els.flowSummary) {
      els.flowSummary.textContent = `${done} / ${total} — 収録完了`;
    }
  }
  updateConcatButtons();
}

async function playConcatenatedTakes() {
  stopPlayback();
  els.takePreview?.pause();
  setStatus("②声優トラックと同じ並びでミックスしています…", "info");
  try {
    const result = await buildTimelineMix(lineRecorder, scriptLines, {
      totalDurationSec: getMixTimelineDurationSec(),
      audioOffsetSec,
      getClipPositionSec: (line) => getTakeClipPositionSec(line)
    });
    revokeConcatUrl();
    lastConcatBlob = result.blob;
    concatObjectUrl = URL.createObjectURL(result.blob);
    const audio = els.concatPreview;
    if (audio) {
      audio.src = concatObjectUrl;
      audio.load();
      if (els.concatPreviewWrap) els.concatPreviewWrap.hidden = false;
      await audio.play();
    }
    setStatus(
      `合成された音声（${result.durationSec.toFixed(1)}秒）を試聴中です。`,
      "ok"
    );
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), "err");
  }
}

async function downloadConcatenatedTakes() {
  try {
    if (!lastConcatBlob) {
      const result = await buildTimelineMix(lineRecorder, scriptLines, {
        totalDurationSec: getMixTimelineDurationSec(),
        audioOffsetSec,
        getClipPositionSec: (line) => getTakeClipPositionSec(line)
      });
      lastConcatBlob = result.blob;
    }
    triggerConcatDownload();
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), "err");
  }
}

function triggerConcatDownload() {
  if (!lastConcatBlob) return;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(lastConcatBlob);
  a.download = `wavrick-takes-${Date.now()}.wav`;
  a.click();
  URL.revokeObjectURL(a.href);
  setStatus("ミックス WAV をダウンロードしました（PCのダウンロードフォルダ）。", "ok");
}

async function ensureConcatMixBlob() {
  if (lastConcatBlob) return lastConcatBlob;
  const result = await buildTimelineMix(lineRecorder, scriptLines, {
    totalDurationSec: getMixTimelineDurationSec(),
    audioOffsetSec,
    getClipPositionSec: (line) => getTakeClipPositionSec(line)
  });
  lastConcatBlob = result.blob;
  return lastConcatBlob;
}

async function queueDeliveryForCase() {
  if (!workspaceRequestId) {
    setStatus("案件 ID がありません。案件管理からブースを開き直してください。", "err");
    return;
  }
  const handoffApi = globalThis.WavrickDeliveryHandoff;
  if (!handoffApi) {
    setStatus("提出用の保存機能を読み込めませんでした。ページを再読み込みしてください。", "err");
    return;
  }
  try {
    setStatus("ミックスを案件提出用に保存しています…", "info");
    const blob = await ensureConcatMixBlob();
    await handoffApi.put({
      requestId: workspaceRequestId,
      fileName: `wavrick-${workspaceRequestId}-${Date.now()}.wav`,
      mimeType: blob.type || "audio/wav",
      blob,
      createdAt: new Date().toISOString()
    });
    sessionStorage.setItem("wavrick_go", "work");
    sessionStorage.setItem("wavrick_work_selected_request_id", workspaceRequestId);
    setStatus("案件管理の提出欄へ移動します…", "ok");
    window.location.href = "./index.html";
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), "err");
  }
}

function syncWaveformScriptRegions() {
  if (!waveform) return;
  const lines = scriptLines.map((line) => ({
    ...line,
    startSec: line.startSec + audioOffsetSec,
    endSec:
      line.endSec != null ? line.endSec + audioOffsetSec : null
  }));
  const durationHint =
    waveform.getDuration() || ytPlayer?.getDuration() || 0;
  waveform.setScriptLines(lines, { durationHint });
  waveform.setRetakeCueIds?.(cueRetakeStore?.getPendingCueIds() ?? []);
  syncPunchInMarkers();
}

function setFocusedLineIndex(index, { seek = true } = {}) {
  if (!scriptLines.length) return;
  focusedLineIndex = Math.max(0, Math.min(index, scriptLines.length - 1));
  const line = getFocusedLine();
  if (!line) return;
  activeLineId = line.id;
  if (cueRetakeStore?.isCueNeedsRetake(line.id)) {
    cueRetakeStore.markCueInProgress(line.id);
    cueRetakeStore.persistLocal();
  }
  updateCueDisplay();
  syncPunchInUi();
  syncRetakeUi();
  renderScriptList();
  renderSessionFlow();
  updateTakeUi();
  renderMarkerList();
  if (line) syncTakePreviewPlayer(line.id);
  if (waveform?.ready) {
    waveform.focusScriptLine(line.id, line.startSec + audioOffsetSec, {
      seek: false,
      scroll: true
    });
  }
  if (seek) jumpToRecordStart(line, { play: false });
}

function highlightActiveLineByTime(t) {
  let found = null;
  let foundIndex = -1;
  for (let i = 0; i < scriptLines.length; i++) {
    const line = scriptLines[i];
    const end = line.endSec ?? line.startSec + 9999;
    if (t >= line.startSec - 0.05 && t < end + 0.05) {
      found = line.id;
      foundIndex = i;
      break;
    }
  }
  if (found === activeLineId) return;
  activeLineId = found;
  if (foundIndex >= 0 && isPlaying) {
    focusedLineIndex = foundIndex;
    updateCueDisplay();
    updateTakeUi();
  }
  renderScriptList();
}

function updateCueDisplay() {
  const line = getFocusedLine();
  const total = scriptLines.length;
  if (els.cueIndex) {
    els.cueIndex.textContent = line ? `台本 ${focusedLineIndex + 1} / ${total}` : "— / —";
  }
  if (els.cueTc) {
    if (!line) els.cueTc.textContent = "[—]";
    else {
      const rows = getTeleprompterRows(line);
      els.cueTc.textContent =
        rows.length > 1
          ? rows.map((r) => r.timeLabel).join(" · ")
          : line.rawTc;
    }
  }
  renderTeleprompter();
  const prev = scriptLines[focusedLineIndex - 1];
  const next = scriptLines[focusedLineIndex + 1];
  if (els.cuePrev) {
    els.cuePrev.textContent = prev ? prev.text : "";
    els.cuePrev.hidden = !prev;
  }
  if (els.cueNext) {
    els.cueNext.textContent = next ? next.text : "";
    els.cueNext.hidden = !next;
  }
}

function updateProgressBar() {
  const total = scriptLines.length;
  const done = scriptLines.filter((l) => lineRecorder.hasRecording(l.id)).length;
  if (els.progressLabel) {
    els.progressLabel.textContent = `${done} / ${total} 行収録済`;
  }
  if (els.progressFill && total > 0) {
    els.progressFill.style.width = `${Math.round((done / total) * 100)}%`;
  }
}

function updateTakeUi() {
  const line = getFocusedLine();
  renderTakeDesk();
  if (!line) return;
  const has = lineRecorder.hasRecording(line.id);
  els.playTakeBtn?.toggleAttribute("disabled", !has);
  els.playTakeTransportBtn?.toggleAttribute("disabled", !has);
}

function scrollMultitrackIntoView() {
  if (!els.waveDock?.classList.contains("rw-wave-dock--ready")) return;
  els.waveDock.scrollIntoView({ block: "nearest", behavior: "smooth" });
  const line = getFocusedLine();
  if (line && waveform?.ready) {
    const t = getRecordStartSec(line) + audioOffsetSec;
    waveform.scrollToTime(t, { force: true });
  }
}

function updateSessionLiveUi() {
  const live =
    document.body.classList.contains("rw-is-recording") ||
    document.body.classList.contains("rw-adr-active") ||
    document.body.classList.contains("rw-cue-wait");
  document.body.classList.toggle("rw-session-live", live);
}

function syncRecordingLineHighlight() {
  if (!waveform?.ready) return;
  const recLine = scriptLines.find((l) => lineRecorder.isRecording(l.id));
  const armed = scriptLines.find((l) => lineRecorder.isArmed(l.id));
  const id = recLine?.id ?? armed?.id ?? getFocusedLine()?.id ?? null;
  waveform.setRecordingHighlight(
    document.body.classList.contains("rw-session-live") ? id : null
  );
}

function setRecordingUi(recording) {
  els.recordIndicator?.toggleAttribute("hidden", !recording);
  els.recordBtn?.classList.toggle("is-recording", recording);
  document.body.classList.toggle("rw-is-recording", recording);
  if (recording && els.recordIndicator) {
    els.recordIndicator.textContent = "REC";
  }
  updateSessionLiveUi();
  syncRecordingLineHighlight();
  updateBoothBarUi();
  if (recording) scrollMultitrackIntoView();
}

function setCueWaitUi(waiting) {
  document.body.classList.toggle("rw-cue-wait", waiting);
  if (!els.recordIndicator) return;
  if (waiting) {
    els.recordIndicator.removeAttribute("hidden");
    els.recordIndicator.textContent = "待機";
    updateSessionLiveUi();
    scrollMultitrackIntoView();
    syncRecordingLineHighlight();
  } else if (
    !document.body.classList.contains("rw-is-recording") &&
    !document.body.classList.contains("rw-adr-active")
  ) {
    els.recordIndicator.setAttribute("hidden", "");
    els.recordIndicator.textContent = "REC";
    updateSessionLiveUi();
    syncRecordingLineHighlight();
  }
}

function stopLiveMicWaveform() {
  stopInputLevelMeter();
  stopOverdubMonitor();
  if (els.inputLevelMeter) els.inputLevelMeter.hidden = true;
  liveMicWaveform?.destroy();
  liveMicWaveform = null;
  if (els.liveRecPanel) els.liveRecPanel.hidden = true;
}

function startLiveMicWaveform() {
  const stream = lineRecorder.stream;
  if (!stream || !els.liveRecCanvas) return;
  stopLiveMicWaveform();
  try {
    liveMicWaveform = new LiveMicWaveform(els.liveRecCanvas, stream);
    if (els.liveRecPanel) els.liveRecPanel.hidden = false;
    if (isFeatureOn("inputLevelMeter") && els.inputLevelMeter) {
      els.inputLevelMeter.hidden = false;
      const an = liveMicWaveform.getAnalyser();
      if (an) startInputLevelMeter(an, els.inputLevelMeter);
    }
  } catch (err) {
    setStatus(
      err instanceof Error ? err.message : "リアルタイム波形を開始できませんでした",
      "err"
    );
  }
}

function updateBoothBarUi() {
  const inBooth = document.body.classList.contains("rw-booth-mode");
  const lineId = boothSessionLineId || "";
  const recording =
    Boolean(lineId && lineRecorder.isRecording(lineId)) ||
    scriptLines.some((l) => lineRecorder.isRecording(l.id));
  const armed = Boolean(lineId && lineRecorder.isArmed(lineId));
  const preroll =
    document.body.classList.contains("rw-adr-preroll") ||
    document.body.classList.contains("rw-adr-countdown");

  if (els.openBoothBtn) els.openBoothBtn.hidden = inBooth;
  if (els.boothCloseBtn) els.boothCloseBtn.hidden = !inBooth || recording || preroll;
  if (els.boothReadyBtn) {
    els.boothReadyBtn.hidden =
      !inBooth || !armed || recording || preroll || boothShowCountdown;
  }
  if (els.boothStartBtn) {
    els.boothStartBtn.hidden =
      !inBooth || !armed || !boothShowCountdown || recording || preroll;
    els.boothStartBtn.disabled = recording || preroll;
  }
  if (els.boothStopBtn) els.boothStopBtn.hidden = !recording;

  if (!els.boothStatus) return;
  if (!inBooth) {
    els.boothStatus.textContent =
      "収録ブース — 台本とマルチトラックを確認してから開く";
    return;
  }
  const line = boothSessionLineId
    ? scriptLines.find((l) => l.id === boothSessionLineId)
    : null;
  if (recording) {
    els.boothStatus.textContent = `録音中 — ${line?.text?.slice(0, 36) || ""}… ■ 停止`;
  } else if (preroll) {
    els.boothStatus.textContent = "プレロール／3-2-1 カウント中…";
  } else if (boothShowCountdown && armed) {
    els.boothStatus.textContent =
      "下の ● 3-2-1 で吹き込み開始 を押すと収録が始まります";
  } else if (armed) {
    els.boothStatus.textContent =
      "準備完了。位置を確認して ● 録音 → 3-2-1 で開始";
  } else {
    els.boothStatus.textContent = "マイクを準備しています…";
  }
}

function clearAdrSessionUi() {
  document.body.classList.remove(
    "rw-booth-mode",
    "rw-adr-standby",
    "rw-adr-active",
    "rw-adr-preroll",
    "rw-adr-countdown",
    "rw-adr-recording"
  );
  boothSessionLineId = null;
  boothShowCountdown = false;
  hideAdrOverlay(els.adrOverlay);
  setCueWaitUi(false);
  setRecordingUi(false);
  if (els.recordIndicator) {
    els.recordIndicator.setAttribute("hidden", "");
    els.recordIndicator.textContent = "REC";
  }
  lineRecorder.disarm();
  updateSessionLiveUi();
  waveform?.setRecordingHighlight(null);
  stopLiveMicWaveform();
  updateBoothBarUi();
}

function abortAdrSession() {
  if (adrSessionAbort) {
    adrSessionAbort.abort();
    adrSessionAbort = null;
  }
  if (adrReferencePlaying) {
    waveform?.pause();
    ytPlayer?.pause();
    adrReferencePlaying = false;
  }
  lineRecorder.disarm();
  clearAdrSessionUi();
}

/** プレロール／カウント中だけ止める（収録ブースは開いたまま） */
async function abortAdrPunchKeepBooth() {
  if (adrSessionAbort) {
    adrSessionAbort.abort();
    adrSessionAbort = null;
  }
  if (adrReferencePlaying) {
    waveform?.pause();
    ytPlayer?.pause();
    adrReferencePlaying = false;
  }
  document.body.classList.remove(
    "rw-adr-preroll",
    "rw-adr-countdown",
    "rw-adr-recording"
  );
  hideAdrOverlay(els.adrOverlay);
  setRecordingUi(false);
  stopLiveMicWaveform();
  boothShowCountdown = false;
  const lineId = boothSessionLineId;
  if (
    lineId &&
    document.body.classList.contains("rw-booth-mode") &&
    !lineRecorder.isRecording(lineId)
  ) {
    try {
      await lineRecorder.arm(lineId);
    } catch {
      /* ignore */
    }
  }
  updateBoothBarUi();
}

/** 台本タイムライン上の現在秒（動画基準） */
function getScriptTimelineSec() {
  if (waveform?.ready) {
    return waveform.getCurrentTime() + audioOffsetSec;
  }
  return ytPlayer?.getCurrentTime() ?? 0;
}

/**
 * プレロール: お手本を再生し cueSec まで進める（ADR スタイル）
 */
async function playReferenceUntilCue(cueSec, signal) {
  const leadSec = Math.max(preRollSec, ADR_COUNTDOWN_SEC + 0.5);
  const fromSec = Math.max(0, cueSec - leadSec);
  seekBoth(fromSec);

  if (!waveform?.ready) {
    updateAdrOverlay(els.adrOverlay, {
      phase: "PRE-ROLL",
      count: "",
      sub: `約 ${preRollSec.toFixed(1)} 秒お待ちください（波形なし）…`
    });
    const waitMs = Math.max(500, (cueSec - fromSec) * 1000);
    await sleep(waitMs);
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    return;
  }

  updateAdrOverlay(els.adrOverlay, {
    phase: "PRE-ROLL",
    count: "",
    sub: "お手本を再生中 — タイミングを耳で合わせてください"
  });

  adrReferencePlaying = true;
  suppressYtPoll = true;
  const waveFrom = waveTimeFromVideo(fromSec);
  waveform.setTime(waveFrom, { scroll: true });
  ytPlayer?.seekTo(fromSec, true);
  lastYtPollT = fromSec;

  const ok = await waveform.play();
  if (ok) ytPlayer?.play();

  let lastCountInt = -1;

  await new Promise((resolve, reject) => {
    const tick = () => {
      if (signal.aborted) {
        cleanup();
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      const t = getScriptTimelineSec();
      const remain = cueSec - t;

      if (remain <= ADR_COUNTDOWN_SEC + 0.05 && remain > 0.05) {
        document.body.classList.remove("rw-adr-preroll");
        document.body.classList.add("rw-adr-countdown");
        const n = Math.ceil(remain);
        if (n !== lastCountInt && n >= 1 && n <= ADR_COUNTDOWN_SEC) {
          lastCountInt = n;
          updateAdrOverlay(els.adrOverlay, {
            phase: "",
            count: String(n),
            sub: "セリフ直前 — 息を整えて"
          });
          if (countdownBeepsOn) playCueBeep(660 + (ADR_COUNTDOWN_SEC - n) * 90);
          if (countdownBeepsOn && isFeatureOn("bpmClickCountdown")) {
            playBpmClick(120);
          }
        }
      }

      if (t >= cueSec - 0.04) {
        cleanup();
        resolve(undefined);
      }
    };

    const id = setInterval(tick, 35);
    tick();

    function cleanup() {
      clearInterval(id);
      waveform?.pause();
      ytPlayer?.pause();
      adrReferencePlaying = false;
      requestAnimationFrame(() => {
        suppressYtPoll = false;
      });
    }
  });
}

/**
 * 収録ブースを開く（マルチトラック＋台本を1画面で確認。3-2-1 はまだ始まらない）
 */
async function enterRecordingBooth(lineId, micStreamPromise) {
  if (adrSessionAbort) return;

  const idx = scriptLines.findIndex((l) => l.id === lineId);
  if (idx < 0) {
    setStatus("台本の行が見つかりません。", "err");
    return;
  }
  const line = scriptLines[idx];

  const otherRecording = scriptLines.find(
    (l) => l.id !== lineId && lineRecorder.hasActiveSession(l.id)
  );
  if (otherRecording) {
    await stopRecording(otherRecording.id);
  }

  focusedLineIndex = idx;
  activeLineId = lineId;
  boothSessionLineId = lineId;
  updateCueDisplay();
  renderScriptList();
  pauseReferencePlaybackForMic();
  hideAdrOverlay(els.adrOverlay);

  document.body.classList.add("rw-booth-mode", "rw-adr-active", "rw-adr-standby");
  updateSessionLiveUi();
  scrollMultitrackIntoView();
  syncRecordingLineHighlight();
  jumpToRecordStart(line, { play: false });
  updateBoothBarUi();

  if (els.recordIndicator) els.recordIndicator.setAttribute("hidden", "");
  boothShowCountdown = false;

  try {
    await lineRecorder.arm(lineId, micStreamPromise);
    setStatus(
      `収録ブース — 音声 ${getScriptLineNum(lineId)}。位置を確認して ● 録音 → 3-2-1`,
      "ok"
    );
    updateBoothBarUi();
  } catch (err) {
    boothSessionLineId = null;
    clearAdrSessionUi();
    setStatus(err instanceof Error ? err.message : String(err), "err");
  }
}

/**
 * ブース内の録音開始 → プレロール → 3-2-1 → パンチイン＋リアルタイム波形
 */
async function beginAdrPunchInFromBooth({ fromHoldKey = false } = {}) {
  const lineId = boothSessionLineId;
  if (!lineId) {
    setStatus("先に「収録ブースを開く」からブースに入ってください。", "err");
    return;
  }
  if (!fromHoldKey && !boothShowCountdown) {
    setStatus("先に ● 録音 を押してから 3-2-1 で開始してください。", "err");
    return;
  }
  if (fromHoldKey) boothShowCountdown = true;
  if (!lineRecorder.isArmed(lineId)) {
    setStatus("マイクの準備が切れています。もう一度収録ブースを開いてください。", "err");
    return;
  }
  if (adrSessionAbort) return;

  const line = scriptLines.find((l) => l.id === lineId);
  if (!line) return;

  const ac = new AbortController();
  adrSessionAbort = ac;
  const { signal } = ac;

  document.body.classList.remove("rw-adr-standby");
  document.body.classList.add("rw-adr-preroll");
  els.adrOverlay?.removeAttribute("hidden");
  updateAdrOverlay(els.adrOverlay, {
    phase: "PRE-ROLL",
    count: "",
    sub: "お手本のタイミングに合わせます…"
  });
  updateBoothBarUi();

  const cueSec = getRecordStartSec(line);

  try {
    await playReferenceUntilCue(cueSec, signal);
    if (signal.aborted) return;

    document.body.classList.remove("rw-adr-countdown");
    document.body.classList.add("rw-adr-recording");
    if (countdownBeepsOn) playCueBeep(1200, 0.16, 0.45);
    updateAdrOverlay(els.adrOverlay, {
      phase: "",
      count: "吹き込み！",
      sub: ""
    });
    await sleep(450);

    lineRecorder.punchIn(lineId);
    if (isFeatureOn("overdubMonitor")) {
      const ref = lineRecorder.getActiveTake(lineId);
      if (ref?.blob) startOverdubMonitor(ref.blob);
    }
    hideAdrOverlay(els.adrOverlay);
    setRecordingUi(true);
    startLiveMicWaveform();
    jumpToRecordStart(line, { play: false });
    setStatus(
      `録音中（スタート ${formatTimecode(cueSec)}）— 下の波形がマイク入力です。■ 録音停止で終了`,
      "ok"
    );
    renderScriptList();
    updateBoothBarUi();
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") return;
    lineRecorder.disarm();
    setRecordingUi(false);
    stopLiveMicWaveform();
    setStatus(err instanceof Error ? err.message : String(err), "err");
  } finally {
    adrSessionAbort = null;
    document.body.classList.remove("rw-adr-preroll", "rw-adr-countdown");
    if (!lineRecorder.isRecording(lineId)) {
      document.body.classList.remove("rw-adr-recording");
      if (!lineRecorder.isArmed(lineId)) {
        document.body.classList.remove("rw-adr-active");
      }
      hideAdrOverlay(els.adrOverlay);
      updateBoothBarUi();
    }
  }
}

async function cancelRecordingBooth() {
  abortAdrSession();
  const recId =
    boothSessionLineId ||
    scriptLines.find((l) => lineRecorder.isRecording(l.id))?.id;
  if (recId && lineRecorder.isRecording(recId)) {
    await stopRecording(recId);
  } else {
    clearAdrSessionUi();
    restoreReferencePlayback();
    setStatus("収録ブースを閉じました。", "ok");
  }
}

function clearCueWatch() {
  if (cueWatchId) {
    clearInterval(cueWatchId);
    cueWatchId = null;
  }
}

function jumpToCue(line, { play = false } = {}) {
  const target = line || getFocusedLine();
  if (!target) return;
  const sec = Math.max(0, target.startSec - preRollSec);
  seekBoth(sec);
  if (play && waveform?.ready) void togglePlayPause();
}

function goNextLine() {
  if (focusedLineIndex < scriptLines.length - 1) {
    setFocusedLineIndex(focusedLineIndex + 1);
  }
}

function goPrevLine() {
  if (focusedLineIndex > 0) {
    setFocusedLineIndex(focusedLineIndex - 1);
  }
}

async function stopAll() {
  clearCueWatch();
  abortAdrSession();
  setCueWaitUi(false);
  const recording = scriptLines.find(
    (l) => lineRecorder.isRecording(l.id) || lineRecorder.hasActiveSession(l.id)
  );
  if (recording) {
    await stopRecording(recording.id);
  } else {
    restoreReferencePlayback();
  }
  stopPlayback();
  if (els.takePreview) els.takePreview.pause();
  clearAdrSessionUi();
}

function setWaveDockReady(ready) {
  els.waveDock?.classList.toggle("rw-wave-dock--ready", ready);
  if (els.waveEmptyHint) els.waveEmptyHint.hidden = ready;
  if (!ready) els.multitrackSeekBar?.setAttribute("hidden", "");
}

async function recordLineById(lineId, { micStreamPromise } = {}) {
  if (micStartJob) return micStartJob;

  if (lineRecorder.isRecording(lineId)) return;

  micStartJob = (async () => {
    try {
      await enterRecordingBooth(lineId, micStreamPromise);
      updateTakeUi();
    } finally {
      /* punch-in via booth bar */
    }
  })();

  try {
    await micStartJob;
  } finally {
    micStartJob = null;
  }
}

/** 収録ブースを開く（マイク許可はこのクリックで取得） */
async function onOpenBoothClick(ev) {
  ev?.preventDefault?.();
  ev?.stopPropagation?.();
  micRecordIntent = true;
  const line = getFocusedLine();
  if (!line) {
    micRecordIntent = false;
    setStatus("台本の行がありません。", "err");
    return;
  }
  const micStreamPromise = requestMicStreamInUserGesture();
  setStatus("収録ブースを開いています…", "info");
  try {
    await recordLineById(line.id, { micStreamPromise });
  } finally {
    micRecordIntent = false;
  }
}

function onBoothReadyClick() {
  if (!boothSessionLineId || !lineRecorder.isArmed(boothSessionLineId)) {
    setStatus("先に「収録ブースを開く」からブースに入ってください。", "err");
    return;
  }
  boothShowCountdown = true;
  updateBoothBarUi();
  scrollMultitrackIntoView();
  setStatus("● 3-2-1 で吹き込み開始 を押すと収録が始まります。", "ok");
}

async function stopBoothRecording() {
  const recId =
    boothSessionLineId ||
    scriptLines.find((l) => lineRecorder.isRecording(l.id))?.id;
  if (recId && lineRecorder.isRecording(recId)) {
    await stopRecording(recId);
  } else {
    await stopAll();
  }
}

function startCueWatchForAutoRecord(line) {
  clearCueWatch();
  if (!autoRecordAtCue || !line) return;
  cueWatchId = setInterval(() => {
    const waveT = waveform?.getCurrentTime() ?? 0;
    const ytT = ytPlayer?.getCurrentTime() ?? videoTimeFromWave(waveT);
    const t = waveform?.ready ? waveT + audioOffsetSec : ytT;
    if (t >= line.startSec - 0.08) {
      clearCueWatch();
      if (!lineRecorder.isRecording(line.id)) void recordLineAfterCue(line.id);
    }
  }, 40);
}

/** キュー到達後の録音（マイクは既に openMic 済み） */
async function recordLineAfterCue(lineId) {
  const idx = scriptLines.findIndex((l) => l.id === lineId);
  if (idx < 0) return;
  const line = scriptLines[idx];
  pauseReferencePlaybackForMic();
  setRecordingUi(true);
  try {
    if (!lineRecorder.isRecording(lineId)) {
      await lineRecorder.startRecording(lineId);
      setCueWaitUi(false);
      renderScriptList();
      setStatus(`録音中: ${line.rawTc}`, "ok");
    }
  } catch (err) {
    lineRecorder.release();
    setRecordingUi(false);
    setCueWaitUi(false);
    restoreReferencePlayback();
    setStatus(err instanceof Error ? err.message : String(err), "err");
  }
}

async function playFromCue() {
  if (micRecordIntent || isMicCaptureActive()) return;
  const line = getFocusedLine();
  if (!line) return;
  if (!waveform?.ready) {
    setStatus("先に ② 動画+音声読込 を押してください。", "err");
    return;
  }
  clearCueWatch();
  jumpToCue(line, { play: false });
  await togglePlayPause();
  setStatus(`リファレンス再生中: ${line.rawTc}`, "info");
}

function isTypingTarget(ev) {
  const tag = (ev.target && ev.target.tagName) || "";
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (ev.target?.isContentEditable) return true;
  return false;
}

function canUseHoldSpaceRecord() {
  const lineId = boothSessionLineId;
  return (
    holdToRecordOn &&
    document.body.classList.contains("rw-booth-mode") &&
    Boolean(lineId) &&
    lineRecorder.isArmed(lineId) &&
    !lineRecorder.isRecording(lineId) &&
    !document.body.classList.contains("rw-adr-preroll") &&
    !document.body.classList.contains("rw-adr-countdown")
  );
}

async function onHoldSpaceKeyDown(ev) {
  if (ev.repeat || holdSpacePunchActive) return;
  holdSpacePunchActive = true;
  setStatus("スペース長押し — プレロール → 3-2-1 → 録音（離すと停止）", "info");
  try {
    await beginAdrPunchInFromBooth({ fromHoldKey: true });
  } catch {
    holdSpacePunchActive = false;
    return;
  }
  if (!lineRecorder.isRecording(boothSessionLineId || "")) {
    holdSpacePunchActive = false;
  }
}

async function onHoldSpaceKeyUp() {
  if (!holdSpacePunchActive) return;
  holdSpacePunchActive = false;
  const lineId = boothSessionLineId;
  if (lineId && lineRecorder.isRecording(lineId)) {
    await stopRecording(lineId);
    setStatus("スペースを離したので録音を停止しました。", "ok");
    return;
  }
  if (
    adrSessionAbort ||
    document.body.classList.contains("rw-adr-preroll") ||
    document.body.classList.contains("rw-adr-countdown")
  ) {
    await abortAdrPunchKeepBooth();
    setStatus("スペースを離したので収録開始をキャンセルしました。", "info");
  }
}

function bindKeyboardShortcuts() {
  window.addEventListener("keydown", (ev) => {
    if (isTypingTarget(ev)) return;
    if (ev.code === "Space") {
      if (canUseHoldSpaceRecord() && !ev.shiftKey) {
        ev.preventDefault();
        void onHoldSpaceKeyDown(ev);
        return;
      }
      ev.preventDefault();
      const line = getFocusedLine();
      if (ev.shiftKey) {
        if (isPlaying) void togglePlayPause();
        else void playFromCue();
      } else if (holdToRecordOn && document.body.classList.contains("rw-booth-mode")) {
        /* 長押しモード中はブース内のタップ Space は無効（誤操作防止） */
      } else if (line?.id && lineRecorder.hasRecording(line.id)) {
        void playTakeForLine(line.id);
      } else if (isPlaying) {
        void togglePlayPause();
      } else if (document.body.classList.contains("rw-booth-mode")) {
        if (boothShowCountdown && boothSessionLineId) {
          void beginAdrPunchInFromBooth();
        } else if (lineRecorder.isArmed(boothSessionLineId || "")) {
          onBoothReadyClick();
        } else {
          syncWorkspaceToBoothAndNavigate();
        }
      } else {
        syncWorkspaceToBoothAndNavigate();
      }
    } else if (ev.key === "t" || ev.key === "T") {
      ev.preventDefault();
      const line = getFocusedLine();
      if (line) void playTakeForLine(line.id);
    } else if (ev.key === "r" || ev.key === "R") {
      ev.preventDefault();
      if (document.body.classList.contains("rw-is-recording")) {
        void stopBoothRecording();
      } else if (
        document.body.classList.contains("rw-booth-mode") &&
        boothShowCountdown
      ) {
        void beginAdrPunchInFromBooth();
      } else if (document.body.classList.contains("rw-booth-mode")) {
        onBoothReadyClick();
      } else {
        syncWorkspaceToBoothAndNavigate();
      }
    } else if (ev.key === "s" || ev.key === "S") {
      ev.preventDefault();
      if (document.body.classList.contains("rw-is-recording")) {
        void stopBoothRecording();
      } else if (document.body.classList.contains("rw-booth-mode")) {
        void cancelRecordingBooth();
      } else {
        stopAll();
      }
    } else if (ev.key === "c" || ev.key === "C") {
      ev.preventDefault();
      jumpToRecordStart(getFocusedLine(), { play: true });
    } else if (ev.key === "ArrowDown") {
      ev.preventDefault();
      goNextLine();
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      goPrevLine();
    }
  });

  window.addEventListener("keyup", (ev) => {
    if (ev.code !== "Space" || !holdToRecordOn) return;
    if (isTypingTarget(ev)) return;
    void onHoldSpaceKeyUp();
  });
}

function videoTimeFromWave(waveSec) {
  return Math.max(0, waveSec - audioOffsetSec);
}

function onWaveformTimeUpdate(waveT) {
  if (!isPlaying) return;
  maybeLoopLineRegion(waveT);
  const ytT = videoTimeFromWave(waveT);
  suppressYtPoll = true;
  const ytCur = ytPlayer?.getCurrentTime() ?? 0;
  if (ytPlayer?.ready && Math.abs(ytCur - ytT) > 0.4) {
    ytPlayer.seekTo(ytT, true);
    lastYtPollT = ytT;
  }
  updateTimeDisplay(ytT);
  highlightActiveLineByTime(ytT);
  requestAnimationFrame(() => {
    suppressYtPoll = false;
  });
}

function syncWaveFromYouTube(ytT, { playing = false } = {}) {
  if (!waveform?.ready) return;
  if (isPlaying) return;
  if (performance.now() < refPauseGuardUntil) return;
  const curWave = waveform.getCurrentTime();
  if (!playing && ytT < 0.08 && curWave > 0.5) return;
  suppressYtPoll = true;
  waveform.setTime(waveTimeFromVideo(ytT), { scroll: false });
  updateTimeDisplay(ytT);
  highlightActiveLineByTime(ytT);
  lastYtPollT = ytT;

  if (playing && !isPlaying) {
    void startPlaybackFromYouTube(ytT);
  } else if (!playing && isPlaying) {
    stopPlayback({ fromYouTube: true });
  }
  requestAnimationFrame(() => {
    suppressYtPoll = false;
  });
}

async function startPlaybackFromYouTube(ytT) {
  if (isMicCaptureActive() || !waveform?.ready || !ytPlayer?.ready) return;
  ytPlayer.setMuted(true);
  const wavePos = waveTimeFromVideo(ytT);
  if (isPlaying) {
    suppressYtPoll = true;
    if (Math.abs(waveform.getCurrentTime() - wavePos) > 0.2) {
      waveform.setTime(wavePos, { scroll: false });
    }
    updateTimeDisplay(ytT);
    highlightActiveLineByTime(ytT);
    lastYtPollT = ytT;
    requestAnimationFrame(() => {
      suppressYtPoll = false;
    });
    return;
  }
  waveform.setTime(wavePos, { scroll: false });
  if (els.playPauseBtn) els.playPauseBtn.textContent = REF_PAUSE_BTN_LABEL;
  const audioOk = await waveform.play();
  if (!audioOk) {
    if (els.playPauseBtn) els.playPauseBtn.textContent = REF_PLAY_BTN_LABEL;
    return;
  }
  isPlaying = true;
  lastYtPollT = ytT;
}

function onYouTubeStateChange(state) {
  ytPlayer?.setMuted(true);
  if (isMicCaptureActive() || !waveform?.ready || suppressYtPoll) return;

  const ytT = ytPlayer?.getCurrentTime() ?? 0;

  if (state === YT_STATE.PLAYING) {
    void startPlaybackFromYouTube(ytT);
    return;
  }

  if (state === YT_STATE.PAUSED || state === YT_STATE.ENDED) {
    if (isPlaying) {
      stopPlayback({ fromYouTube: true });
    }
    if (performance.now() < refPauseGuardUntil) {
      if (state === YT_STATE.ENDED) seekBoth(0);
      return;
    }
    syncWaveFromYouTube(ytT, { playing: false });
    if (state === YT_STATE.ENDED) {
      seekBoth(0);
    }
  }
}

function pollYouTubeSync() {
  if (isMicCaptureActive() || !ytPlayer?.ready || !waveform?.ready || suppressYtPoll) return;
  /* 再生中は波形がマスター。YouTube から波形を上書きするとカーソルがガタつく */
  if (isPlaying) return;

  const ytT = ytPlayer.getCurrentTime();
  const state = ytPlayer.getPlayerState();
  const drift = Math.abs(ytT - lastYtPollT);

  if (drift > 0.35) {
    const shouldPlay = state === YT_STATE.PLAYING;
    if (shouldPlay && !isPlaying) {
      void startPlaybackFromYouTube(ytT);
    } else {
      syncWaveFromYouTube(ytT, { playing: shouldPlay && isPlaying });
    }
    return;
  }

  if (state === YT_STATE.PLAYING && !isPlaying) {
    void startPlaybackFromYouTube(ytT);
    return;
  }

  if (
    (state === YT_STATE.PAUSED || state === YT_STATE.ENDED) &&
    isPlaying
  ) {
    stopPlayback({ fromYouTube: true });
  }

  lastYtPollT = ytT;
}

function startYtPoll() {
  if (ytPollId) return;
  ytPollId = setInterval(pollYouTubeSync, 200);
}

function stopYtPoll() {
  if (!ytPollId) return;
  clearInterval(ytPollId);
  ytPollId = null;
}

function setVideoMode(mode) {
  videoMode = mode;
  const panel = els.videoPanel;
  if (!panel) return;

  panel.dataset.videoMode = mode;
  panel.classList.toggle("rw-video-panel--mini", mode === "mini");
  if (mode !== "mini") {
    panel.style.left = "";
    panel.style.top = "";
    panel.style.right = "";
    panel.style.bottom = "";
  }

  document.querySelectorAll("[data-video-mode].rw-btn-mode").forEach((btn) => {
    btn.classList.toggle("is-active", btn.getAttribute("data-video-mode") === mode);
  });

  if (els.showVideoBtn) {
    els.showVideoBtn.hidden = true;
  }

  try {
    localStorage.setItem(VIDEO_MODE_KEY, mode);
  } catch {
    /* ignore */
  }
}

function initVideoMode() {
  let saved = "normal";
  try {
    const v = localStorage.getItem(VIDEO_MODE_KEY);
    if (v === "mini" || v === "hidden") saved = v;
  else if (v === "normal") saved = "hidden";
  } catch {
    /* ignore */
  }
  setVideoMode(saved);
}

function bindMiniVideoDrag() {
  const panel = els.videoPanel;
  const handle = els.videoPanelHead;
  if (!panel || !handle) return;

  let dragging = false;
  let startX = 0;
  let startY = 0;
  let startLeft = 0;
  let startTop = 0;

  const onPointerDown = (ev) => {
    if (videoMode !== "mini") return;
    if (ev.target.closest(".rw-btn-mode") || ev.target.closest("button")) return;
    dragging = true;
    const rect = panel.getBoundingClientRect();
    startX = ev.clientX;
    startY = ev.clientY;
    startLeft = rect.left;
    startTop = rect.top;
    panel.style.right = "auto";
    panel.style.bottom = "auto";
    panel.style.left = `${startLeft}px`;
    panel.style.top = `${startTop}px`;
    handle.setPointerCapture?.(ev.pointerId);
    ev.preventDefault();
  };

  const onPointerMove = (ev) => {
    if (!dragging) return;
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    panel.style.left = `${Math.max(8, startLeft + dx)}px`;
    panel.style.top = `${Math.max(8, startTop + dy)}px`;
  };

  const onPointerUp = (ev) => {
    if (!dragging) return;
    dragging = false;
    handle.releasePointerCapture?.(ev.pointerId);
  };

  handle.addEventListener("pointerdown", onPointerDown);
  handle.addEventListener("pointermove", onPointerMove);
  handle.addEventListener("pointerup", onPointerUp);
  handle.addEventListener("pointercancel", onPointerUp);
}

async function syncAllTakeWaves() {
  if (!waveform?.ready) return;
  for (const line of scriptLines) {
    const take = lineRecorder.getActiveTake(line.id);
    if (take?.blob) {
      const idx = lineRecorder.getActiveTakeIndex(line.id);
      const edit = lineRecorder.getTakeEdit(line.id, idx);
      await waveform.setTakeForLine(line.id, take.blob, {
        positionSec: getTakeClipPositionSec(line) + audioOffsetSec,
        lineNum: getScriptLineNum(line.id),
        edit
      });
      waveform.setClipPosition(
        line.id,
        getTakeClipPositionSec(line) + audioOffsetSec
      );
      waveform.setClipEdit(line.id, edit);
    } else {
      waveform.clearTakeForLine(line.id);
    }
  }
  renderTakeEditor();
}

async function importTakeFileForLine(lineId, file) {
  if (!file) return;
  const idx = scriptLines.findIndex((l) => l.id === lineId);
  if (idx < 0) return;
  focusedLineIndex = idx;
  activeLineId = lineId;
  updateCueDisplay();
  renderScriptList();
  updateTakeUi();
  lineRecorder.addTake(lineId, file);
  if (waveform?.ready) {
    const line = scriptLines.find((l) => l.id === lineId);
    const idx = lineRecorder.getActiveTakeIndex(lineId);
    await waveform.setTakeForLine(lineId, file, {
      positionSec: line ? getTakeClipPositionSec(line) + audioOffsetSec : undefined,
      lineNum: line ? getScriptLineNum(lineId) : 0,
      edit: lineRecorder.getTakeEdit(lineId, idx)
    });
  }
  renderSessionFlow();
  syncTakePreviewPlayer(lineId);
  updateProgressBar();
  setStatus(
    `「${file.name}」を読み込みました。緑の波形は実際の長さで表示（点線の目安からはみ出してもOK）`,
    "ok"
  );
}

function createWaveformPlayer() {
  if (waveform) waveform.destroy();
  setWaveDockReady(false);
  if (!els.refWaveHost || !els.takeLane || !els.takeLaneScroll) {
    setStatus("波形パネルの DOM が見つかりません。ページを再読み込みしてください。", "err");
    return;
  }
  waveform = new DualTrackWaveform(
    els.refWaveHost,
    els.takeLane,
    els.takeLaneScroll,
    {
      onTimeUpdate: onWaveformTimeUpdate,
      onSeek: (waveT) => {
        const ytT = videoTimeFromWave(waveT);
        suppressYtPoll = true;
        ytPlayer?.seekTo(ytT, true);
        lastYtPollT = ytT;
        updateTimeDisplay(ytT);
        highlightActiveLineByTime(ytT);
        requestAnimationFrame(() => {
          suppressYtPoll = false;
        });
      },
      onRegionClick: (lineId, startSec) => {
        const idx = scriptLines.findIndex((l) => l.id === lineId);
        if (idx >= 0) {
          focusedLineIndex = idx;
          activeLineId = lineId;
          updateCueDisplay();
          renderScriptList();
          updateTakeUi();
        }
        seekBoth(videoTimeFromWave(startSec));
      },
      onTakeFile: (lineId, file) => {
        void importTakeFileForLine(lineId, file);
      },
      onClipPositionChange: (lineId, waveSec) => {
        onTakeClipMoved(lineId, waveSec - audioOffsetSec);
      },
      onClipEditChange: (lineId, edit) => {
        onTakeClipEditFromWave(lineId, edit);
      },
      onTakeDuration: (lineId, durationSec) => {
        const idx =
          pendingTakeWaveIndex.get(lineId) ??
          lineRecorder.getActiveTakeIndex(lineId);
        pendingTakeWaveIndex.delete(lineId);
        if (idx >= 0) {
          lineRecorder.setTakeDuration(lineId, idx, durationSec);
          if (lineId === getFocusedLine()?.id) {
            void syncTakeEditStudio();
          }
        }
      },
      onTakeClipActivate: (lineId) => {
        if (!lineRecorder.hasRecording(lineId)) {
          setStatus("このセリフにはまだ Take がありません。", "err");
          return;
        }
        selectTakeForEditing(lineId);
      }
    }
  );
}

async function mountYouTube(videoId, { quiet = false } = {}) {
  if (!videoId) {
    if (!quiet) setStatus("有効な YouTube URL / 動画 ID を入力してください。", "err");
    return false;
  }
  els.playerHost.innerHTML = "";
  const mountId = "rw-yt-embed";
  const div = document.createElement("div");
  div.id = mountId;
  els.playerHost.appendChild(div);

  if (ytPlayer) ytPlayer.destroy();
  ytPlayer = new YouTubeSyncPlayer(mountId, videoId, {
    onState: (state) => onYouTubeStateChange(state)
  });
  try {
    const mountDone = ytPlayer.mount();
    const timeout = new Promise((_, reject) => {
      setTimeout(
        () => reject(new Error("YouTube の読み込みがタイムアウトしました")),
        25000
      );
    });
    await Promise.race([mountDone, timeout]);
  } catch (err) {
    ytPlayer?.destroy();
    ytPlayer = null;
    if (!quiet) {
      setStatus(
        err instanceof Error
          ? `${err.message}（音声だけ取得を続けます）`
          : "動画プレビューを読み込めませんでした",
        "err"
      );
    }
    return false;
  }
  ytPlayer.setMuted(true);
  lastYtPollT = 0;
  startYtPoll();
  updateTimeDisplay(0);
  return true;
}

/**
 * ② 動画 + AIボーカル分離済みリファレンス音声をまとめて読み込む
 */
async function loadVideoAndVocalAudio() {
  const videoUrl = els.ytUrl?.value?.trim() || DEFAULT_YOUTUBE_URL;
  const videoId = extractYouTubeVideoId(videoUrl);
  if (!videoId) {
    setStatus("有効な YouTube URL / 動画 ID を入力してください。", "err");
    return;
  }

  const generation = ++studioLoadGeneration;

  studioLoadJob = (async () => {
    setStatus("動画を読み込み中…", "info");
    const videoOk = await mountYouTube(videoId, { quiet: true });
    if (generation !== studioLoadGeneration) return;
    if (!videoOk) {
      setStatus(
        "動画プレビューはスキップしました。AIボーカル分離の音声取得を続けます…",
        "info"
      );
    }

    setStatus(
      "AIボーカル分離を実行中です（約2〜4分）。このページを開いたままお待ちください…",
      "info"
    );
    await loadWaveformFromProxy({ bundledWithVideo: true });
    if (generation !== studioLoadGeneration) return;
  })();

  try {
    await studioLoadJob;
  } finally {
    if (generation === studioLoadGeneration) {
      studioLoadJob = null;
    }
  }
}

async function loadWaveformFromBlob(blob, videoId) {
  stopPlayback();
  revokeAudioUrl();
  const mime = blob.type && blob.type !== "application/octet-stream" ? blob.type : "audio/mpeg";
  audioObjectUrl = URL.createObjectURL(new Blob([blob], { type: mime }));
  createWaveformPlayer();
  await waveform.loadUrl(audioObjectUrl);
  if (videoId) loadedWaveVideoId = videoId;
  ytPlayer?.setMuted(true);
  const alignNote = checkDurationAlignment();
  setWaveDockReady(true);
  clampWaveformHostSize();
  syncWaveformScriptRegions();
  await syncAllTakeWaves();
  renderScriptList();
  renderSessionFlow();
  updateCueDisplay();
  syncPunchInUi();
  syncPunchInMarkers();
  updateTakeUi();
  updateConcatButtons();
  const line = getFocusedLine();
  if (line) {
    waveform.focusScriptLine(line.id, line.startSec + audioOffsetSec, {
      seek: false,
      scroll: true
    });
  }
  updateVocalBadge();
  setStatus(
    alignNote ||
      `リファレンス音声を読み込みました。${vocalSeparationHint(lastVocalSeparated)} ▶ 再生でこの音を聴けます。`,
    alignNote ? "err" : lastVocalSeparated ? "ok" : "err"
  );
}

function clampWaveformHostSize() {
  const host = els.refWaveHost;
  if (host) {
    host.style.height = "88px";
    host.style.maxHeight = "88px";
    host.style.overflow = "hidden";
    host.style.width = "100%";
  }
}

function resolveExtractUrl(raw) {
  const t = (raw || "").trim();
  if (!t) return t;

  if (t.startsWith("/")) {
    let path = t.replace(/\/+$/, "");
    if (!path.endsWith("/extract")) path = `${path}/extract`;
    return `${location.origin}${path}`;
  }

  let u = t;
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  const base = u.replace(/\/+$/, "");
  if (base.endsWith("/extract")) return base;
  return `${base}/extract`;
}

function getProxyForFetch() {
  const base = readProxyConfig();
  let urlRaw = els.proxyUrl?.value?.trim() || base.extractUrl;
  const secret = els.proxySecret?.value?.trim() || base.secret;

  const host = location.hostname.toLowerCase();
  const isLocalDev =
    host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  if (isLocalDev) {
    urlRaw = `${location.origin}/api/youtube-audio/extract`;
    if (els.proxyUrl) els.proxyUrl.value = urlRaw;
    try {
      localStorage.setItem("wavrick_audio_proxy_url", urlRaw);
    } catch {
      /* ignore */
    }
  } else if (
    urlRaw.includes("127.0.0.1:5055") ||
    urlRaw.includes("localhost:5055")
  ) {
    urlRaw = resolveExtractUrl(urlRaw);
    if (els.proxyUrl) els.proxyUrl.value = urlRaw;
  }

  const extractUrl = resolveExtractUrl(urlRaw);
  return { extractUrl, secret };
}

async function loadWaveformFromProxy({ bundledWithVideo = false } = {}) {
  const videoUrl = els.ytUrl?.value?.trim() || DEFAULT_YOUTUBE_URL;
  const videoId = extractYouTubeVideoId(videoUrl);
  const proxy = getProxyForFetch();
  if (!bundledWithVideo) {
    setStatus(
      "音声を取得中（YouTube → AIボーカル分離）。初回は demucs モデル読込で数分かかることがあります…",
      "info"
    );
  } else {
    setStatus(
      "AIボーカル分離済みのリファレンス音声を取得中…（初回は数分かかることがあります）",
      "info"
    );
  }
  const { blob, vocalSeparated } = await fetchAudioBlobFromProxy(videoUrl, {
    extractUrl: proxy.extractUrl,
    secret: proxy.secret
  });
  lastVocalSeparated = vocalSeparated;
  await loadWaveformFromBlob(blob, videoId);
}

async function loadWaveformFromFile(file) {
  if (!file) return;
  lastVocalSeparated = false;
  await loadWaveformFromBlob(file, getCurrentVideoId());
  setStatus(
    `音声ファイルを読み込みました: ${file.name}（ローカルファイルはAI分離なし。YouTube URL なら②で自動分離）`,
    "ok"
  );
}

function syncNoiseToggleUi() {
  const btn = els.noiseToggleBtn;
  if (!btn) return;
  const hasClean = Boolean(referenceAudioCleanedUrl);
  btn.disabled = !hasClean;
  btn.setAttribute("aria-pressed", String(noiseRemovalActive));
  btn.textContent = noiseRemovalActive ? "ノイズ除去 ON" : "ノイズ除去 OFF";
  btn.classList.toggle("rw-noise-active", noiseRemovalActive);
}

async function toggleNoiseRemoval() {
  if (!referenceAudioCleanedUrl && !referenceAudioRawUrl) {
    setStatus("ノイズ除去用の音声がまだありません。先に②で動画を読み込んでください。", "err");
    return;
  }
  if (!referenceAudioCleanedUrl) {
    setStatus("ノイズ除去済み音声が保存されていません（Demucs未実行）。", "err");
    return;
  }
  noiseRemovalActive = !noiseRemovalActive;
  syncNoiseToggleUi();
  const targetUrl = noiseRemovalActive ? referenceAudioCleanedUrl : referenceAudioRawUrl;
  if (!targetUrl) return;
  setStatus(noiseRemovalActive ? "ノイズ除去済み音声に切替中…" : "元音声に切替中…", "info");
  try {
    const res = await fetch(targetUrl);
    if (!res.ok) throw new Error(`音声取得に失敗 (${res.status})`);
    const blob = await res.blob();
    lastVocalSeparated = noiseRemovalActive;
    await loadWaveformFromBlob(blob, getCurrentVideoId());
    setStatus(noiseRemovalActive ? "ノイズ除去済み音声に切り替えました。" : "元音声に切り替えました。", "ok");
  } catch (err) {
    setStatus(`切替失敗: ${err.message}`, "err");
    noiseRemovalActive = !noiseRemovalActive;
    syncNoiseToggleUi();
  }
}

function updateExcelBarButtons() {
  if (els.undoBtn) els.undoBtn.disabled = workspaceUndoStack.length === 0;
  if (els.redoBtn) els.redoBtn.disabled = workspaceRedoStack.length === 0;
}

function pushWorkspaceHistory(label) {
  workspaceUndoStack.push({
    label: label || "",
    manifest: buildWorkspaceSnapshot(),
    takeBlobs: collectTakeBlobsForSave()
  });
  if (workspaceUndoStack.length > 40) workspaceUndoStack.shift();
  workspaceRedoStack.length = 0;
  updateExcelBarButtons();
  if (els.excelBarHint && label) els.excelBarHint.textContent = label;
}

async function restoreWorkspaceEntry(entry) {
  if (!entry) return;
  await applyWorkspaceSnapshot(entry.manifest, entry.takeBlobs);
}

async function undoWorkspaceEdit() {
  if (!workspaceUndoStack.length) return;
  workspaceRedoStack.push({
    label: "",
    manifest: buildWorkspaceSnapshot(),
    takeBlobs: collectTakeBlobsForSave()
  });
  const prev = workspaceUndoStack.pop();
  updateExcelBarButtons();
  await restoreWorkspaceEntry(prev);
  setStatus("元に戻しました。", "ok");
}

async function redoWorkspaceEdit() {
  if (!workspaceRedoStack.length) return;
  workspaceUndoStack.push({
    label: "",
    manifest: buildWorkspaceSnapshot(),
    takeBlobs: collectTakeBlobsForSave()
  });
  const next = workspaceRedoStack.pop();
  updateExcelBarButtons();
  await restoreWorkspaceEntry(next);
  setStatus("やり直しました。", "ok");
}

function syncScriptSelectToolbar() {
  const n = scriptSelectedIndices.size;
  if (els.scriptSelectModeBtn) {
    els.scriptSelectModeBtn.classList.toggle("is-active", scriptSelectMode);
    els.scriptSelectModeBtn.setAttribute("aria-pressed", scriptSelectMode ? "true" : "false");
  }
  if (els.scriptMergeBtn) {
    els.scriptMergeBtn.hidden = !scriptSelectMode;
    els.scriptMergeBtn.disabled = n < 2;
  }
  if (els.scriptSplitBtn) {
    const line = scriptLines[focusedLineIndex];
    const canSplit = Boolean(line?.segments?.length > 1 || line?.isMergedCue);
    els.scriptSplitBtn.hidden = !scriptSelectMode;
    els.scriptSplitBtn.disabled = !canSplit;
  }
}

function toggleScriptSelectMode() {
  scriptSelectMode = !scriptSelectMode;
  if (!scriptSelectMode) scriptSelectedIndices.clear();
  syncScriptSelectToolbar();
  renderScriptList();
}

function toggleScriptLineSelected(index) {
  if (scriptSelectedIndices.has(index)) scriptSelectedIndices.delete(index);
  else scriptSelectedIndices.add(index);
  syncScriptSelectToolbar();
  renderScriptList();
}

async function mergeTakesForCombinedLine(orderedLines, targetLineId) {
  const parts = [];
  const gaps = [];
  let prevLineWithAudio = null;
  for (const line of orderedLines) {
    const take = lineRecorder.getActiveTake(line.id);
    if (!take?.blob) continue;
    const idx = lineRecorder.getActiveTakeIndex(line.id);
    const edit = lineRecorder.getTakeEdit(line.id, idx);
    const { samples } = await getProcessedTakeSamples(take.blob, edit, 48000);
    if (!samples?.length) continue;
    if (prevLineWithAudio) {
      gaps.push(gapSecBetweenLines(prevLineWithAudio, line));
    }
    prevLineWithAudio = line;
    parts.push(samples);
  }
  if (!parts.length) return;
  const merged = concatSamplesWithTimelineGaps(parts, gaps);
  const blob = encodeWavBlob(merged, 48000);
  const durationSec = merged.length / 48000;
  for (const line of orderedLines) {
    if (line.id === targetLineId) continue;
    lineRecorder.applyLinePack(line.id, { takes: [], activeIndex: 0 });
  }
  const primaryState = lineRecorder.getLineState(targetLineId);
  for (const t of primaryState.takes) {
    if (t.url) URL.revokeObjectURL(t.url);
  }
  primaryState.takes = [];
  lineRecorder.importTake(targetLineId, {
    id: `take-merged-${Date.now()}`,
    durationSec,
    size: blob.size,
    label: "結合（タイムコードどおりの間隔）"
  }, blob);
  lineRecorder.setActiveTake(targetLineId, lineRecorder.getTakeCount(targetLineId) - 1);
}

async function applyMergeSelectedScriptLines() {
  const indices = [...scriptSelectedIndices].sort((a, b) => a - b);
  if (indices.length < 2) {
    setStatus("結合する台本を2つ以上選んでください。", "err");
    return;
  }
  if (
    !window.confirm(
      `台本 ${indices.map((i) => i + 1).join("・")} を1つのセリフに結合しますか？\n` +
        "（タイムコードは各行に残り、収録済み音声の間は台本どおりの長さだけ無音を入れます）"
    )
  ) {
    return;
  }
  pushWorkspaceHistory("台本を結合");
  const orderedLines = indices.map((i) => scriptLines[i]);
  const result = mergeScriptLines(scriptLines, indices);
  if (!result.ok) {
    setStatus(result.message, "err");
    return;
  }
  scriptLines = result.lines;
  await mergeTakesForCombinedLine(orderedLines, scriptLines[result.mergedIndex].id);
  scriptSelectMode = false;
  scriptSelectedIndices.clear();
  focusedLineIndex = result.mergedIndex;
  syncScriptSelectToolbar();
  refreshScriptUiAfterLinesChange();
  if (els.scriptEditor) els.scriptEditor.value = scriptLinesToText(scriptLines);
  saveScriptStateToLocal();
  setStatus(
    "台本を結合しました（収録音声の間は、タイムコードの間隔ぶんだけ無音を入れています）。",
    "ok"
  );
}

async function applySplitFocusedMergedLine() {
  const line = getFocusedLine();
  if (!line) return;
  if (
    !window.confirm(
      "結合した台本を、元のタイムコード付きの複数行に戻しますか？\n（Take の扱いは別途調整が必要な場合があります）"
    )
  ) {
    return;
  }
  pushWorkspaceHistory("台本を分割");
  const result = splitMergedLine(scriptLines, focusedLineIndex);
  if (!result.ok) {
    setStatus(result.message, "err");
    return;
  }
  scriptLines = result.lines;
  scriptSelectMode = false;
  scriptSelectedIndices.clear();
  syncScriptSelectToolbar();
  refreshScriptUiAfterLinesChange();
  if (els.scriptEditor) els.scriptEditor.value = scriptLinesToText(scriptLines);
  saveScriptStateToLocal();
  setStatus("結合していた台本を分割しました。", "ok");
}

function renderTeleprompter() {
  const host = els.teleprompterScroll;
  if (!host) return;
  const line = getFocusedLine();
  if (!line) {
    host.innerHTML =
      '<p class="rw-cue-current">台本を反映するか、右の行を選んでください</p>';
    return;
  }
  const rows = getTeleprompterRows(line);
  host.innerHTML = rows
    .map(
      (row, i) => `
      <div class="rw-tp-row${i === 0 ? " rw-tp-row--active" : ""}" data-tp-index="${i}">
        <time class="rw-tp-time">${escapeHtml(row.timeLabel)}</time>
        <p class="rw-tp-text">${escapeHtml(row.text)}</p>
      </div>`
    )
    .join("");
  if (Date.now() > teleprompterManualScrollUntil) {
    const active = host.querySelector(".rw-tp-row--active");
    active?.scrollIntoView({ block: "center", behavior: "smooth" });
  }
}

function renderScriptList() {
  if (!els.scriptList) return;
  const parts = [];
  for (let i = 0; i < scriptLines.length; i++) {
    const line = scriptLines[i];
    const prev = scriptLines[i - 1];
    if (i > 0 && isAutoBlockBoundary(prev, line)) {
      parts.push(
        `<div class="rw-script-block-gap" role="separator" aria-label="自動分割（10秒以上の間隔）">
          <span>10秒ルールで分割</span>
        </div>`
      );
    }
    const hasRec = lineRecorder.hasRecording(line.id);
    const takeN = lineRecorder.getTakeCount(line.id);
    const recording = lineRecorder.isRecording(line.id);
    const focused = i === focusedLineIndex;
    const selected = scriptSelectedIndices.has(i);
    const statusLabel = hasRec
      ? takeN > 1
        ? `${takeN} Take`
        : "収録済"
      : "未収録";
    const startTc = formatTimecode(getRecordStartSec(line));
    const needsRetake = cueRetakeStore?.isCueNeedsRetake(line.id);
    const displayText = lineDisplayText(line);
    const mergedTag = line.isMergedCue ? '<span class="rw-script-merged-tag">結合</span>' : "";
    const checkHtml = scriptSelectMode
      ? `<span class="rw-script-check${selected ? " is-checked" : ""}" aria-hidden="true"></span>`
      : "";
    parts.push(`
        <button
          type="button"
          class="rw-script-line${focused ? " rw-script-line--focused" : ""}${hasRec ? " rw-script-line--done" : ""}${recording ? " rw-script-line--recording" : ""}${needsRetake ? " rw-script-line--retake" : ""}${selected ? " rw-script-line--selected" : ""}${scriptSelectMode ? " rw-script-line--select-mode" : ""}"
          data-line-index="${i}"
          data-line-id="${line.id}"
          title="台本 ${i + 1}${needsRetake ? "（要修正）" : ""}"
        >
          ${checkHtml}
          <span class="rw-script-line-rail" aria-hidden="true">
            <span class="rw-script-line-num">${String(i + 1).padStart(2, "0")}</span>
            <span class="rw-script-line-dot"></span>
          </span>
          <span class="rw-script-line-body">
            <span class="rw-script-line-meta">
              <time class="rw-script-line-time">${escapeHtml(startTc)}</time>
              <span class="rw-script-line-status">${needsRetake ? "要修正" : statusLabel}${mergedTag}</span>
            </span>
            <span class="rw-script-line-text">${escapeHtml(displayText)}</span>
          </span>
        </button>
      `);
  }
  els.scriptList.innerHTML = parts.join("");
  renderMarkerList();
  syncScriptSelectToolbar();
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function applyScriptFromEditor() {
  const raw = els.scriptEditor?.value ?? "";
  const dur = ytPlayer?.getDuration() || 0;
  scriptLines = normalizeScriptLineTimings(
    expandScriptLinesWithInlineTimecodes(
      parseScriptLines(raw, { previousLines: scriptLines })
    ),
    dur
  );
  if (els.scriptEditor && scriptLines.length) {
    els.scriptEditor.value = scriptLinesToText(scriptLines);
  }
  if (!scriptLines.length) {
    setStatus("タイムコード形式の行が見つかりません。[00:02.00] のような行を追加してください。", "err");
    return;
  }
  focusedLineIndex = 0;
  recordStartByLineId.clear();
  takeClipPositionByLineId.clear();
  renderScriptList();
  renderSessionFlow();
  updateCueDisplay();
  syncPunchInUi();
  updateProgressBar();
  updateTakeUi();
  syncWaveformScriptRegions();
  jumpToRecordStart(getFocusedLine(), { play: false });
  setStatus(`${scriptLines.length} 行の台本を反映しました。波形に担当枠を表示しました。`, "ok");
}

function onScriptListClick(ev) {
  const item = ev.target.closest("[data-line-index]");
  if (!item) return;
  const idx = Number(item.getAttribute("data-line-index"));
  if (!Number.isFinite(idx)) return;
  if (scriptSelectMode) {
    toggleScriptLineSelected(idx);
    return;
  }
  setFocusedLineIndex(idx);
}

function setTakePreviewSource(audio, blobUrl) {
  try {
    const resolved = new URL(blobUrl, location.href).href;
    if (audio.src !== resolved) {
      audio.src = blobUrl;
      audio.load();
    }
  } catch {
    audio.src = blobUrl;
    audio.load();
  }
}

function syncTakePreviewPlayer(lineId) {
  const take = lineRecorder.getActiveTake(lineId);
  const wrap = els.takePreviewWrap;
  const audio = els.takePreview;
  if (!wrap || !audio) return;

  if (!take?.url) {
    wrap.hidden = true;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    return;
  }

  wrap.hidden = false;
  detachEditedAudioPreview(audio);
  setTakePreviewSource(audio, take.url);
}

function refreshScriptUiAfterLinesChange() {
  const line = getFocusedLine();
  if (line) activeLineId = line.id;
  renderScriptList();
  renderMarkerList();
  renderSessionFlow();
  syncWaveformScriptRegions();
  updateCueDisplay();
  syncPunchInUi();
  updateProgressBar();
  updateTakeUi();
  saveScriptStateToLocal();
}

function addScriptLineFromRail() {
  const last = scriptLines[scriptLines.length - 1];
  const startSec = last
    ? Math.max(0, (last.endSec ?? last.startSec + 3) + 0.5)
    : 2;
  const line = buildScriptLine({
    startSec,
    endSec: startSec + 3.5,
    text: "新しいセリフ"
  });
  scriptLines.push(line);
  if (els.scriptEditor) {
    els.scriptEditor.value = scriptLinesToText(scriptLines);
  }
  focusedLineIndex = scriptLines.length - 1;
  refreshScriptUiAfterLinesChange();
  setStatus(
    `台本に ${formatTimecode(startSec)} の行を追加しました。必要なら「台本を編集」で調整できます。`,
    "ok"
  );
}

async function waitForAudioCanPlay(audio) {
  await new Promise((resolve, reject) => {
    const done = () => {
      audio.removeEventListener("canplay", done);
      audio.removeEventListener("error", onErr);
      resolve(undefined);
    };
    const onErr = () => {
      audio.removeEventListener("canplay", done);
      reject(new Error("試聴音声の読み込みに失敗しました"));
    };
    audio.addEventListener("canplay", done, { once: true });
    audio.addEventListener("error", onErr, { once: true });
    audio.load();
    if (audio.readyState >= 2) done();
  });
}

async function playTakeForLine(lineId, { useDraft = false } = {}) {
  if (!lineRecorder.hasRecording(lineId)) {
    setStatus("まだ録音がありません。録音を停止してから試聴してください。", "err");
    return;
  }

  if (lineRecorder.isRecording(lineId) || lineRecorder.hasActiveSession(lineId)) {
    setStatus("録音を ■ 停止してから試聴してください。", "err");
    return;
  }

  const idx = lineRecorder.getActiveTakeIndex(lineId);
  const takes = lineRecorder.getTakes(lineId);
  const take = idx >= 0 && takes[idx] ? takes[idx] : lineRecorder.getActiveTake(lineId);
  if (!take?.url || !take.blob) {
    setStatus("録音ファイルが見つかりません。もう一度録音してください。", "err");
    return;
  }

  clearCueWatch();
  pauseReferencePlayback();

  const audio = els.takePreview;
  if (!audio) {
    setStatus("試聴プレイヤーが見つかりません。", "err");
    return;
  }

  if (els.takePreviewWrap) {
    els.takePreviewWrap.hidden = false;
    els.takePreviewWrap.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  const edit = useDraft
    ? lineRecorder.getTakeEditDraft(lineId, idx)
    : lineRecorder.getTakeEdit(lineId, idx);
  const srcDur =
    take.durationSec ??
    takeEditPreview?.getSourceDurationSec() ??
    (await probeBlobDurationSafe(take.blob));
  const label = lineRecorder.getTakeLabel(lineId, idx);
  const previewKey = takePreviewUrlKey(lineId, idx);
  const editNorm = normalizeTakeEdit(edit, srcDur);

  try {
    detachEditedAudioPreview(audio);
    audio.pause();
    audio.muted = false;
    audio.volume = 1;

    if (isTakeEditAtDefault(editNorm, srcDur)) {
      setTakePreviewSource(audio, take.url);
      audio.currentTime = 0;
      await waitForAudioCanPlay(audio);
      await audio.play();
    } else {
      setTakePreviewSource(audio, take.url);
      audio.currentTime = editNorm.trimStartSec;
      await waitForAudioCanPlay(audio);
      try {
        await playEditedAudioPreview(audio, {
          trimStartSec: editNorm.trimStartSec,
          trimEndSec: editNorm.trimEndSec,
          gain: editNorm.gain,
          srcDurationSec: srcDur
        });
      } catch {
        setStatus(`${label} を編集反映してデコード中…`, "info");
        const url = await createEditedPreviewUrl(take.blob, editNorm, 48000);
        storePreviewUrl(previewKey, url);
        detachEditedAudioPreview(audio);
        setTakePreviewSource(audio, url);
        audio.currentTime = 0;
        await waitForAudioCanPlay(audio);
        await audio.play();
      }
    }

    setStatus(
      `${label} を再生中（${useDraft ? "編集プレビュー" : "適用済み"}・音量 ${Math.round(editNorm.gain * 100)}%）`,
      "ok"
    );
  } catch (err) {
    try {
      detachEditedAudioPreview(audio);
      setTakePreviewSource(audio, take.url);
      audio.currentTime = 0;
      await waitForAudioCanPlay(audio);
      await audio.play();
      setStatus(`${label} を再生中（録音データを直接再生）`, "ok");
    } catch {
      setStatus(
        `試聴の再生に失敗: ${err instanceof Error ? err.message : String(err)}`,
        "err"
      );
    }
  }
}

async function probeBlobDurationSafe(blob) {
  try {
    return await probeBlobDurationSec(blob);
  } catch {
    return 0;
  }
}

async function stopRecording(lineId) {
  if (!lineRecorder.isRecording(lineId)) {
    setRecordingUi(false);
    setCueWaitUi(false);
    stopLiveMicWaveform();
    restoreReferencePlayback();
    updateBoothBarUi();
    return;
  }
  const blob = await lineRecorder.stop(lineId);
  setRecordingUi(false);
  setCueWaitUi(false);
  stopLiveMicWaveform();
  updateBoothBarUi();
  if (!blob || blob.size < 44) {
    const fail = lineRecorder.getLastFailReason();
    if (fail?.reason === "empty") {
      setStatus(
        fail.message ||
          `録音データが空でした（${fail.chunks ?? 0} チャンク / ${fail.size ?? 0} bytes）。マイク入力デバイスを確認して再録音してください。`,
        "err"
      );
    } else if (fail?.reason === "error") {
      setStatus(`録音エラー: ${fail.message || "不明"}`, "err");
    } else {
      setStatus(
        "録音データが空でした。もう一度収録ブースから試してください。",
        "err"
      );
    }
  } else {
    const line = scriptLines.find((l) => l.id === lineId);
    const lineNum = line ? scriptLines.indexOf(line) + 1 : 0;
    const count = lineRecorder.getTakeCount(lineId);
    const idx = lineRecorder.getActiveTakeIndex(lineId);
    const take = idx >= 0 ? lineRecorder.getTakes(lineId)[idx] : null;
    if (waveform?.ready && blob && line) {
      await waveform.setTakeForLine(lineId, blob, {
        positionSec: getTakeClipPositionSec(line) + audioOffsetSec,
        lineNum: getScriptLineNum(lineId),
        edit: lineRecorder.getTakeEdit(lineId, idx)
      });
    }
    let retakeSubmitted = false;
    if (cueRetakeStore?.getActiveRequestForCue(lineId) && take) {
      retakeSubmitted = cueRetakeStore.markCueSubmitted(lineId, {
        takeId: take.id,
        takeIndex: idx
      });
      if (retakeSubmitted) {
        cueRetakeStore.persistLocal();
        syncRetakeUi();
      }
    }
    const done = scriptLines.filter((l) => lineRecorder.hasRecording(l.id)).length;
    const total = scriptLines.length;
    const allDone = done >= total && total > 0;
    renderSessionFlow();
    if (allDone) {
      setStatus(
        `音声 ${lineNum} 完了 — 全 ${total} セリフ収録済み。「全セリフを繋げて試聴」で通し確認できます。`,
        "ok"
      );
    } else if (lineNum > 0) {
      setStatus(
        retakeSubmitted
          ? `音声 ${lineNum} を再収録して提出しました（要修正を解消）。${done}/${total} 収録済。`
          : `音声 ${lineNum} 完了（Take ${count}）— ${done}/${total} 収録済。`,
        "ok"
      );
    } else {
      setStatus(
        retakeSubmitted
          ? `Take ${count} を再提出しました（要修正を解消）。`
          : `Take ${count} を保存しました。`,
        "ok"
      );
    }
  }
  updateTakeUi();
  updateProgressBar();
  renderScriptList();
  syncTakePreviewPlayer(lineId);
  restoreReferencePlayback();
  adrSessionAbort = null;
  document.body.classList.remove("rw-adr-preroll", "rw-adr-countdown", "rw-adr-recording");
  hideAdrOverlay(els.adrOverlay);
  boothShowCountdown = false;
  const wasInBooth = document.body.classList.contains("rw-booth-mode");
  if (wasInBooth && holdToRecordOn) {
    document.body.classList.remove(
      "rw-adr-preroll",
      "rw-adr-countdown",
      "rw-adr-recording"
    );
    hideAdrOverlay(els.adrOverlay);
    setRecordingUi(false);
    stopLiveMicWaveform();
    boothSessionLineId = lineId;
    document.body.classList.add("rw-booth-mode", "rw-adr-active", "rw-adr-standby");
    try {
      await lineRecorder.arm(lineId);
      setStatus(
        "Take を保存しました。Space を押し続ければ同じセリフでもう 1 テイク録れます。",
        "ok"
      );
    } catch {
      clearAdrSessionUi();
    }
    updateBoothBarUi();
    void syncTakeEditStudio();
  } else if (wasInBooth) {
    clearAdrSessionUi();
    void syncTakeEditStudio();
  }
}

function pauseReferencePlayback() {
  if (!isPlaying && !waveform?.isPlayingNow?.()) return;
  const savedWaveT = waveform?.getCurrentTime() ?? 0;
  const ytT = videoTimeFromWave(savedWaveT);
  isPlaying = false;
  refPauseGuardUntil = performance.now() + 600;
  suppressYtPoll = true;
  waveform?.pause();
  ytPlayer?.pause();
  requestAnimationFrame(() => {
    waveform?.setTime(savedWaveT, { scroll: false });
    updateTimeDisplay(ytT);
    syncMultitrackSeekSlider(ytT);
    if (ytPlayer?.ready) {
      const ytNow = ytPlayer.getCurrentTime() ?? 0;
      if (Math.abs(ytNow - ytT) > 0.12) {
        ytPlayer.seekTo(ytT, true);
      }
      lastYtPollT = ytT;
    }
    suppressYtPoll = false;
  });
  if (els.playPauseBtn) els.playPauseBtn.textContent = REF_PLAY_BTN_LABEL;
}

function stopPlayback({ fromYouTube = false } = {}) {
  clearCueWatch();
  isPlaying = false;
  if (!fromYouTube) {
    suppressYtPoll = true;
    ytPlayer?.pause();
    requestAnimationFrame(() => {
      suppressYtPoll = false;
    });
  }
  waveform?.pause();
  if (els.takePreview) els.takePreview.pause();
  if (els.playPauseBtn) els.playPauseBtn.textContent = REF_PLAY_BTN_LABEL;
}

async function togglePlayPause() {
  if (adrSessionAbort || adrReferencePlaying) {
    setStatus("プレロール／カウント中です。■ 停止でキャンセルできます。", "info");
    return;
  }
  if (isMicCaptureActive()) {
    setStatus("録音中はお手本を止めています。■ 録音停止で終了してください。", "info");
    return;
  }
  if (!waveform?.ready) {
    setStatus("先に ② 動画+音声読込 を押してください。", "err");
    return;
  }

  if (isPlaying || waveform.isPlayingNow()) {
    pauseReferencePlayback();
    return;
  }

  if (els.playPauseBtn) els.playPauseBtn.textContent = REF_PAUSE_BTN_LABEL;
  const audioOk = await waveform.play();
  if (!audioOk) {
    const safariNote = isSafariBrowser()
      ? " Safari では波形を一度クリックしてから ▶ を押してください。"
      : "";
    setStatus(
      `音声の再生を開始できませんでした。${safariNote} ② を押し直してください。`,
      "err"
    );
    if (els.playPauseBtn) els.playPauseBtn.textContent = REF_PLAY_BTN_LABEL;
    return;
  }

  isPlaying = true;
  if (ytPlayer?.ready) {
    ytPlayer.setMuted(true);
    const waveT = waveform.getCurrentTime();
    const ytT = videoTimeFromWave(waveT);
    suppressYtPoll = true;
    ytPlayer.seekTo(ytT, true);
    lastYtPollT = ytT;
    ytPlayer.play();
    requestAnimationFrame(() => {
      suppressYtPoll = false;
    });
  }
}

function hydrateProxyFields() {
  const lsUrl = localStorage.getItem("wavrick_audio_proxy_url");
  const lsSec = localStorage.getItem("wavrick_audio_proxy_secret");
  const def = readProxyConfig();
  let url = lsUrl || def.extractUrl || "";
  const host = location.hostname.toLowerCase();
  const isLocalDev =
    host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  if (
    isLocalDev &&
    url &&
    (url.includes("127.0.0.1:5055") || url.includes("localhost:5055") || url.startsWith("/api/"))
  ) {
    url = resolveExtractUrl("/api/youtube-audio/extract");
    localStorage.setItem("wavrick_audio_proxy_url", url);
  } else if (url) {
    url = resolveExtractUrl(url);
  }
  if (els.proxyUrl) els.proxyUrl.value = url;
  if (els.proxySecret) els.proxySecret.value = lsSec || def.secret || "";
}

function bindRecordButtons() {
  els.openBoothBtn?.addEventListener("click", (ev) => {
    ev?.preventDefault?.();
    ev?.stopPropagation?.();
    syncWorkspaceToBoothAndNavigate();
  });
  els.boothReadyBtn?.addEventListener("click", onBoothReadyClick);
  els.boothStartBtn?.addEventListener("click", () => void beginAdrPunchInFromBooth());
  els.boothStopBtn?.addEventListener("click", () => void stopBoothRecording());
  els.boothCloseBtn?.addEventListener("click", () => void cancelRecordingBooth());
}

/**
 * 編集画面の台本・テイク・設定を localStorage に保存し、収録ブースへ遷移
 */
function syncWorkspaceToBoothAndNavigate() {
  const ytDur = ytPlayer?.getDuration() || 0;
  const timedLines = normalizeScriptLineTimings(scriptLines, ytDur);
  const lines = [];
  for (let i = 0; i < timedLines.length; i++) {
    const l = timedLines[i];
    const prev = i > 0 ? timedLines[i - 1] : null;
    const isBlockStart = i > 0 && isAutoBlockBoundary(prev, l);

    if (l.isMergedCue && Array.isArray(l.segments) && l.segments.length > 1) {
      l.segments.forEach((seg, segIdx) => {
        const nextSeg = l.segments[segIdx + 1] || timedLines[i + 1] || null;
        const entry = {
          id: (seg.sourceLineId || l.id) + "-seg" + segIdx,
          startSec: seg.startSec,
          endSec:
            seg.endSec != null && seg.endSec > seg.startSec
              ? seg.endSec
              : inferredLineEndSec(
                  { startSec: seg.startSec, endSec: seg.endSec },
                  nextSeg
                    ? { startSec: nextSeg.startSec }
                    : null
                ),
          text: seg.text || "",
          rawTc: seg.rawTc || ""
        };
        if (segIdx === 0 && isBlockStart) entry.blockBreak = true;
        lines.push(entry);
      });
    } else {
      const next = timedLines[i + 1] || null;
      const entry = {
        id: l.id,
        startSec: l.startSec,
        endSec: inferredLineEndSec(l, next, i === timedLines.length - 1 ? ytDur : 0),
        text: l.text,
        rawTc: l.rawTc
      };
      if (isBlockStart) entry.blockBreak = true;
      lines.push(entry);
    }
  }

  const boothPayload = {
    scriptLines: lines,
    focusedLineIndex,
    takes: {},
    settings: {
      preRollSec,
      countdownBeepsOn,
      holdToRecordOn,
      audioOffsetSec
    },
    youtubeUrl: els.ytUrl?.value?.trim() || "",
    rawAudioUrl: referenceAudioRawUrl || "",
    cleanedAudioUrl: referenceAudioCleanedUrl || "",
    durationSec: ytDur,
    timestamp: Date.now()
  };

  for (const line of scriptLines) {
    const takes = lineRecorder.getTakes(line.id);
    if (takes && takes.length > 0) {
      boothPayload.takes[line.id] = {
        count: takes.length,
        activeIndex: lineRecorder.getActiveTakeIndex(line.id),
        items: takes.map((t, i) => ({
          name: t.name || `Take ${i + 1}`,
          durationSec: t.durationSec || 0,
          startSec: t.startSec ?? line.startSec,
          endSec: t.endSec ?? line.endSec
        }))
      };
    }
  }

  try {
    localStorage.setItem("wavrick_booth_sync", JSON.stringify(boothPayload));
    if (window.__wavrick_booth_nav_handled) window.__wavrick_booth_nav_handled();
  } catch (e) {
    console.warn("booth sync: localStorage write failed", e);
  }
  window.location.href = "./record-booth.html";
}

function bindEvents() {
  els.preRoll?.addEventListener("change", () => {
    preRollSec = Math.max(0, Number(els.preRoll?.value) || 0);
  });
  els.autoRecordAtCue?.addEventListener("change", () => {
    autoRecordAtCue = Boolean(els.autoRecordAtCue?.checked);
  });
  els.countdownBeeps?.addEventListener("change", () => {
    countdownBeepsOn = Boolean(els.countdownBeeps?.checked);
  });
  els.holdToRecord?.addEventListener("change", () => {
    holdToRecordOn = Boolean(els.holdToRecord?.checked);
    try {
      localStorage.setItem(HOLD_TO_RECORD_KEY, holdToRecordOn ? "1" : "0");
    } catch {
      /* ignore */
    }
    setStatus(
      holdToRecordOn
        ? "押している間録音: 収録ブース内で Space を押し続けると収録、離すと停止。"
        : "押している間録音をオフにしました。",
      "ok"
    );
  });
  els.prevLineBtn?.addEventListener("click", goPrevLine);
  els.nextLineBtn?.addEventListener("click", goNextLine);
  els.cueBtn?.addEventListener("click", () =>
    jumpToRecordStart(getFocusedLine(), { play: true })
  );
  els.setPunchBtn?.addEventListener("click", setPunchInFromPlayhead);
  els.jumpPunchBtn?.addEventListener("click", () =>
    jumpToRecordStart(getFocusedLine(), { play: false })
  );
  els.resetPunchBtn?.addEventListener("click", resetPunchInToScript);
  els.playConcatBtn?.addEventListener("click", () => void playConcatenatedTakes());
  els.downloadConcatBtn?.addEventListener("click", downloadConcatenatedTakes);
  els.queueDeliveryBtn?.addEventListener("click", () => void queueDeliveryForCase());
  els.caseManageLink?.addEventListener("click", () => {
    sessionStorage.setItem("wavrick_go", "work");
    if (workspaceRequestId) {
      sessionStorage.setItem("wavrick_work_selected_request_id", workspaceRequestId);
    }
  });
  els.flowList?.addEventListener("click", (ev) => {
    const item = ev.target.closest("[data-line-index]");
    if (!item) return;
    const idx = Number(item.getAttribute("data-line-index"));
    if (Number.isFinite(idx)) setFocusedLineIndex(idx);
  });
  bindRecordButtons();
  els.addScriptLineBtn?.addEventListener("click", addScriptLineFromRail);
  els.stopBtn?.addEventListener("click", () => void stopBoothRecording());
  const bindPlayTake = () => {
    const line = getFocusedLine();
    if (line) void playTakeForLine(line.id);
  };
  els.playTakeBtn?.addEventListener("click", bindPlayTake);
  els.playTakeTransportBtn?.addEventListener("click", bindPlayTake);
  const applyTakeRename = (input) => {
    const line = getFocusedLine();
    if (!line) return;
    const idx = Number(input.getAttribute("data-rename-take"));
    if (!Number.isFinite(idx)) return;
    lineRecorder.setTakeLabel(line.id, idx, input.value);
    renderTakeDesk();
  };

  els.takeCards?.addEventListener("input", (ev) => {
    const input = ev.target.closest("[data-rename-take]");
    if (!input || !(input instanceof HTMLInputElement)) return;
    applyTakeRename(input);
  });

  els.takeCards?.addEventListener("change", (ev) => {
    const input = ev.target.closest("[data-rename-take]");
    if (!input || !(input instanceof HTMLInputElement)) return;
    applyTakeRename(input);
  });

  const onTakeEditInput = () => updateTakeEditDraftFromPanel();
  els.takeGain?.addEventListener("input", onTakeEditInput);
  els.takeTrimStart?.addEventListener("input", onTakeEditInput);
  els.takeTrimEnd?.addEventListener("input", onTakeEditInput);
  els.takeEditApplyBtn?.addEventListener("click", () => applyTakeEditsFromPanel());
  els.takeEditPreviewBtn?.addEventListener("click", () => {
    const line = getFocusedLine();
    if (line) void playTakeForLine(line.id, { useDraft: true });
  });
  els.takeEditResetBtn?.addEventListener("click", () => {
    const line = getFocusedLine();
    if (!line) return;
    const idx = lineRecorder.getActiveTakeIndex(line.id);
    if (idx < 0) return;
    lineRecorder.resetTakeEdit(line.id, idx);
    lastConcatBlob = null;
    if (waveform?.ready) {
      const edit = lineRecorder.getTakeEdit(line.id, idx);
      waveform.setClipEdit(line.id, edit);
    }
    renderTakeEditor();
    setStatus("Take の編集をリセットしました。", "ok");
  });

  els.takeCards?.addEventListener("click", (ev) => {
    if (ev.target.closest("[data-rename-take]")) return;
    const line = getFocusedLine();
    if (!line) return;
    const card = ev.target.closest("[data-take-index]");
    if (
      card &&
      isFeatureOn("takeColorLabels") &&
      !ev.target.closest("[data-play-take]") &&
      !ev.target.closest("[data-select-take]") &&
      !ev.target.closest("[data-del-take]")
    ) {
      const idx = Number(card.getAttribute("data-take-index"));
      if (Number.isFinite(idx)) {
        const st = lineRecorder.cycleTakeStatus(line.id, idx);
        renderTakeDesk();
        const names = {
          candidate: "採用候補",
          ng: "NG",
          redo: "要再録"
        };
        setStatus(
          `Take ${idx + 1}: ${st ? names[st] ?? st : "ラベルなし"}（クリックで切替）`,
          "ok"
        );
      }
      return;
    }
    const delBtn = ev.target.closest("[data-del-take]");
    if (delBtn) {
      const idx = Number(delBtn.getAttribute("data-del-take"));
      if (!Number.isFinite(idx)) return;
      const n = lineRecorder.getTakeCount(line.id);
      if (
        !window.confirm(
          `Take ${idx + 1} を削除しますか？${n <= 1 ? "（このセリフの収録がなくなります）" : ""}`
        )
      ) {
        return;
      }
      lineRecorder.moveTakeToTrash(line.id, idx);
      if (!lineRecorder.hasRecording(line.id)) {
        takeClipPositionByLineId.delete(line.id);
      }
      renderTrashPanel();
      updateTakeUi();
      renderTakeDesk();
      void syncTakeEditStudio();
      setStatus(`Take ${idx + 1} をゴミ箱に移しました。`, "ok");
      return;
    }
    const playBtn = ev.target.closest("[data-play-take]");
    if (playBtn) {
      const idx = Number(playBtn.getAttribute("data-play-take"));
      if (Number.isFinite(idx)) {
        lineRecorder.setActiveTake(line.id, idx);
        void playTakeForLine(line.id);
      }
      return;
    }
    const selBtn = ev.target.closest("[data-select-take]");
    if (selBtn) {
      const idx = Number(selBtn.getAttribute("data-select-take"));
      if (Number.isFinite(idx)) {
        selectTakeForEditing(line.id, idx);
      }
    }
  });

  bindKeyboardShortcuts();

  document.querySelectorAll("[data-video-mode].rw-btn-mode").forEach((btn) => {
    btn.addEventListener("click", () => {
      const mode = btn.getAttribute("data-video-mode");
      if (mode === "normal" || mode === "mini" || mode === "hidden") {
        setVideoMode(mode);
      }
    });
  });

  els.showVideoBtn?.addEventListener("click", () => {
    setVideoMode("mini");
  });

  els.saveProxyBtn?.addEventListener("click", () => {
    const u = els.proxyUrl?.value?.trim() || "";
    const s = els.proxySecret?.value?.trim() || "";
    if (u) localStorage.setItem("wavrick_audio_proxy_url", resolveExtractUrl(u));
    else localStorage.removeItem("wavrick_audio_proxy_url");
    if (s) localStorage.setItem("wavrick_audio_proxy_secret", s);
    else localStorage.removeItem("wavrick_audio_proxy_secret");
    hydrateProxyFields();
    setStatus("プロキシ URL / シークレットを保存しました（localStorage）。", "ok");
  });

  els.loadVideoBtn?.addEventListener("click", () => {
    const btn = els.loadVideoBtn;
    const label = btn?.textContent || "";
    if (btn) {
      btn.disabled = true;
      btn.textContent = "読込中…";
    }
    void loadVideoAndVocalAudio()
      .catch((err) => {
        setStatus(err instanceof Error ? err.message : String(err), "err");
      })
      .finally(() => {
        if (btn) {
          btn.disabled = false;
          btn.textContent = label || "② 動画読込";
        }
      });
  });

  els.loadWaveBtn?.addEventListener("click", () => {
    const btn = els.loadWaveBtn;
    const label = btn?.textContent || "";
    if (btn) {
      btn.disabled = true;
      btn.textContent = "取得中…";
    }
    void loadWaveformFromProxy()
      .catch((err) => {
        setStatus(err instanceof Error ? err.message : String(err), "err");
      })
      .finally(() => {
        if (btn) {
          btn.disabled = false;
          btn.textContent = label || "③ 波形読込";
        }
      });
  });

  els.audioFile?.addEventListener("change", () => {
    const file = els.audioFile?.files?.[0];
    const fileLabel = document.querySelector(".rw-file-label span");
    if (fileLabel) {
      fileLabel.textContent = file ? file.name.slice(0, 24) : "音声ファイル";
    }
    if (file) void loadWaveformFromFile(file);
  });

  els.noiseToggleBtn?.addEventListener("click", () => void toggleNoiseRemoval());

  els.ytUrl?.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      if (extractYouTubeVideoId(els.ytUrl?.value || "")) void loadVideoAndVocalAudio();
    }
  });

  els.playPauseBtn?.addEventListener("click", () => void togglePlayPause());

  els.audioOffset?.addEventListener("input", () => {
    audioOffsetSec = Number(els.audioOffset.value) || 0;
    const label = document.getElementById("rwAudioOffsetVal");
    if (label) {
      label.textContent = `${audioOffsetSec >= 0 ? "+" : ""}${audioOffsetSec.toFixed(1)}秒`;
    }
    if (ytPlayer?.ready) {
      const t = ytPlayer.getCurrentTime();
      waveform?.setTime(waveTimeFromVideo(t), { scroll: false });
    }
    syncWaveformScriptRegions();
  });

  els.applyScriptBtn?.addEventListener("click", applyScriptFromEditor);

  els.scriptList?.addEventListener("click", onScriptListClick);
  els.scriptSelectModeBtn?.addEventListener("click", toggleScriptSelectMode);
  els.scriptMergeBtn?.addEventListener("click", () => void applyMergeSelectedScriptLines());
  els.scriptSplitBtn?.addEventListener("click", () => void applySplitFocusedMergedLine());
  els.undoBtn?.addEventListener("click", () => void undoWorkspaceEdit());
  els.redoBtn?.addEventListener("click", () => void redoWorkspaceEdit());
  els.saveSessionBtn?.addEventListener("click", () => void saveWorkspaceToAccount());
  els.teleprompterScroll?.addEventListener(
    "wheel",
    () => {
      teleprompterManualScrollUntil = Date.now() + 4000;
    },
    { passive: true }
  );
  els.teleprompterScroll?.addEventListener("touchstart", () => {
    teleprompterManualScrollUntil = Date.now() + 4000;
  });
  updateExcelBarButtons();

  window.addEventListener("beforeunload", () => {
    stopYtPoll();
    stopPlayback();
    lineRecorder.release();
    revokeConcatUrl();
    revokeAudioUrl();
    ytPlayer?.destroy();
    waveform?.destroy();
  });
}

function realignScriptToVideoDuration(durationSec, whisperSegments = null) {
  if (!(durationSec > 1)) return;
  const resolvedDur = resolveTimelineDurationSec(durationSec, whisperSegments);
  const rePrepared = prepareScriptForWorkspace(
    els.scriptEditor?.value || scriptLinesToText(scriptLines),
    resolvedDur,
    {
      whisperSegments,
      whisperDurationSec: resolvedDur
    }
  );
  if (rePrepared.script) {
    scriptLines = normalizeScriptLineTimings(
      expandScriptLinesWithInlineTimecodes(
        parseScriptLines(rePrepared.script, { previousLines: scriptLines })
      ),
      resolvedDur
    );
  } else {
    scriptLines = normalizeScriptLineTimings(scriptLines, resolvedDur);
  }
  if (els.scriptEditor) els.scriptEditor.value = scriptLinesToText(scriptLines);
}

function applyImportedScript(rawScript, durationSec = 0, opts = {}) {
  const explicit =
    durationSec > 1
      ? durationSec
      : Number(opts.whisperDurationSec) > 0
        ? Number(opts.whisperDurationSec)
        : 0;
  const dur = resolveTimelineDurationSec(
    explicit,
    opts.whisperSegments || null
  );
  const prepared = prepareScriptForWorkspace(rawScript, dur, {
    whisperSegments: opts.whisperSegments || null,
    whisperDurationSec: dur
  });
  if (!prepared.script || prepared.lineCount < 1) {
    setStatus(
      "引き継いだ台本をタイムコード形式に変換できませんでした。エディタに [00:02.00] 形式で貼り直してください。",
      "err"
    );
    return false;
  }
  if (els.scriptEditor) els.scriptEditor.value = prepared.script;
  scriptLines = normalizeScriptLineTimings(
    expandScriptLinesWithInlineTimecodes(
      parseScriptLines(prepared.script, { previousLines: scriptLines })
    ),
    dur
  );
  focusedLineIndex = 0;
  recordStartByLineId.clear();
  renderScriptList();
  renderSessionFlow();
  updateCueDisplay();
  syncPunchInUi();
  updateProgressBar();
  updateTakeUi();
  syncWaveformScriptRegions();

  // 案件から取得した台本を即座にローカル保存（リフレッシュ後も保持）
  forceScriptStateSave();

  persistTimecodedScriptToRequest({
    videoUrl: els.ytUrl?.value?.trim() || "",
    requestId: workspaceRequestId || globalThis.WavrickWorkCases?.getSelectedCaseId?.(),
    script: scriptLinesToText(scriptLines),
    whisperSegments: opts.whisperSegments || null,
    whisperDurationSec: opts.whisperDurationSec || dur
  });

  if (prepared.source === "estimated") {
    setStatus(
      `依頼フォームの台本を ${prepared.lineCount} 行に分割し、動画長に合わせた仮タイムコードを付けました。波形を見ながら [00:xx] を直してください。`,
      "ok"
    );
  } else if (prepared.source === "whisper-aligned") {
    setStatus(
      `生成台本 ${prepared.lineCount} 行に、文字起こしのタイミングを当てはめました（先頭・末尾・3秒以上の間は行分割）。`,
      "ok"
    );
  } else if (prepared.source === "whisper") {
    setStatus(
      `文字起こしのタイミングから台本 ${prepared.lineCount} 行を作成しました（3秒以上の間は行を分けています）。`,
      "ok"
    );
  } else {
    setStatus(
      `依頼フォームから台本 ${prepared.lineCount} 行を読み込みました（先頭・末尾のタイムコードを反映済み）。`,
      "ok"
    );
  }
  return true;
}

function populateRwCaseSelect() {
  const cases = globalThis.WavrickWorkCases;
  const sel = els.caseSelect;
  if (!cases || !sel) return;
  let rows = cases.getVisibleCasesSync();
  if (rows.length === 0) {
    rows = cases.getMergedYoutubeRequestsSync();
  }
  const selectedId = workspaceRequestId || cases.getSelectedCaseId();
  sel.innerHTML = rows.length
    ? rows
        .map(
          (r) =>
            `<option value="${escapeHtml(r.requestId)}">${escapeHtml(cases.formatCaseLabel(r))}</option>`
        )
        .join("")
    : `<option value="">案件がありません</option>`;
  if (selectedId && rows.some((r) => r.requestId === selectedId)) {
    sel.value = selectedId;
  } else if (rows[0]?.requestId) {
    sel.value = rows[0].requestId;
    cases.setSelectedCaseId(rows[0].requestId);
  }
  syncActiveCaseUi();
}

function resolveScriptForWorkspacePayload(payload, videoUrl) {
  let script = String(payload?.script || "").trim();
  if (script) return script;
  try {
    const rows = JSON.parse(
      localStorage.getItem("wavrick_youtube_requests") || "[]"
    );
    const id = String(payload?.requestId || "").trim();
    const match =
      (id && rows.find((r) => r.requestId === id)) ||
      rows.find((r) => r.videoUrl === videoUrl && r.script);
    if (match?.script) return String(match.script).trim();
  } catch {
    /* ignore */
  }
  return "";
}

function resolveWhisperForWorkspacePayload(payload, videoUrl) {
  if (Array.isArray(payload?.whisperSegments) && payload.whisperSegments.length) {
    return {
      whisperSegments: payload.whisperSegments,
      whisperDurationSec: Number(payload.whisperDurationSec) || 0
    };
  }
  try {
    const rows = JSON.parse(
      localStorage.getItem("wavrick_youtube_requests") || "[]"
    );
    const id = String(payload?.requestId || "").trim();
    const match =
      (id && rows.find((r) => r.requestId === id)) ||
      rows.find((r) => r.videoUrl === videoUrl);
    if (match?.whisperSegments?.length) {
      return {
        whisperSegments: match.whisperSegments,
        whisperDurationSec: Number(match.whisperDurationSec) || 0
      };
    }
  } catch {
    /* ignore */
  }
  return { whisperSegments: null, whisperDurationSec: 0 };
}

async function applyRequestToWorkspace(payload) {
  const videoUrl = String(payload.videoUrl || "").trim();
  const script = resolveScriptForWorkspacePayload(payload, videoUrl);
  const requestId = payload.requestId || null;
  if (!videoUrl) return false;

  if (payload.rawAudioUrl) referenceAudioRawUrl = payload.rawAudioUrl;
  if (payload.cleanedAudioUrl) referenceAudioCleanedUrl = payload.cleanedAudioUrl;
  syncNoiseToggleUi();

  if (requestId && globalThis.WavrickWorkCases?.setSelectedCaseId) {
    globalThis.WavrickWorkCases.setSelectedCaseId(requestId);
  }

  initCueRetakeForProject(
    payload.projectId || projectIdFromRequest(requestId),
    { requestId }
  );
  populateRwCaseSelect();

  if (els.ytUrl) els.ytUrl.value = videoUrl;
  const videoId = extractYouTubeVideoId(videoUrl);
  if (!videoId) {
    setStatus("YouTube URL が無効です。", "err");
    return false;
  }

  const whisperMeta = resolveWhisperForWorkspacePayload(payload, videoUrl);
  const whisperDur =
    Number(payload.whisperDurationSec) ||
    whisperMeta.whisperDurationSec ||
    0;
  let scriptOk = false;

  // 台本を先に反映（②読込は2〜4分かかるため、後回しにすると空の編集画面に見える）
  if (script) {
    scriptOk = applyImportedScript(script, whisperDur, {
      whisperSegments: whisperMeta.whisperSegments,
      whisperDurationSec: whisperDur
    });
    if (scriptOk) {
      setStatus(
        "台本を読み込みました。動画プレビューとお手本音声を取得しています…",
        "ok"
      );
    }
  } else {
    setStatus("台本が空です。エディタに貼り付けるか、依頼フォームから再度開いてください。", "err");
  }

  void mountYouTube(videoId, { quiet: true }).then((videoOk) => {
    if (!scriptOk || !scriptLines.length) return;
    const ytDur = ytPlayer?.getDuration() || whisperDur || 0;
    if (ytDur <= 1) return;
    realignScriptToVideoDuration(ytDur, whisperMeta.whisperSegments);
    renderScriptList();
    renderSessionFlow();
    updateCueDisplay();
    syncWaveformScriptRegions();
    forceScriptStateSave();
    if (videoOk) {
      setStatus(
        `台本 ${scriptLines.length} 行を動画の長さ（${formatTimecode(ytDur)}）に合わせました。② 動画+音声読込 で波形を取得できます。`,
        "ok"
      );
    }
  });

  try {
    await loadVideoAndVocalAudio();
    if (scriptOk && scriptLines.length) {
      const ytDur = ytPlayer?.getDuration() || whisperDur || 0;
      if (ytDur > 1) {
        realignScriptToVideoDuration(ytDur, whisperMeta.whisperSegments);
        syncWaveformScriptRegions();
        forceScriptStateSave();
      }
    } else if (!script && !waveform?.ready) {
      setStatus("動画を読み込みました。台本が空の場合はエディタに貼り付けてください。", "info");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (scriptOk) {
      setStatus(
        `台本は表示済みです。お手本音声の取得に失敗しました: ${msg}`,
        "err"
      );
    } else {
      setStatus(msg, "err");
    }
  }

  return scriptOk || Boolean(script);
}

async function applyHandoffIfAny() {
  const handoff = consumeHandoff();
  if (!handoff) return false;
  return applyRequestToWorkspace(handoff);
}

async function applySelectedCaseIfAny() {
  const cases = globalThis.WavrickWorkCases;
  if (!cases) return false;

  // 選択中の案件IDで検索
  const id = cases.getSelectedCaseId();
  if (id) {
    const request = cases.findCaseById(id);
    if (request?.videoUrl) {
      return applyRequestToWorkspace({
        videoUrl: request.videoUrl,
        script: request.script,
        requestId: request.requestId,
        whisperSegments: request.whisperSegments || null,
        whisperDurationSec: request.whisperDurationSec || 0
      });
    }
  }

  // ログイン無し or 案件ID未選択の場合: 最新の台本付き案件を自動選択
  const allRequests = cases.getMergedYoutubeRequestsSync();
  if (!allRequests || allRequests.length === 0) return false;
  const withScript = allRequests.filter(r => r.script && r.videoUrl);
  const target = withScript.length > 0 ? withScript[withScript.length - 1] : null;
  if (!target) return false;
  cases.setSelectedCaseId(target.requestId);
  return applyRequestToWorkspace({
    videoUrl: target.videoUrl,
    script: target.script,
    requestId: target.requestId,
    whisperSegments: target.whisperSegments || null,
    whisperDurationSec: target.whisperDurationSec || 0
  });
}

async function onRwCaseSelectChange() {
  const cases = globalThis.WavrickWorkCases;
  const sel = els.caseSelect;
  if (!cases || !sel?.value) return;
  const request = cases.findCaseById(sel.value);
  if (!request) return;
  cases.setSelectedCaseId(request.requestId);
  setStatus("案件を切り替えています…", "info");
  await applyRequestToWorkspace({
    videoUrl: request.videoUrl,
    script: request.script,
    requestId: request.requestId,
    whisperSegments: request.whisperSegments || null,
    whisperDurationSec: request.whisperDurationSec || 0
  });
}

async function init() {
  initCueRetakeForProject(workspaceProjectId, { requestId: null });
  lineRecorder.forceReset();
  restoreReferencePlayback();
  preRollSec = Math.max(0, Number(els.preRoll?.value) || 0);
  if (els.autoRecordAtCue) els.autoRecordAtCue.checked = false;
  autoRecordAtCue = false;
  if (els.countdownBeeps) els.countdownBeeps.checked = true;
  countdownBeepsOn = true;
  try {
    holdToRecordOn = localStorage.getItem(HOLD_TO_RECORD_KEY) === "1";
    if (els.holdToRecord) els.holdToRecord.checked = holdToRecordOn;
  } catch {
    holdToRecordOn = false;
  }
  hydrateProxyFields();
  initVideoMode();
  bindMiniVideoDrag();
  if (els.scriptEditor) els.scriptEditor.value = "";
  scriptLines = [];
  focusedLineIndex = 0;
  renderScriptList();
  renderSessionFlow();
  renderTakeDesk();
  updateCueDisplay();
  syncPunchInUi();
  updateProgressBar();
  updateTakeUi();
  updateConcatButtons();
  updateVocalBadge();
  bindEvents();
  bindWorkspaceFeatureSettings();
  bindTopbarPanels();
  applyWorkspaceFeatureUi();
  setRecordingUi(false);
  updateBoothBarUi();
  createWaveformPlayer();
  syncWaveformScriptRegions();

  window.scrollTo(0, 0);

  populateRwCaseSelect();
  els.caseSelect?.addEventListener("change", () => {
    void onRwCaseSelectChange().catch((err) => {
      setStatus(err instanceof Error ? err.message : String(err), "err");
    });
  });

  try {
    const storedRef = JSON.parse(localStorage.getItem("wavrick_reference_audio") || "null");
    if (storedRef) {
      if (storedRef.rawAudioUrl) referenceAudioRawUrl = storedRef.rawAudioUrl;
      if (storedRef.cleanedAudioUrl) referenceAudioCleanedUrl = storedRef.cleanedAudioUrl;
      syncNoiseToggleUi();
    }
  } catch { /* */ }

  // 初期復元中はローカル保存を抑制（クラウド復元が上書きするのを防ぐ）
  _suppressScriptSave = true;

  const hadHandoff = await applyHandoffIfAny();
  let restoredFromCloud = false;
  let hadCase = hadHandoff;
  if (!hadHandoff) {
    hadCase = await applySelectedCaseIfAny();
  }
  if (!hadHandoff && !hadCase && getSessionAccount() && isCloudSaveAvailable()) {
    restoredFromCloud = await tryRestoreWorkspaceFromCloud({ quiet: false });
  }
  if (!hadHandoff && !hadCase && !restoredFromCloud) {
    if (els.ytUrl) els.ytUrl.value = DEFAULT_YOUTUBE_URL;
    setStatus(
      "準備完了。① URL を貼る → ② 動画+音声読込（AI分離に約2〜4分）。動画プレビューはバックグラウンドで読み込みます。",
      "ok"
    );
    const videoId = extractYouTubeVideoId(DEFAULT_YOUTUBE_URL);
    void (async () => {
      const ok = await mountYouTube(videoId, { quiet: true });
      if (ok) {
        syncWaveformScriptRegions();
        setStatus(
          "動画プレビューも準備できました。② 動画+音声読込 で波形を取得してください。",
          "ok"
        );
      } else {
        setStatus(
          "動画プレビューはスキップしました。② 動画+音声読込 だけで収録できます（Chrome でも可）。",
          "info"
        );
      }
    })();
  }

  // デモデータが localStorage に残っていたら削除
  clearDemoScriptState();

  // 台本がまだ空なら localStorage から復元を試みる
  if (scriptLines.length === 0) {
    const localScriptState = loadScriptStateFromLocal();
    if (localScriptState && localScriptState.scriptLines.length > 0) {
      scriptLines = normalizeScriptLineTimings(
        localScriptState.scriptLines.map((l) => ({ ...l })),
        0
      );
      focusedLineIndex = typeof localScriptState.focusedLineIndex === "number"
        ? localScriptState.focusedLineIndex : 0;
      if (els.scriptEditor) els.scriptEditor.value = scriptLinesToText(scriptLines);
      renderScriptList();
      renderSessionFlow();
      renderTakeDesk();
      updateCueDisplay();
      syncPunchInUi();
      updateProgressBar();
      setStatus("前回の台本状態を復元しました。", "ok");
    }
  }

  await tryRestoreWorkspaceSessionCache({ hadHandoff, skip: restoredFromCloud });

  // 抑制解除 — ここからユーザーの操作による保存が有効になる
  _suppressScriptSave = false;
}

async function tryRestoreWorkspaceSessionCache({ hadHandoff, skip } = {}) {
  if (hadHandoff || skip) return false;
  try {
    const loaded = await loadWorkspaceSessionCache();
    if (!loaded?.manifest) return false;
    const hasCachedTakes = Object.values(loaded.manifest.lines || {}).some(
      (p) => p?.takes?.length
    );
    const hasCachedTrash = (loaded.manifest.trash || []).length > 0;
    if (!hasCachedTakes && !hasCachedTrash) return false;
    const hasLocalTakes = scriptLines.some((l) => lineRecorder.hasRecording(l.id));
    if (hasLocalTakes) return false;

    await applyWorkspaceSnapshot(loaded.manifest, loaded.takeBlobs);
    setStatus("前回の作業状態（録音テイク含む）を復元しました。", "ok");
    return true;
  } catch (e) {
    console.warn("[wavrick] session cache restore failed:", e);
    return false;
  }
}

// ─── ブラウザ「戻る」対策: UI状態を sessionStorage + IndexedDB に自動保存＆復元 ───
const _RW_UI_STATE_KEY = "wavrick_rw_ui_state";
let _rwSavePending = false;

function _rwSaveUiStateSync() {
  try {
    const seekVal = els.multitrackSeek ? Number(els.multitrackSeek.value) : null;
    const state = {
      focusedLineIndex,
      activeLineId,
      workspaceRequestId,
      caseSelectValue: els.caseSelect?.value || "",
      ytUrl: els.ytUrl?.value || "",
      scriptEditorValue: els.scriptEditor?.value || "",
      audioOffsetSec,
      preRollSec: Number(els.preRoll?.value) || 3,
      autoRecordAtCue,
      countdownBeepsOn,
      holdToRecordOn,
      multitrackSeek: Number.isFinite(seekVal) ? seekVal : null,
      teleprompterScrollTop: els.teleprompterScroll?.scrollTop ?? 0,
      scriptSelectMode,
      savedAt: Date.now()
    };
    sessionStorage.setItem(_RW_UI_STATE_KEY, JSON.stringify(state));
    forceScriptStateSave();
  } catch (e) { /* quota — ignore */ }
}

async function _rwSaveUiStateAsync() {
  _rwSaveUiStateSync();
  try {
    if (!scriptLines.length && !lineRecorder) return;
    const takeBlobs = collectTakeBlobsForSave();
    if (!takeBlobs.size && !scriptLines.length) return;
    const manifest = buildWorkspaceSnapshot();
    await saveWorkspaceSessionCache(manifest, takeBlobs);
  } catch (e) {
    console.warn("[wavrick] session cache save failed:", e);
  }
}

function _rwSaveUiState() {
  _rwSaveUiStateSync();
  if (_rwSavePending) return;
  _rwSavePending = true;
  void _rwSaveUiStateAsync().finally(() => {
    _rwSavePending = false;
  });
}

function _rwRestoreUiState() {
  try {
    const raw = sessionStorage.getItem(_RW_UI_STATE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (saved.ytUrl && els.ytUrl) els.ytUrl.value = saved.ytUrl;
    if (saved.scriptEditorValue && els.scriptEditor && !els.scriptEditor.value.trim()) {
      els.scriptEditor.value = saved.scriptEditorValue;
    }
    if (typeof saved.audioOffsetSec === "number") {
      audioOffsetSec = saved.audioOffsetSec;
      if (els.audioOffset) els.audioOffset.value = String(audioOffsetSec);
    }
    if (typeof saved.preRollSec === "number" && els.preRoll) {
      preRollSec = saved.preRollSec;
      els.preRoll.value = String(preRollSec);
    }
    if (typeof saved.autoRecordAtCue === "boolean") {
      autoRecordAtCue = saved.autoRecordAtCue;
      if (els.autoRecordAtCue) els.autoRecordAtCue.checked = autoRecordAtCue;
    }
    if (typeof saved.countdownBeepsOn === "boolean" && els.countdownBeeps) {
      countdownBeepsOn = saved.countdownBeepsOn;
      els.countdownBeeps.checked = countdownBeepsOn;
    }
    if (typeof saved.holdToRecordOn === "boolean" && els.holdToRecord) {
      holdToRecordOn = saved.holdToRecordOn;
      els.holdToRecord.checked = holdToRecordOn;
    }
    if (typeof saved.focusedLineIndex === "number" && scriptLines.length > 0) {
      focusedLineIndex = Math.min(saved.focusedLineIndex, scriptLines.length - 1);
    }
    if (saved.activeLineId && scriptLines.some((l) => l.id === saved.activeLineId)) {
      activeLineId = saved.activeLineId;
    } else if (scriptLines[focusedLineIndex]) {
      activeLineId = scriptLines[focusedLineIndex].id;
    }
    if (saved.caseSelectValue && els.caseSelect) {
      els.caseSelect.value = saved.caseSelectValue;
    }
    if (typeof saved.scriptSelectMode === "boolean") {
      scriptSelectMode = saved.scriptSelectMode;
    }
    renderScriptList();
    updateCueDisplay();
    syncPunchInUi();
    updateProgressBar();
    if (
      typeof saved.multitrackSeek === "number" &&
      els.multitrackSeek &&
      waveform?.ready
    ) {
      els.multitrackSeek.value = String(saved.multitrackSeek);
      onMultitrackSeekInput();
    }
    if (typeof saved.teleprompterScrollTop === "number" && els.teleprompterScroll) {
      els.teleprompterScroll.scrollTop = saved.teleprompterScrollTop;
    }
  } catch (e) { /* ignore */ }
}

window.addEventListener("pagehide", _rwSaveUiState);
window.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") _rwSaveUiState();
});
window.addEventListener("beforeunload", _rwSaveUiState);
window.addEventListener("pageshow", (e) => {
  if (e.persisted) _rwRestoreUiState();
});

init().then(() => {
  _rwRestoreUiState();
  window.scrollTo(0, 0);
  requestAnimationFrame(() => {
    window.scrollTo(0, 0);
    document.documentElement.classList.remove("no-scroll");
  });
});
