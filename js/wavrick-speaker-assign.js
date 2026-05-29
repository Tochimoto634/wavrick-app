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
      mode: mode === "pick" ? "pick" : "omakase",
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

  global.WavrickSpeakerAssign = {
    GAP_SEC_DEFAULT,
    normalizeWhisperSegments,
    whisperDurationFromSegments,
    buildPlainOffsetTimeMapper,
    groupSpeakerLinesByTimeGap,
    rememberVaPreset,
    suggestVaPreset
  };
})(typeof window !== "undefined" ? window : globalThis);
