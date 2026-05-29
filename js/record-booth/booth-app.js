/**
 * WAVRICK — 全画面収録ブース (booth-app.js)
 * 編集画面(record-workspace)から localStorage 経由で台本・テイクを同期
 * Apple Music 風カラオケタイムライン + 波形 + テイク管理
 */

// ─── 台本ブロック分割ロジック ───
// 編集画面の blockBreak マーカーを優先。なければ10秒ギャップで自動分割。
var BLOCK_GAP_SEC = 10;
var LINE_GAP_SPLIT_MIN_SEC = 3;

function boothEstimateSpeechDur(text) {
  var t = String(text || "").trim();
  if (!t) return 2;
  var chars = t.replace(/\s/g, "").length;
  var base = chars / 8.5;
  var pauseBonus = (t.match(/[。！？!?、,\n]/g) || []).length * 0.35;
  return Math.max(2, Math.min(120, base + pauseBonus));
}

function boothInferLineEnd(line, nextLine, timelineEndSec) {
  var start = Math.max(0, Number(line.startSec) || 0);
  var minFromText = start + boothEstimateSpeechDur(line.text);
  if (line.endSec != null && line.endSec > start) {
    var end = Math.max(line.endSec, minFromText);
    if (nextLine && nextLine.startSec > start && end > nextLine.startSec) {
      return Math.max(start + 0.1, nextLine.startSec - 0.05);
    }
    return end;
  }
  if (nextLine && nextLine.startSec > start) {
    return Math.max(start + 0.15, Math.min(nextLine.startSec - 0.05, minFromText));
  }
  if (timelineEndSec > start) return Math.max(minFromText, timelineEndSec);
  return minFromText;
}

function boothLineEndInAll(lineIdx) {
  var line = state.allLines[lineIdx];
  if (!line) return 0;
  var next = state.allLines[lineIdx + 1] || null;
  var timelineEnd =
    lineIdx === state.allLines.length - 1 && state.duration > line.startSec
      ? state.duration
      : 0;
  return boothInferLineEnd(line, next, timelineEnd);
}

