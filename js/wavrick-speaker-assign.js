/**
 * 話者割り当て: Whisper タイムマップ・10秒ギャップ分割・声優プリセット
 */
(function initWavrickSpeakerAssign(global) {
  const PRESETS_KEY = "wavrick_speaker_va_presets";
  const GAP_SEC_DEFAULT = 10;

  function normalizeWhisperSegments(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const row of raw) {
      if (!row || typeof row !== "object") continue;
      const text = String(row.text || "").trim();
      if (!text) continue;
      out.push({
        start: Math.max(0, Number(row.start) || 0),
        end: Math.max(0, Number(row.end) || 0),
        text
      });
    }
    return out;
  }

  function whisperDurationFromSegments(segments) {
    if (!segments.length) return 0;
    return segments.reduce((m, s) => Math.max(m, Number(s.end) || 0), 0);
  }

  /**
   * @param {string} plain
   * @param {{start:number,end:number,text:string}[]} segments
   * @param {number} durationSec
   */
  function buildPlainOffsetTimeMapper(plain, segments, durationSec) {
    const segJoined = segments.map((s) => s.text).join("");
    const useSegments =
      segments.length > 0 &&
      plain.length > 0 &&
      segJoined.length > 0 &&
      Math.abs(plain.length - segJoined.length) / Math.max(plain.length, 1) < 0.2;

    if (useSegments) {
      const bounds = [];
      let charCursor = 0;
      for (const seg of segments) {
        const len = seg.text.length;
        bounds.push({
          startChar: charCursor,
          endChar: charCursor + len,
          startSec: seg.start,
          endSec: seg.end > seg.start ? seg.end : seg.start + 0.01
        });
        charCursor += len;
      }
      return (offset) => {
        const o = Math.max(0, Math.min(offset, plain.length));
        const hit =
          bounds.find((b) => o >= b.startChar && o <= b.endChar) ||
          bounds[bounds.length - 1];
        if (!hit) return 0;
        const span = Math.max(1, hit.endChar - hit.startChar);
        const ratio = (o - hit.startChar) / span;
        return hit.startSec + ratio * (hit.endSec - hit.startSec);
      };
    }

    const total = durationSec > 0 ? durationSec : 1;
    return (offset) => (Math.max(0, offset) / Math.max(plain.length, 1)) * total;
  }

  /**
   * 同一話者の連続レンジを、間隔が gapSec 超なら別ブロックに分ける
   */
  function groupSpeakerLinesByTimeGap(ranges, plain, timeAt, gapSec = GAP_SEC_DEFAULT) {
    const sorted = [...ranges].sort((a, b) => a.start - b.start);
    const blocks = [];
    let batch = [];
    let lastEndTime = null;

    const flush = () => {
      if (!batch.length) return;
      blocks.push(batch.join(" "));
      batch = [];
    };

    for (const r of sorted) {
      const t = plain.slice(r.start, r.end).trim();
      if (!t) continue;
      const startT = timeAt(r.start);
      if (lastEndTime != null && startT - lastEndTime > gapSec) flush();
      batch.push(t);
      lastEndTime = timeAt(r.end);
    }
    flush();
    return blocks;
  }

  function getPresetAccountKey() {
    try {
      const raw = localStorage.getItem("wavrick_session");
      if (raw) {
        const s = JSON.parse(raw);
        if (s?.role === "customer") {
          const email = String(s?.email || "").trim().toLowerCase();
          if (email) return `email:${email}`;
        }
      }
    } catch (_) {
      /* ignore */
    }
    return "local:anonymous";
  }

  function loadVaPresets() {
    try {
      const raw = localStorage.getItem(PRESETS_KEY);
      if (!raw) return { version: 1, entries: [] };
      const parsed = JSON.parse(raw);
      const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
      return { version: 1, entries };
    } catch (_) {
      return { version: 1, entries: [] };
    }
  }

  function saveVaPresets(store) {
    localStorage.setItem(
      PRESETS_KEY,
      JSON.stringify({
        version: 1,
        updatedAt: new Date().toISOString(),
        entries: store.entries || []
      })
    );
  }

  function rememberVaPreset({ speakerName, talentId, displayName, mode }) {
    const name = String(speakerName || "").trim();
    const tid = String(talentId || "").trim();
    if (!name || !tid) return;
    const accountKey = getPresetAccountKey();
    const store = loadVaPresets();
    const entries = store.entries.filter(
      (e) =>
        !(
          e.accountKey === accountKey &&
          e.speakerName === name &&
          e.talentId === tid
        )
    );
    entries.unshift({
      accountKey,
      speakerName: name,
      talentId: tid,
      displayName: String(displayName || "").trim(),
      mode: mode === "pick" ? "pick" : "recruit",
      usedAt: new Date().toISOString()
    });
    store.entries = entries.slice(0, 80);
    saveVaPresets(store);
  }

  function suggestVaPreset(speakerName) {
    const name = String(speakerName || "").trim();
    if (!name) return null;
    const accountKey = getPresetAccountKey();
    const store = loadVaPresets();
    const hit = store.entries.find(
      (e) => e.accountKey === accountKey && e.speakerName === name && e.talentId
    );
    return hit || null;
  }

  /**
   * 文字起こし編集後も話者割り当て範囲を維持（削除・追加箇所のみずれる）
   * @param {string} oldPlain
   * @param {string} newPlain
   * @param {{ id?: number, start: number, end: number, speakerIndex: number }[]} ranges
   */
  function remapSpeakerAssignRanges(oldPlain, newPlain, ranges) {
    const oldText = String(oldPlain || "");
    const newText = String(newPlain || "");
    if (!Array.isArray(ranges) || !ranges.length) return [];
    if (oldText === newText) return ranges.map((r) => ({ ...r }));

    const map = buildPlainOffsetMap(oldText, newText);
    const out = [];
    const lost = [];
    for (const r of ranges) {
      const start = Math.max(0, Math.min(Number(r.start) || 0, oldText.length));
      const end = Math.max(start, Math.min(Number(r.end) || 0, oldText.length));
      if (end <= start) continue;
      const newStart = mapBoundary(map, start);
      const newEnd = mapBoundary(map, end);
      if (newEnd > newStart) {
        out.push({
          ...r,
          start: newStart,
          end: newEnd
        });
      } else {
        lost.push(r);
      }
    }

    if (lost.length) {
      for (const r of lost) {
        const start = Math.max(0, Math.min(Number(r.start) || 0, oldText.length));
        const end = Math.max(start, Math.min(Number(r.end) || 0, oldText.length));
        if (end <= start) continue;
        const slice = oldText.slice(start, end);
        const trimmed = slice.trim();
        if (!trimmed) continue;
        let idx = newText.indexOf(slice);
        if (idx < 0) idx = newText.indexOf(trimmed);
        if (idx < 0) continue;
        const useLen = newText.slice(idx, idx + slice.length) === slice ? slice.length : trimmed.length;
        const newStart = idx;
        const newEnd = idx + useLen;
        if (newEnd <= newStart) continue;
        out.push({ ...r, start: newStart, end: newEnd });
      }
    }

    out.sort((a, b) => a.start - b.start || a.end - b.end);
    if (out.length) return out;

    return recoverAssignRangesByTextAnchor(oldText, newText, ranges);
  }

  function mapBoundary(map, oldBoundary) {
    const idx = Math.max(0, Math.min(oldBoundary, map.length - 1));
    return map[idx];
  }

  /**
   * オフセットマップで失われた範囲を、割当テキストの一致検索で復元
   */
  function recoverAssignRangesByTextAnchor(oldPlain, newPlain, ranges) {
    const oldText = String(oldPlain || "");
    const newText = String(newPlain || "");
    const out = [];
    let searchFrom = 0;
    for (const r of [...(ranges || [])].sort((a, b) => a.start - b.start)) {
      const start = Math.max(0, Math.min(Number(r.start) || 0, oldText.length));
      const end = Math.max(start, Math.min(Number(r.end) || 0, oldText.length));
      if (end <= start) continue;
      const slice = oldText.slice(start, end);
      const trimmed = slice.trim();
      if (!trimmed) continue;

      let idx = newText.indexOf(slice, searchFrom);
      if (idx < 0) idx = newText.indexOf(trimmed, searchFrom);
      if (idx < 0) idx = newText.indexOf(trimmed);
      if (idx < 0) continue;

      const useLen = newText.slice(idx, idx + slice.length) === slice ? slice.length : trimmed.length;
      const newStart = idx;
      const newEnd = idx + useLen;
      if (newEnd <= newStart) continue;
      out.push({ ...r, start: newStart, end: newEnd });
      searchFrom = newEnd;
    }
    return out;
  }

  function buildPlainOffsetMap(oldText, newText) {
    const oldLen = oldText.length;
    const newLen = newText.length;
    if (oldText === newText) {
      return Array.from({ length: oldLen + 1 }, (_, i) => i);
    }

    let prefix = 0;
    while (prefix < oldLen && prefix < newLen && oldText[prefix] === newText[prefix]) prefix++;

    let suffix = 0;
    while (
      suffix < oldLen - prefix &&
      suffix < newLen - prefix &&
      oldText[oldLen - 1 - suffix] === newText[newLen - 1 - suffix]
    ) {
      suffix++;
    }

    const map = new Array(oldLen + 1);
    for (let i = 0; i <= prefix; i++) map[i] = i;

    const oldMid = oldText.slice(prefix, oldLen - suffix);
    const newMid = newText.slice(prefix, newLen - suffix);
    const midMap = buildMiddlePlainOffsetMap(oldMid, newMid);
    for (let i = 0; i <= oldMid.length; i++) {
      map[prefix + i] = prefix + midMap[i];
    }

    const oldTail = prefix + oldMid.length;
    const newTail = prefix + newMid.length;
    for (let i = 0; i <= suffix; i++) {
      map[oldTail + i] = newTail + i;
    }
    return map;
  }

  function buildMiddlePlainOffsetMap(oldMid, newMid) {
    if (oldMid === newMid) {
      return Array.from({ length: oldMid.length + 1 }, (_, i) => i);
    }
    if (!oldMid.length) return [0];
    if (!newMid.length) {
      return Array.from({ length: oldMid.length + 1 }, () => 0);
    }
    if (oldMid.length <= 4000 && newMid.length <= 4000) {
      return buildMiddleMapFromCharDiff(oldMid, newMid);
    }
    return buildMiddleMapFromWordDiff(oldMid, newMid);
  }

  function mergeDiffParts(parts) {
    const out = [];
    for (const p of parts) {
      const last = out[out.length - 1];
      if (last && last.type === p.type) last.text += p.text;
      else out.push({ type: p.type, text: p.text });
    }
    return out;
  }

  function computeCharDiff(oldStr, newStr) {
    const n = oldStr.length;
    const m = newStr.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = 1; i <= n; i++) {
      for (let j = 1; j <= m; j++) {
        if (oldStr[i - 1] === newStr[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
        else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
    const raw = [];
    let i = n;
    let j = m;
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && oldStr[i - 1] === newStr[j - 1]) {
        raw.unshift({ type: "equal", text: oldStr[i - 1] });
        i--;
        j--;
      } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
        raw.unshift({ type: "insert", text: newStr[j - 1] });
        j--;
      } else {
        raw.unshift({ type: "delete", text: oldStr[i - 1] });
        i--;
      }
    }
    return mergeDiffParts(raw);
  }

  function buildMiddleMapFromCharDiff(oldMid, newMid) {
    const diff = computeCharDiff(oldMid, newMid);
    const map = new Array(oldMid.length + 1);
    let o = 0;
    let n = 0;
    for (const part of diff) {
      if (part.type === "equal") {
        for (let k = 0; k < part.text.length; k++) {
          map[o] = n;
          o++;
          n++;
        }
      } else if (part.type === "delete") {
        for (let k = 0; k < part.text.length; k++) {
          map[o] = n;
          o++;
        }
      } else if (part.type === "insert") {
        n += part.text.length;
      }
    }
    map[o] = n;
    return map;
  }

  function tokenizePlainWithOffsets(text) {
    const tokens = [];
    const re = /(\s+|\S+)/g;
    let m;
    while ((m = re.exec(text))) {
      tokens.push({ text: m[0], start: m.index, end: m.index + m[0].length });
    }
    return tokens;
  }

  function computeTokenDiff(oldTokens, newTokens) {
    const n = oldTokens.length;
    const m = newTokens.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = 1; i <= n; i++) {
      for (let j = 1; j <= m; j++) {
        if (oldTokens[i - 1].text === newTokens[j - 1].text) dp[i][j] = dp[i - 1][j - 1] + 1;
        else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
    const raw = [];
    let i = n;
    let j = m;
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && oldTokens[i - 1].text === newTokens[j - 1].text) {
        raw.unshift({ type: "equal", old: oldTokens[i - 1], neu: newTokens[j - 1] });
        i--;
        j--;
      } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
        raw.unshift({ type: "insert", neu: newTokens[j - 1] });
        j--;
      } else {
        raw.unshift({ type: "delete", old: oldTokens[i - 1] });
        i--;
      }
    }
    return raw;
  }

  function buildMiddleMapFromWordDiff(oldMid, newMid) {
    const oldTokens = tokenizePlainWithOffsets(oldMid);
    const newTokens = tokenizePlainWithOffsets(newMid);
    const diff = computeTokenDiff(oldTokens, newTokens);
    const map = new Array(oldMid.length + 1).fill(0);
    let oCursor = 0;
    let nCursor = 0;

    const setSpan = (oldStart, oldEnd, newStart, newEnd) => {
      const oldLen = Math.max(0, oldEnd - oldStart);
      const newLen = Math.max(0, newEnd - newStart);
      if (!oldLen) return;
      if (oldLen <= 4000 && newLen <= 4000 && oldMid.slice(oldStart, oldEnd) !== newMid.slice(newStart, newEnd)) {
        const local = buildMiddleMapFromCharDiff(
          oldMid.slice(oldStart, oldEnd),
          newMid.slice(newStart, newEnd)
        );
        for (let i = 0; i < oldLen; i++) {
          map[oldStart + i] = newStart + local[i];
        }
        map[oldEnd] = newStart + local[oldLen];
        return;
      }
      for (let i = 0; i <= oldLen; i++) {
        const ratio = oldLen ? i / oldLen : 0;
        map[oldStart + i] = newStart + Math.round(newLen * ratio);
      }
    };

    for (const part of diff) {
      if (part.type === "equal") {
        const oStart = part.old.start;
        const oEnd = part.old.end;
        const nStart = part.neu.start;
        const nEnd = part.neu.end;
        setSpan(oStart, oEnd, nStart, nEnd);
        oCursor = oEnd;
        nCursor = nEnd;
      } else if (part.type === "delete") {
        const oStart = part.old.start;
        const oEnd = part.old.end;
        for (let i = oStart; i <= oEnd; i++) map[i] = nCursor;
        oCursor = oEnd;
      } else if (part.type === "insert") {
        nCursor = part.neu.end;
      }
    }
    map[oldMid.length] = newMid.length;
    return map;
  }

  /**
   * 割り当て範囲に Whisper 由来の startSec/endSec を付与（台本生成で時刻を固定）
   * @param {{start:number,end:number,speakerIndex:number}[]} ranges
   * @param {string} plain
   * @param {{start:number,end:number,text:string}[]} segments
   * @param {number} durationSec
   */
  function enrichAssignRangesWithWhisperTiming(
    ranges,
    plain,
    segments,
    durationSec = 0
  ) {
    const rows = normalizeWhisperSegments(segments);
    const timeAt = buildPlainOffsetTimeMapper(plain, rows, durationSec);
    return (ranges || []).map((r) => {
      const start = Math.max(0, Number(r.start) || 0);
      const end = Math.max(start, Number(r.end) || 0);
      if (end <= start) return { ...r, start, end };

      let startSec = timeAt(start);
      let endSec = Math.max(timeAt(end), timeAt(Math.max(start, end - 1)));
      if (endSec <= startSec) endSec = startSec + 0.35;

      return {
        ...r,
        start,
        end,
        startSec: Math.round(startSec * 1000) / 1000,
        endSec: Math.round(endSec * 1000) / 1000
      };
    });
  }

  global.WavrickSpeakerAssign = {
    GAP_SEC_DEFAULT,
    normalizeWhisperSegments,
    whisperDurationFromSegments,
    buildPlainOffsetTimeMapper,
    groupSpeakerLinesByTimeGap,
    enrichAssignRangesWithWhisperTiming,
    rememberVaPreset,
    suggestVaPreset,
    remapSpeakerAssignRanges,
    recoverAssignRangesByTextAnchor,
    buildPlainOffsetMap
  };
})(typeof window !== "undefined" ? window : globalThis);