function splitIntoBlocks(scriptLines) {
  if (!scriptLines || scriptLines.length === 0) return [];

  var hasExplicitBreaks = scriptLines.some(function(l) { return l.blockBreak; });

  var blocks = [];
  var current = [scriptLines[0]];

  for (var i = 1; i < scriptLines.length; i++) {
    var prev = scriptLines[i - 1];
    var line = scriptLines[i];
    var shouldBreak = false;

    if (hasExplicitBreaks) {
      shouldBreak = !!line.blockBreak;
    } else {
      var prevEnd = boothInferLineEnd(prev, line, 0);
      var gap = line.startSec - prevEnd;
      shouldBreak = gap >= BLOCK_GAP_SEC;
    }

    if (shouldBreak) {
      blocks.push(current);
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) blocks.push(current);
  return blocks;
}

// ─── 空台本（台本データが無い場合） ───
const EMPTY_LINES = [
  {
    id: "empty-1",
    startSec: 0,
    endSec: null,
    text: "（台本がまだ読み込まれていません。編集画面で案件を開いてください）",
    rawTc: ""
  }
];

// ─── 状態管理 ───
const state = {
  allLines: [],
  blocks: [],
  currentBlockIdx: 0,
  currentLineIdx: -1,
  isPlaying: false,
  isRecording: false,
  playbackTime: 0,
  duration: 0,
  takes: [],
  takeIdCounter: 0,
  syncedTakes: {},
  userScrolling: false,
  scrollTimeout: null,
  animFrameId: null,
  playStartWall: 0,
  playStartOffset: 0,
  settings: { preRollSec: 3, countdownBeepsOn: true, holdToRecordOn: false, audioOffsetSec: 0 },
  youtubeUrl: "",
  rawAudioUrl: "",
  cleanedAudioUrl: "",
  ytPlayer: null
};

// ─── DOM ───
const els = {};

function cacheDom() {
  els.backBtn = document.getElementById("boothBackBtn");
  els.recIndicator = document.getElementById("boothRecIndicator");
  els.enToggle = document.getElementById("boothEnToggle");
  els.waveTitle = document.getElementById("boothWaveTitle");
  els.waveRuler = document.getElementById("boothWaveRuler");
  els.takesTitle = document.getElementById("boothTakesTitle");
  els.refWave = document.getElementById("boothRefWave");
  els.recWave = document.getElementById("boothRecWave");
  els.refTcOverlay = document.getElementById("boothRefTcOverlay");
  els.refTcRow = document.getElementById("boothRefTcRow");
  els.takeList = document.getElementById("boothTakeList");
  els.takeEmpty = document.getElementById("boothTakeEmpty");
  els.masterToggle = document.getElementById("boothMasterToggle");
  els.masterSeek = document.getElementById("boothMasterSeek");
  els.masterCurrent = document.getElementById("boothMasterCurrent");
  els.masterDuration = document.getElementById("boothMasterDuration");
  els.masterTicks = document.getElementById("boothMasterTicks");
  els.recBtn = document.getElementById("boothRecBtn");
  els.stopBtn = document.getElementById("boothStopBtn");
  els.playBtn = document.getElementById("boothPlayBtn");
  els.retakeBtn = document.getElementById("boothRetakeBtn");
  els.scriptSelector = document.getElementById("boothScriptSelector");
  els.scriptDropdownBtn = document.getElementById("boothScriptDropdownBtn");
  els.scriptLabel = document.getElementById("boothScriptLabel");
  els.scriptStatus = document.getElementById("boothScriptStatus");
  els.scriptMenu = document.getElementById("boothScriptMenu");
  els.lyricsScroll = document.getElementById("boothLyricsScroll");
  els.snapBackBtn = document.getElementById("boothSnapBackBtn");
  els.preRoll = document.getElementById("boothPreRoll");
  els.audioOffset = document.getElementById("boothAudioOffset");
  els.audioOffsetVal = document.getElementById("boothAudioOffsetVal");
  els.bugCopyBtn = document.getElementById("boothBugCopyBtn");
  els.bugSendBtn = document.getElementById("boothBugSendBtn");
  els.bugText = document.getElementById("boothBugText");
  els.bugEmail = document.getElementById("boothBugEmail");
  els.videoPanel = document.getElementById("boothVideoPanel");
  els.ytPlayer = document.getElementById("boothYtPlayer");
  els.filePlayer = document.getElementById("boothFilePlayer");
}

// ─── ユーティリティ ───
function fmtTc(sec) {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const ss = s - m * 60;
  const whole = Math.floor(ss);
  const cs = Math.round((ss - whole) * 100);
  return `${String(m).padStart(2, "0")}:${String(whole).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function fmtTcShort(sec) {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const ss = Math.floor(s - m * 60);
  return `${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

function currentBlock() {
  return state.blocks[state.currentBlockIdx] || [];
}

// ─── 台本フォールバック（handoff / editor保存テキストから復旧） ───
var HANDOFF_KEY = "wavrick_rw_handoff";
var EDITOR_KEY = "wavrick_rw_editor_text";
var LINE_RE = /^\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?(?:\s*-\s*(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?)?\]\s*(.+)$/;
var TC_ONLY_RE = /^\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?(?:\s*-\s*(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?)?\]\s*$/;

function parseBoothTcParts(min, sec, frac) {
  var f = frac == null || frac === "" ? 0 : Number(frac);
  var digits = String(frac || "").length;
  var fracSec = !Number.isFinite(f) ? 0 : digits <= 2 ? f / 100 : digits === 3 ? f / 1000 : f / Math.pow(10, digits);
  return Number(min) * 60 + Number(sec) + fracSec;
}

function scoreBoothScriptText(text) {
  var t = String(text || "").trim();
  if (!t) return 0;
  var rows = t.split(/\r?\n/).map(function(l) { return l.trim(); }).filter(Boolean);
  var tcOnly = rows.filter(function(l) { return TC_ONLY_RE.test(l); }).length;
  var parsed = parseScriptText(t);
  var distinctStarts = {};
  for (var i = 0; i < parsed.length; i++) {
    distinctStarts[Math.round(parsed[i].startSec * 100)] = true;
  }
  return (
    tcOnly * 12 + parsed.length * 3 + Object.keys(distinctStarts).length * 8
  );
}

function tryRecoverScriptFromStorage() {
  var candidates = [];

  function addCandidate(text, source) {
    var t = String(text || "").trim();
    if (!t) return;
    var parsed = parseScriptText(t);
    if (!parsed.length) return;
    candidates.push({ parsed: parsed, score: scoreBoothScriptText(t), source: source });
  }

  // 1) sessionStorage の handoff（ワークスペース経由の受け渡し）
  var handoffRaw = null;
  try { handoffRaw = sessionStorage.getItem(HANDOFF_KEY); } catch(e) {}
  if (handoffRaw) {
    try {
      var handoff = JSON.parse(handoffRaw);
      if (handoff.videoUrl) state.youtubeUrl = handoff.videoUrl;
      if (handoff.rawAudioUrl) state.rawAudioUrl = handoff.rawAudioUrl;
      if (handoff.cleanedAudioUrl) state.cleanedAudioUrl = handoff.cleanedAudioUrl;
      var scriptText = handoff.script || "";
      if (!scriptText && handoff.scriptRef) {
        try { scriptText = localStorage.getItem("wavrick_rw_script_" + handoff.scriptRef) || ""; } catch(e) {}
      }
      addCandidate(scriptText, "handoff");
    } catch(e) { console.warn("[booth] handoff parse error", e); }
  }

  // 2) WavrickWorkCases（選択中の案件データから台本・動画URL取得）
  var cases = window.WavrickWorkCases;
  if (cases) {
    var caseId = cases.getSelectedCaseId();
    if (caseId) {
      var request = cases.findCaseById(caseId);
      if (request) {
        if (request.videoUrl && !state.youtubeUrl) state.youtubeUrl = request.videoUrl;
        addCandidate(request.script || "", "case");
      }
    }
  }

  if (candidates.length) {
    candidates.sort(function(a, b) { return b.score - a.score; });
    console.log("[booth] script candidate:", candidates[0].source, "lines=" + candidates[0].parsed.length);
    return candidates[0].parsed;
  }

  // 3) wavrick_rw_script_state（ワークスペースが保存した台本データ）
  try {
    var scriptStateRaw = localStorage.getItem("wavrick_rw_script_state");
    if (scriptStateRaw) {
      var scriptState = JSON.parse(scriptStateRaw);
      if (Array.isArray(scriptState.scriptLines) && scriptState.scriptLines.length > 0) {
        var first = scriptState.scriptLines[0];
        var isDemo = (first.text || "").trim().toLowerCase() === "hello";
        if (!isDemo) {
          if (!state.youtubeUrl) {
            try { state.youtubeUrl = localStorage.getItem("wavrick_rw_yturl") || ""; } catch(e) {}
          }
          return scriptState.scriptLines.map(function(l, idx, arr) {
            var next = arr[idx + 1] || null;
            return {
              id: l.id,
              startSec: l.startSec,
              endSec: boothInferLineEnd(l, next, 0),
              text: l.text || "",
              rawTc: l.rawTc || "",
              blockBreak: !!l.blockBreak
            };
          });
        }
      }
    }
  } catch(e) { /* ignore */ }

  // 4) localStorage のエディタテキスト（最終手段）
  var editorText = null;
  try { editorText = localStorage.getItem(EDITOR_KEY); } catch(e) {}
  if (editorText && editorText.trim()) {
    if (!/^\[00:02\.00\]\s*Hello/i.test(editorText.trim())) {
      var parsed = parseScriptText(editorText);
      if (parsed.length > 0) {
        var ytUrl = "";
        try { ytUrl = localStorage.getItem("wavrick_rw_yturl") || ""; } catch(e) {}
        if (ytUrl && !state.youtubeUrl) state.youtubeUrl = ytUrl;
        return parsed;
      }
    }
  }

  return null;
}

function parseScriptText(text) {
  var lines = [];
  var rows = text.split(/\r?\n/);
  var fallbackLines = [];
  var inCast = false;
  var pendingTc = null;

  for (var i = 0; i < rows.length; i++) {
    var raw = rows[i].trim();
    if (!raw) continue;
    if (/^---\s*WAVRICK_CAST\s*---$/i.test(raw)) { inCast = true; continue; }
    if (inCast) { if (raw === "---") inCast = false; continue; }
    if (/^【[^】]+】\s*$/.test(raw)) continue;

    var tcOnly = raw.match(TC_ONLY_RE);
    if (tcOnly) {
      var ps = parseBoothTcParts(tcOnly[1], tcOnly[2], tcOnly[3]);
      var pe = tcOnly[4] != null ? parseBoothTcParts(tcOnly[4], tcOnly[5], tcOnly[6]) : null;
      if (pe != null && pe <= ps) pe = null;
      pendingTc = { startSec: ps, endSec: pe, rawTc: raw };
      continue;
    }

    var m = raw.match(LINE_RE);
    if (m && m[7].trim()) {
      pendingTc = null;
      var startSec = parseBoothTcParts(m[1], m[2], m[3]);
      var endSec = m[4] != null ? parseBoothTcParts(m[4], m[5], m[6]) : null;
      if (endSec != null && endSec <= startSec) endSec = null;
      lines.push({
        id: "rec-" + lines.length,
        startSec: startSec,
        endSec: endSec,
        text: m[7].trim(),
        rawTc: raw.match(/^\[[^\]]+\]/)[0],
        blockBreak: false
      });
      continue;
    }

    if (pendingTc) {
      lines.push({
        id: "rec-" + lines.length,
        startSec: pendingTc.startSec,
        endSec: pendingTc.endSec,
        text: raw,
        rawTc: pendingTc.rawTc,
        blockBreak: false
      });
      pendingTc = null;
      continue;
    }

    if (!raw.startsWith("#") && !raw.startsWith("---")) {
      fallbackLines.push(raw);
    }
  }

  if (lines.length > 0) return lines;

  if (fallbackLines.length > 0) {
    var step = 4;
    for (var j = 0; j < fallbackLines.length; j++) {
      lines.push({
        id: "rec-" + j,
        startSec: j * step,
        endSec: (j + 1) * step,
        text: fallbackLines[j],
        rawTc: "",
        blockBreak: false
      });
    }
  }
  return lines;
}

// ─── データ読み込み（localStorage 同期） ───
function loadSyncedData() {
  var payload = null;
  try {
    var raw = localStorage.getItem("wavrick_booth_sync");
    if (raw) payload = JSON.parse(raw);
  } catch (e) {
    console.warn("booth: sync data parse failed", e);
  }

  console.log("[booth] sync payload:", payload ? ("lines=" + (payload.scriptLines||[]).length) : "none");

  var hasSyncedScript = payload && Array.isArray(payload.scriptLines) && payload.scriptLines.length > 0;
  var isDemoData = hasSyncedScript && payload.scriptLines[0] && String(payload.scriptLines[0].id).startsWith("demo-");

  if (hasSyncedScript && !isDemoData) {
    var syncDur = Number(payload.durationSec) || 0;
    state.allLines = payload.scriptLines.map(function(l, idx, arr) {
      var next = arr[idx + 1] || null;
      var timelineEnd =
        idx === arr.length - 1 && syncDur > l.startSec ? syncDur : 0;
      var end = boothInferLineEnd(
        { startSec: l.startSec, endSec: l.endSec },
        next,
        timelineEnd
      );
      return {
        id: l.id,
        startSec: l.startSec,
        endSec: end,
        text: l.text || "",
        rawTc: l.rawTc || "",
        blockBreak: !!l.blockBreak
      };
    });
    state.syncedTakes = payload.takes || {};
    if (payload.settings) {
      for (var key in payload.settings) {
        if (payload.settings.hasOwnProperty(key)) {
          state.settings[key] = payload.settings[key];
        }
      }
    }
    state.youtubeUrl = payload.youtubeUrl || "";
    state.rawAudioUrl = payload.rawAudioUrl || "";
    state.cleanedAudioUrl = payload.cleanedAudioUrl || "";
  } else {
    if (payload) {
      state.youtubeUrl = payload.youtubeUrl || "";
      state.rawAudioUrl = payload.rawAudioUrl || "";
      state.cleanedAudioUrl = payload.cleanedAudioUrl || "";
    }
    var recovered = tryRecoverScriptFromStorage();
    if (recovered && recovered.length > 0) {
      state.allLines = recovered;
      console.log("[booth] recovered script from case/storage:", recovered.length, "lines");
    } else {
      state.allLines = EMPTY_LINES.map(function(l) { return { id:l.id, startSec:l.startSec, endSec:l.endSec, text:l.text, rawTc:l.rawTc, blockBreak:false }; });
      console.log("[booth] no script available — showing empty state");
    }
  }

  state.blocks = splitIntoBlocks(state.allLines);
  state.currentBlockIdx = 0;

  if (payload && typeof payload.focusedLineIndex === "number") {
    const focusedLine = state.allLines[payload.focusedLineIndex];
    if (focusedLine) {
      const blockIdx = state.blocks.findIndex(block =>
        block.some(l => l.id === focusedLine.id)
      );
      if (blockIdx >= 0) state.currentBlockIdx = blockIdx;
    }
  }

  var syncDuration = payload && Number(payload.durationSec) > 0 ? Number(payload.durationSec) : 0;
  const lastLine = state.allLines[state.allLines.length - 1];
  if (syncDuration > 0) {
    state.duration = syncDuration;
    if (lastLine && (lastLine.endSec == null || lastLine.endSec < syncDuration * 0.5)) {
      lastLine.endSec = syncDuration;
      lastLine.rawTc = fmtTc(lastLine.startSec) + " - " + fmtTc(syncDuration);
    }
  } else {
    state.duration = lastLine ? boothLineEndInAll(state.allLines.length - 1) : 60;
  }

  loadTakesForCurrentBlock();
}

function loadTakesForCurrentBlock() {
  state.takes = [];
  state.takeIdCounter = 0;
  const block = currentBlock();

  for (const line of block) {
    const syncedLine = state.syncedTakes[line.id];
    if (syncedLine && syncedLine.items) {
      for (const t of syncedLine.items) {
        state.takeIdCounter++;
        state.takes.push({
          id: `take-${state.takeIdCounter}`,
          name: t.name || `Take ${state.takeIdCounter}`,
          startSec: t.startSec ?? line.startSec,
          endSec: t.endSec ?? line.endSec,
          lineId: line.id,
          selected: false
        });
      }
    }
  }
}

// ─── 台本プルダウン ───
function renderScriptSelector() {
  const block = currentBlock();
  const blockNum = state.currentBlockIdx + 1;
  const firstLine = block[0];
  const lastLine = block[block.length - 1];
  const lastEnd =
    lastLine && block.length
      ? boothInferLineEnd(lastLine, null, state.duration)
      : 0;
  const timeRange = firstLine && lastLine
    ? `${fmtTcShort(firstLine.startSec)}~${fmtTcShort(lastEnd || lastLine.startSec)}`
    : "—";

  els.scriptLabel.textContent = `台本 ${blockNum} (${timeRange})`;
  els.scriptStatus.textContent = "●";
  els.scriptStatus.className = "booth-script-dot";

  els.waveTitle.textContent = `マルチトラック波形表示（台本 ${blockNum} / Section ${blockNum}）`;
  els.takesTitle.textContent = `収録テイク管理 (Script Section ${blockNum})`;

  els.scriptMenu.innerHTML = "";
  state.blocks.forEach((blk, i) => {
    const li = document.createElement("li");
    li.className = "booth-script-menu-item" + (i === state.currentBlockIdx ? " is-active" : "");
    li.setAttribute("role", "option");

    const f = blk[0];
    const l = blk[blk.length - 1];
    const blkEnd = boothInferLineEnd(l, null, state.duration);
    const range = `${fmtTcShort(f.startSec)}~${fmtTcShort(blkEnd || l.startSec)}`;

    const hasTakes = blk.some(line => {
      const synced = state.syncedTakes[line.id];
      return synced && synced.items && synced.items.length > 0;
    });
    const statusIcon = hasTakes ? "✅" : (i === state.currentBlockIdx ? "●" : "✖");

    li.innerHTML = `
      <span>台本 ${i + 1} (${range})</span>
      <span class="booth-script-menu-item-status">${statusIcon}</span>
    `;
    li.addEventListener("click", () => selectBlock(i));
    els.scriptMenu.appendChild(li);
  });

  renderWaveRuler();
}

function renderWaveRuler() {
  const block = currentBlock();
  if (!block.length) return;
  const start = block[0].startSec;
  const lastBlk = block[block.length - 1];
  const end = boothInferLineEnd(lastBlk, null, state.duration);
  const dur = end - start;
  const ticks = 6;
  els.waveRuler.innerHTML = "";
  for (let i = 0; i <= ticks; i++) {
    const t = start + (dur * i / ticks);
    const span = document.createElement("span");
    span.textContent = fmtTcShort(t);
    els.waveRuler.appendChild(span);
  }
}

function toggleScriptMenu() {
  const isOpen = !els.scriptMenu.hidden;
  els.scriptMenu.hidden = isOpen;
  els.scriptSelector.classList.toggle("is-open", !isOpen);
}

function selectBlock(idx) {
  state.currentBlockIdx = idx;
  state.currentLineIdx = -1;
  els.scriptMenu.hidden = true;
  els.scriptSelector.classList.remove("is-open");
  loadTakesForCurrentBlock();
  renderScriptSelector();
  renderLyrics();
  renderTakes();
  stopPlayback();
}

// ─── セリフタイムライン ───
function renderLyrics() {
  var block = currentBlock();
  els.lyricsScroll.innerHTML = "";

  block.forEach(function(line, idx) {
    var row = document.createElement("div");
    row.className = "booth-lyric-row";
    row.dataset.lineIdx = idx;
    row.dataset.startSec = line.startSec;
    row.dataset.endSec = line.endSec;

    var tcEl = document.createElement("span");
    tcEl.className = "booth-lyric-tc";
    tcEl.textContent = fmtTc(line.startSec) + " - " + fmtTc(line.endSec || line.startSec);

    var textEl = document.createElement("span");
    textEl.className = "booth-lyric-text";
    textEl.innerHTML = wrapCharsForKaraoke(line.text);

    row.appendChild(tcEl);
    row.appendChild(textEl);
    row.addEventListener("click", function() { seekToLine(idx); });
    els.lyricsScroll.appendChild(row);
  });
}

function wrapCharsForKaraoke(text) {
  return [...text].map((ch, i) =>
    `<span class="booth-char" data-idx="${i}">${ch}</span>`
  ).join("");
}

// ─── カラオケハイライト同期 ───
function updateLyricsHighlight(currentTime) {
  const block = currentBlock();
  const rows = els.lyricsScroll.querySelectorAll(".booth-lyric-row");
  let activeIdx = -1;

  block.forEach((line, idx) => {
    const end = boothInferLineEnd(line, block[idx + 1] || null, 0);
    if (currentTime >= line.startSec && currentTime < end) {
      activeIdx = idx;
    }
  });

  rows.forEach((row, idx) => {
    const isActive = idx === activeIdx;
    row.classList.toggle("is-active", isActive);

    if (isActive) {
      const line = block[idx];
      const end = boothInferLineEnd(line, block[idx + 1] || null, 0);
      const lineDuration = end - line.startSec;
      const elapsed = currentTime - line.startSec;
      const progress = Math.min(1, Math.max(0, elapsed / lineDuration));
      const chars = row.querySelectorAll(".booth-char");
      const litCount = Math.floor(progress * chars.length);
      chars.forEach((ch, ci) => ch.classList.toggle("is-lit", ci < litCount));
    } else {
      row.querySelectorAll(".booth-char").forEach(ch => ch.classList.remove("is-lit"));
    }
  });

  if (activeIdx !== state.currentLineIdx) {
    state.currentLineIdx = activeIdx;
    if (activeIdx >= 0 && !state.userScrolling) {
      scrollToActiveLine(activeIdx);
    }
  }

  updateRefTcOverlay(currentTime);
}

function updateRefTcOverlay(currentTime) {
  const block = currentBlock();
  let activeLine = null;
  for (let bi = 0; bi < block.length; bi++) {
    const line = block[bi];
    const end = boothInferLineEnd(line, block[bi + 1] || null, 0);
    if (currentTime >= line.startSec && currentTime < end) {
      activeLine = line;
      break;
    }
  }
  if (activeLine) {
    const tcText = `${fmtTc(activeLine.startSec)} - ${fmtTc(activeLine.endSec || activeLine.startSec)}`;
    els.refTcOverlay.textContent = tcText;
    els.refTcRow.textContent = tcText;
  }
}

function scrollToActiveLine(idx) {
  const rows = els.lyricsScroll.querySelectorAll(".booth-lyric-row");
  if (!rows[idx]) return;
  const row = rows[idx];
  const container = els.lyricsScroll;
  const rowRect = row.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  const offset = rowRect.top - containerRect.top - containerRect.height / 3;
  container.scrollTop += offset;
}

// ─── 再生 ───
function startPlayback() {
  if (state.isPlaying) return;
  state.isPlaying = true;
  state.playStartWall = performance.now();
  state.playStartOffset = state.playbackTime;
  state.userScrolling = false;
  els.snapBackBtn.hidden = true;
  boothMediaSeek(state.playbackTime, { play: true });
  playbackLoop();
}

function stopPlayback() {
  state.isPlaying = false;
  boothMediaSeek(state.playbackTime, { pause: true });
  if (state.animFrameId) {
    cancelAnimationFrame(state.animFrameId);
    state.animFrameId = null;
  }
}

function playbackLoop() {
  if (!state.isPlaying) return;
  const elapsed = (performance.now() - state.playStartWall) / 1000;
  state.playbackTime = state.playStartOffset + elapsed;
  if (state.playbackTime >= state.duration) {
    state.playbackTime = state.duration;
    stopPlayback();
  }
  updateTimeDisplay();
  updateLyricsHighlight(state.playbackTime);
  updateSeekbar();
  if (state.isPlaying) {
    state.animFrameId = requestAnimationFrame(playbackLoop);
  }
}

function updateTimeDisplay() {
  els.masterCurrent.textContent = fmtTcShort(state.playbackTime);
  els.masterDuration.textContent = fmtTcShort(state.duration);
}

function updateSeekbar() {
  const progress = (state.playbackTime / state.duration) * 10000;
  els.masterSeek.value = Math.round(progress);
}

function seekToLine(idx) {
  const block = currentBlock();
  const line = block[idx];
  if (!line) return;
  seekToTime(line.startSec);
  if (!state.isPlaying) startPlayback();
}

function boothMediaSeek(sec, opts) {
  var t = Math.max(0, Number(sec) || 0);
  var offset = Number(state.settings.audioOffsetSec) || 0;
  var mediaT = Math.max(0, t + offset);
  if (state.ytPlayer && typeof state.ytPlayer.seekTo === "function") {
    try {
      state.ytPlayer.seekTo(mediaT, true);
      if (opts && opts.play) state.ytPlayer.playVideo();
      else if (opts && opts.pause) state.ytPlayer.pauseVideo();
    } catch (e) { /* ignore */ }
  }
  if (els.filePlayer && !els.filePlayer.hidden) {
    try {
      els.filePlayer.currentTime = mediaT;
      if (opts && opts.play) void els.filePlayer.play();
      else if (opts && opts.pause) els.filePlayer.pause();
    } catch (e) { /* ignore */ }
  }
}

function seekToTime(sec) {
  state.playbackTime = sec;
  state.playStartWall = performance.now();
  state.playStartOffset = sec;
  boothMediaSeek(sec, { play: state.isPlaying });
  updateTimeDisplay();
  updateLyricsHighlight(sec);
  updateSeekbar();
}

// ─── テイク管理 ───
function addTake(startSec, endSec) {
  state.takeIdCounter++;
  const take = {
    id: `take-${state.takeIdCounter}`,
    name: `Take ${state.takeIdCounter}`,
    startSec,
    endSec,
    selected: false
  };
  state.takes.push(take);
  renderTakes();
  saveTakesToSync();
  return take;
}

function deleteTake(id) {
  state.takes = state.takes.filter(t => t.id !== id);
  renderTakes();
  saveTakesToSync();
}

function toggleTakeSelect(id) {
  const take = state.takes.find(t => t.id === id);
  if (take) {
    take.selected = !take.selected;
    renderTakes();
    saveTakesToSync();
  }
}

function renderTakes() {
  els.takeEmpty.hidden = state.takes.length > 0;
  els.takeList.innerHTML = "";

  state.takes.forEach(take => {
    const div = document.createElement("div");
    div.className = "booth-take-item";
    div.innerHTML = `
      <span class="booth-take-name">${take.name}</span>
      <span class="booth-take-tc">(${fmtTcShort(take.startSec)}-${fmtTcShort(take.endSec)})</span>
      <span class="booth-take-lang">(JA)</span>
      <span class="booth-take-spacer"></span>
      <span class="booth-take-actions">
        <button type="button" class="booth-take-action-btn booth-take-play" title="Play">Play</button>
        <button type="button" class="booth-take-action-btn booth-take-del" title="Delete">Delete</button>
        <button type="button" class="booth-take-action-btn booth-take-select ${take.selected ? "is-selected" : ""}" title="Select for Final">Select for Final</button>
      </span>
    `;
    div.querySelector(".booth-take-play").addEventListener("click", () => {
      seekToTime(take.startSec);
      if (!state.isPlaying) startPlayback();
    });
    div.querySelector(".booth-take-del").addEventListener("click", () => deleteTake(take.id));
    div.querySelector(".booth-take-select").addEventListener("click", () => toggleTakeSelect(take.id));
    els.takeList.appendChild(div);
  });
}

function boothGlobalFocusedLineIndex() {
  if (state.currentLineIdx < 0) return 0;
  const block = currentBlock();
  const line = block[state.currentLineIdx];
  if (!line) return 0;
  const idx = state.allLines.findIndex(function(l) { return l.id === line.id; });
  return idx >= 0 ? idx : 0;
}

function boothPersistFullSync() {
  try {
    var payload = {
      scriptLines: state.allLines.map(function(l) {
        return {
          id: l.id,
          startSec: l.startSec,
          endSec: l.endSec,
          text: l.text || "",
          rawTc: l.rawTc || "",
          blockBreak: !!l.blockBreak
        };
      }),
      focusedLineIndex: boothGlobalFocusedLineIndex(),
      takes: {},
      settings: Object.assign({}, state.settings),
      youtubeUrl: state.youtubeUrl || "",
      rawAudioUrl: state.rawAudioUrl || "",
      cleanedAudioUrl: state.cleanedAudioUrl || "",
      durationSec: state.duration || 0,
      timestamp: Date.now()
    };
    payload.takes = Object.assign({}, state.syncedTakes || {});
    var raw = localStorage.getItem("wavrick_booth_sync");
    if (raw) {
      try {
        var prev = JSON.parse(raw);
        if (prev.takes) payload.takes = Object.assign({}, prev.takes, payload.takes);
      } catch (e) { /* ignore */ }
    }
    saveTakesToSyncIntoPayload(payload);
    state.syncedTakes = payload.takes;
    localStorage.setItem("wavrick_booth_sync", JSON.stringify(payload));
  } catch (e) {
    console.warn("booth: full sync save failed", e);
  }
}

function saveTakesToSyncIntoPayload(payload) {
  if (!payload.takes) payload.takes = {};
  const block = currentBlock();
  for (let li = 0; li < block.length; li++) {
    const line = block[li];
    const lineTakes = state.takes.filter(t => {
      const end = boothInferLineEnd(line, block[li + 1] || null, 0);
      return t.startSec >= line.startSec - 1 && t.startSec <= end + 1;
    });
    if (lineTakes.length > 0) {
      payload.takes[line.id] = {
        count: lineTakes.length,
        activeIndex: lineTakes.findIndex(t => t.selected),
        items: lineTakes.map(t => ({
          name: t.name,
          startSec: t.startSec,
          endSec: t.endSec,
          durationSec: t.endSec - t.startSec
        }))
      };
    }
  }
  payload.timestamp = Date.now();
}

function saveTakesToSync() {
  try {
    const raw = localStorage.getItem("wavrick_booth_sync");
    var payload;
    if (!raw) {
      boothPersistFullSync();
      return;
    }
    payload = JSON.parse(raw);
    saveTakesToSyncIntoPayload(payload);
    if (!payload.scriptLines || !payload.scriptLines.length) {
      payload.scriptLines = state.allLines.map(function(l) {
        return {
          id: l.id,
          startSec: l.startSec,
          endSec: l.endSec,
          text: l.text || "",
          rawTc: l.rawTc || "",
          blockBreak: !!l.blockBreak
        };
      });
      payload.focusedLineIndex = boothGlobalFocusedLineIndex();
      payload.settings = Object.assign({}, state.settings);
      payload.youtubeUrl = state.youtubeUrl || payload.youtubeUrl || "";
    }
    state.syncedTakes = payload.takes;
    localStorage.setItem("wavrick_booth_sync", JSON.stringify(payload));
  } catch (e) {
    console.warn("booth: save takes sync failed", e);
  }
}

// ─── 録音 ───
let recStartTime = 0;

function startRecording() {
  if (state.isRecording) return;
  state.isRecording = true;
  recStartTime = state.playbackTime;
  els.recBtn.classList.add("is-recording");
  els.recBtn.querySelector(".booth-rec-label").textContent = "● REC...";
  els.recIndicator.hidden = false;
  els.stopBtn.disabled = false;
  if (!state.isPlaying) startPlayback();
}

function stopRecording() {
  if (!state.isRecording) return;
  state.isRecording = false;
  const endTime = state.playbackTime;
  els.recBtn.classList.remove("is-recording");
  els.recBtn.querySelector(".booth-rec-label").textContent = "REC TAKE";
  els.recIndicator.hidden = true;
  els.stopBtn.disabled = true;
  if (endTime > recStartTime + 0.3) {
    addTake(recStartTime, endTime);
  }
  stopPlayback();
}

function retakeLastTake() {
  if (state.takes.length === 0) return;
  const last = state.takes[state.takes.length - 1];
  const t = last.startSec;
  deleteTake(last.id);
  seekToTime(t);
}

// ─── 動画プレーヤー初期化 ───
function extractYouTubeVideoId(url) {
  if (!url) return "";
  var m = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?.*v=|embed\/|shorts\/))([A-Za-z0-9_-]{11})/);
  if (m) return m[1];
  if (/^[A-Za-z0-9_-]{11}$/.test(url.trim())) return url.trim();
  return "";
}

function initVideoPlayer() {
  var videoId = extractYouTubeVideoId(state.youtubeUrl);
  var fileUrl = state.rawAudioUrl || state.cleanedAudioUrl || "";

  if (!videoId && !fileUrl) return;

  els.videoPanel.hidden = false;

  if (videoId) {
    mountYouTubePlayer(videoId);
  } else if (fileUrl) {
    mountFilePlayer(fileUrl);
  }
}

function mountYouTubePlayer(videoId) {
  els.filePlayer.hidden = true;

  var tag = document.createElement("script");
  tag.src = "https://www.youtube.com/iframe_api";
  tag.async = true;
  document.head.appendChild(tag);

  window.onYouTubeIframeAPIReady = function() {
    state.ytPlayer = new window.YT.Player("boothYtPlayer", {
      videoId: videoId,
      width: "100%",
      height: "100%",
      playerVars: {
        rel: 0,
        modestbranding: 1,
        playsinline: 1,
        enablejsapi: 1,
        origin: window.location.origin
      },
      events: {
        onReady: function(ev) {
          state.ytPlayer = ev.target;
          ev.target.mute();
          ev.target.setVolume(0);
          if (state.playbackTime > 0) {
            boothMediaSeek(state.playbackTime, { pause: true });
          }
        }
      }
    });
  };

  if (window.YT && window.YT.Player) {
    window.onYouTubeIframeAPIReady();
  }
}

function mountFilePlayer(url) {
  els.ytPlayer.style.display = "none";
  els.filePlayer.hidden = false;
  els.filePlayer.src = url;
  els.filePlayer.muted = true;
  els.filePlayer.load();
}

// ─── 波形プレースホルダー ───
function drawWaveformPlaceholder(container, color, seed) {
  const canvas = document.createElement("canvas");
  const w = container.clientWidth || 500;
  const h = container.clientHeight || 72;
  canvas.width = w * 2;
  canvas.height = h * 2;
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  container.appendChild(canvas);

  const ctx = canvas.getContext("2d");
  const cw = canvas.width;
  const ch = canvas.height;
  const mid = ch / 2;
  ctx.fillStyle = "rgba(0,0,0,0.25)";
  ctx.fillRect(0, 0, cw, ch);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.globalAlpha = 0.85;
  ctx.beginPath();
  const rng = mulberry32(seed);
  for (let x = 0; x < cw; x++) {
    const t = x / cw;
    const envelope = Math.sin(t * Math.PI) * 0.7 + 0.3;
    const freq1 = Math.sin(x * 0.015 + seed) * 0.35;
    const freq2 = Math.sin(x * 0.04 + seed * 2) * 0.25;
    const freq3 = Math.sin(x * 0.08 + seed * 3) * 0.12;
    const noise = (rng() - 0.5) * 0.15;
    const amp = (freq1 + freq2 + freq3 + noise) * envelope * (ch * 0.38);
    if (x === 0) ctx.moveTo(x, mid + amp);
    else ctx.lineTo(x, mid + amp);
  }
  ctx.stroke();
  ctx.globalAlpha = 0.4;
  ctx.beginPath();
  for (let x = 0; x < cw; x++) {
    const t = x / cw;
    const envelope = Math.sin(t * Math.PI) * 0.7 + 0.3;
    const freq1 = Math.sin(x * 0.015 + seed + Math.PI) * 0.35;
    const freq2 = Math.sin(x * 0.04 + seed * 2 + Math.PI) * 0.25;
    const noise = (rng() - 0.5) * 0.12;
    const amp = (freq1 + freq2 + noise) * envelope * (ch * 0.38);
    if (x === 0) ctx.moveTo(x, mid + amp);
    else ctx.lineTo(x, mid + amp);
  }
  ctx.stroke();
}

function mulberry32(a) {
  return function() {
    let t = a += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// ─── スクロール検出 ───
function handleLyricsScroll() {
  if (!state.isPlaying) return;
  state.userScrolling = true;
  els.snapBackBtn.hidden = false;
  clearTimeout(state.scrollTimeout);
  state.scrollTimeout = setTimeout(() => {
    state.userScrolling = false;
    els.snapBackBtn.hidden = true;
  }, 4000);
}

function snapBackToPlayback() {
  state.userScrolling = false;
  els.snapBackBtn.hidden = true;
  if (state.currentLineIdx >= 0) scrollToActiveLine(state.currentLineIdx);
}

// ─── 設定パネル ───
function initSettings() {
  if (els.preRoll) els.preRoll.value = state.settings.preRollSec;
  if (els.audioOffset) {
    els.audioOffset.value = state.settings.audioOffsetSec;
    updateOffsetDisplay();
    els.audioOffset.addEventListener("input", updateOffsetDisplay);
  }
}

function updateOffsetDisplay() {
  const val = Number(els.audioOffset?.value || 0);
  if (els.audioOffsetVal) {
    els.audioOffsetVal.textContent = `${val >= 0 ? "+" : ""}${val.toFixed(1)}秒`;
  }
}

// ─── バグ報告 ───
function initBugReport() {
  els.bugCopyBtn?.addEventListener("click", () => {
    const text = buildBugReport();
    navigator.clipboard?.writeText(text).then(() => {
      els.bugCopyBtn.textContent = "コピーしました";
      setTimeout(() => { els.bugCopyBtn.textContent = "内容をコピー"; }, 2000);
    });
  });

  els.bugSendBtn?.addEventListener("click", () => {
    const text = buildBugReport();
    const subject = encodeURIComponent("WAVRICK 収録ブース バグ報告");
    const body = encodeURIComponent(text);
    window.open(`mailto:support@wavrick.com?subject=${subject}&body=${body}`, "_self");
  });
}

function buildBugReport() {
  const content = els.bugText?.value || "(未記入)";
  const email = els.bugEmail?.value || "(未記入)";
  const env = `${navigator.userAgent}\nPage: record-booth.html\nTime: ${new Date().toISOString()}`;
  return `【バグ内容】\n${content}\n\n【連絡先】\n${email}\n\n【環境】\n${env}`;
}

// ─── イベント ───
function bindEvents() {
  els.backBtn.addEventListener("click", () => {
    window.location.href = "./record-workspace.html";
  });

  els.enToggle.addEventListener("change", () => {
    document.body.classList.toggle("booth-en-visible", els.enToggle.checked);
  });

  els.scriptDropdownBtn.addEventListener("click", toggleScriptMenu);

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".booth-script-selector")) {
      els.scriptMenu.hidden = true;
      els.scriptSelector.classList.remove("is-open");
    }
  });

  els.recBtn.addEventListener("click", () => {
    if (state.isRecording) stopRecording();
    else startRecording();
  });
  els.stopBtn.addEventListener("click", stopRecording);
  els.playBtn.addEventListener("click", () => {
    if (state.isPlaying) stopPlayback();
    else startPlayback();
  });
  els.retakeBtn.addEventListener("click", retakeLastTake);

  els.masterSeek.addEventListener("input", (e) => {
    const sec = (Number(e.target.value) / 10000) * state.duration;
    seekToTime(sec);
  });

  els.lyricsScroll.addEventListener("scroll", handleLyricsScroll, { passive: true });
  els.snapBackBtn.addEventListener("click", snapBackToPlayback);

  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
    switch (e.code) {
      case "Space":
        e.preventDefault();
        if (state.isRecording) stopRecording();
        else if (e.shiftKey) { state.isPlaying ? stopPlayback() : startPlayback(); }
        else startRecording();
        break;
      case "KeyS":
        if (!e.metaKey && !e.ctrlKey) { e.preventDefault(); state.isRecording ? stopRecording() : stopPlayback(); }
        break;
      case "KeyR":
        if (!e.metaKey && !e.ctrlKey) { e.preventDefault(); if (!state.isRecording) startRecording(); }
        break;
      case "ArrowUp": e.preventDefault(); navigateLine(-1); break;
      case "ArrowDown": e.preventDefault(); navigateLine(1); break;
      case "Escape": if (state.isRecording) stopRecording(); break;
    }
  });
}

function navigateLine(dir) {
  const block = currentBlock();
  let nextIdx = (state.currentLineIdx < 0 ? 0 : state.currentLineIdx) + dir;
  if (nextIdx < 0) nextIdx = 0;
  if (nextIdx >= block.length) nextIdx = block.length - 1;
  seekToLine(nextIdx);
}

// ─── Master ticks ───
function renderMasterTicks() {
  if (!els.masterTicks) return;
  els.masterTicks.innerHTML = "";
  const tickCount = 8;
  for (let i = 0; i <= tickCount; i++) {
    const t = (state.duration * i) / tickCount;
    const span = document.createElement("span");
    span.textContent = fmtTcShort(t);
    els.masterTicks.appendChild(span);
  }
}

// ─── 初期化 ───
function init() {
  cacheDom();
  loadSyncedData();
  renderScriptSelector();
  renderLyrics();
  renderTakes();
  renderMasterTicks();
  updateTimeDisplay();
  initSettings();
  initBugReport();
  initVideoPlayer();
  bindEvents();

  requestAnimationFrame(() => {
    drawWaveformPlaceholder(els.refWave, "rgba(91, 143, 217, 0.9)", 42);
    drawWaveformPlaceholder(els.recWave, "rgba(74, 222, 128, 0.85)", 137);
  });
}

// ─── ブラウザ「戻る」対策: 再生位置・ブロック状態を sessionStorage に保存＆復元 ───
const _BOOTH_UI_STATE_KEY = "wavrick_booth_ui_state";

function _boothSaveUiState() {
  try {
    const data = {
      currentBlockIdx: state.currentBlockIdx,
      currentLineIdx: state.currentLineIdx,
      playbackTime: state.playbackTime,
      isPlaying: state.isPlaying,
      settings: state.settings,
      enToggle: Boolean(els.enToggle && els.enToggle.checked),
      masterSeek: els.masterSeek ? Number(els.masterSeek.value) : 0,
      lyricsScrollTop: els.lyricsScroll ? els.lyricsScroll.scrollTop : 0,
      savedAt: Date.now()
    };
    sessionStorage.setItem(_BOOTH_UI_STATE_KEY, JSON.stringify(data));
    saveTakesToSync();
    boothPersistFullSync();
  } catch (e) { /* ignore */ }
}

function _boothRestoreUiState() {
  try {
    const raw = sessionStorage.getItem(_BOOTH_UI_STATE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (typeof saved.currentBlockIdx === "number" && saved.currentBlockIdx < state.blocks.length) {
      state.currentBlockIdx = saved.currentBlockIdx;
      loadTakesForCurrentBlock();
      renderScriptSelector();
      renderLyrics();
      renderTakes();
    }
    if (typeof saved.currentLineIdx === "number") {
      state.currentLineIdx = saved.currentLineIdx;
      updateLyricsHighlight(state.playbackTime || 0);
    }
    if (typeof saved.playbackTime === "number" && saved.playbackTime >= 0) {
      seekToTime(saved.playbackTime);
    }
    if (saved.settings) {
      for (var key in saved.settings) {
        if (saved.settings.hasOwnProperty(key)) state.settings[key] = saved.settings[key];
      }
      initSettings();
    }
    if (els.enToggle) {
      els.enToggle.checked = Boolean(saved.enToggle);
      document.body.classList.toggle("booth-en-visible", els.enToggle.checked);
    }
    if (typeof saved.masterSeek === "number" && els.masterSeek) {
      els.masterSeek.value = String(saved.masterSeek);
      updateSeekbar();
      updateTimeDisplay();
    }
    if (typeof saved.lyricsScrollTop === "number" && els.lyricsScroll) {
      els.lyricsScroll.scrollTop = saved.lyricsScrollTop;
    }
    if (saved.isPlaying) {
      startPlayback();
    }
  } catch (e) { /* ignore */ }
}

window.addEventListener("pagehide", _boothSaveUiState);
window.addEventListener("visibilitychange", function() {
  if (document.visibilityState === "hidden") _boothSaveUiState();
});
window.addEventListener("beforeunload", _boothSaveUiState);
window.addEventListener("pageshow", function(e) {
  if (e.persisted) _boothRestoreUiState();
});

(function boot() {
  function safeInit() {
    try {
      init();
      _boothRestoreUiState();
    } catch (err) {
      console.error("[booth-app] init error:", err);
      var msg = document.createElement("div");
      msg.style.cssText = "position:fixed;top:0;left:0;right:0;padding:1em;background:#c00;color:#fff;z-index:9999;font-size:14px;white-space:pre-wrap";
      msg.textContent = "[booth-app error] " + (err.message || err) + "\n" + (err.stack || "");
      document.body.appendChild(msg);
    }
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", safeInit);
  } else {
    safeInit();
  }
})();
