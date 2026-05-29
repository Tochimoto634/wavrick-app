/**
 * WAVRICK — 仮決済・声優受諾・お任せマッチング
 */
(function initWavrickTransaction(global) {
  const SLOT_STATUS = {
    pending_match: "pending_match",
    pending_acceptance: "pending_acceptance",
    accepted: "accepted",
    declined: "declined"
  };

  const TRANSACTION_PHASE = {
    draft: "draft",
    quoted: "quoted",
    paid_provisional: "paid_provisional",
    awaiting_acceptance: "awaiting_acceptance",
    in_production: "in_production",
    cancelled: "cancelled"
  };

  function normalizeSlot(raw, fallbackIndex) {
    return {
      speakerIndex: Number(raw.speakerIndex ?? fallbackIndex ?? 1),
      mode: raw.mode === "pick" ? "pick" : "omakase",
      talentId: raw.talentId ? String(raw.talentId) : "",
      displayName: raw.displayName ? String(raw.displayName) : "",
      status: raw.status || SLOT_STATUS.pending_acceptance,
      offerSentAt: raw.offerSentAt || null,
      respondedAt: raw.respondedAt || null
    };
  }

  function initCastAcceptanceFromSlots(slots, { resolveVoice, omakaseCriteria, excludeTalentIds = [] } = {}) {
    const used = new Set(excludeTalentIds);
    return (slots || []).map((slot, i) => {
      const base = normalizeSlot(slot, i + 1);
      if (base.mode === "omakase") {
        const matched = autoMatchOmakaseVoice({
          criteria: omakaseCriteria,
          excludeTalentIds: [...used],
          resolveVoice
        });
        if (matched) {
          used.add(matched.talentId);
          return {
            ...base,
            talentId: matched.talentId,
            displayName: matched.displayName,
            status: SLOT_STATUS.pending_acceptance,
            offerSentAt: new Date().toISOString()
          };
        }
        return {
          ...base,
          talentId: "",
          displayName: "",
          status: SLOT_STATUS.pending_match,
          offerSentAt: null
        };
      }
      if (base.talentId) used.add(base.talentId);
      return {
        ...base,
        status: SLOT_STATUS.pending_acceptance,
        offerSentAt: new Date().toISOString()
      };
    });
  }

  function autoMatchOmakaseVoice({ criteria, excludeTalentIds, resolveVoice, allProfiles }) {
    const profiles =
      allProfiles ||
      (typeof resolveVoice === "function" && global.WavrickPricing
        ? []
        : []);
    const list =
      profiles.length > 0
        ? profiles
        : typeof global.loadVoiceProfilesForMatch === "function"
          ? global.loadVoiceProfilesForMatch()
          : [];

    const budgetMax = criteria?.budgetMaxUsd != null ? Number(criteria.budgetMaxUsd) : null;
    const genres = String(criteria?.genres || "")
      .split(",")
      .map((g) => g.trim().toLowerCase())
      .filter(Boolean);
    const gender = String(criteria?.gender || "").trim().toLowerCase();
    const exclude = new Set(excludeTalentIds || []);

    let candidates = list.filter((p) => {
      const tid = p.talentId || p.id;
      if (!tid || exclude.has(tid)) return false;
      const P = global.WavrickPricing;
      const ppm = P ? P.normalizeVoicePricing(p).pricePerMinute : 15;
      if (budgetMax != null && !Number.isNaN(budgetMax) && ppm > budgetMax) return false;
      if (genres.length) {
        const pg = String(p.genres || "")
          .split(",")
          .map((g) => g.trim().toLowerCase());
        if (!genres.some((g) => pg.includes(g))) return false;
      }
      if (gender && p.gender && String(p.gender).toLowerCase() !== gender) return false;
      return true;
    });

    if (!candidates.length) {
      candidates = list.filter((p) => {
        const tid = p.talentId || p.id;
        return tid && !exclude.has(tid);
      });
    }
    if (!candidates.length) return null;

    candidates.sort((a, b) => Number(b.jobCount || 0) - Number(a.jobCount || 0));
    const pick = candidates[0];
    const talentId = pick.talentId || pick.id || "";
    return {
      talentId,
      displayName: pick.displayName || pick.name || "声優"
    };
  }

  function allSlotsAssigned(slots) {
    return (slots || []).every((s) => s.talentId && s.status !== SLOT_STATUS.pending_match);
  }

  /** お任せ枠がある場合、全話者の割当が終わるまで顧客に声優名を見せない */
  function customerCanSeeTalentNames(slots) {
    if (!Array.isArray(slots) || !slots.length) return true;
    const hasOmakase = slots.some((s) => s.mode === "omakase");
    if (!hasOmakase) return true;
    return allSlotsAssigned(slots);
  }

  function getCustomerSlotLabel(slot, slots) {
    if (slot.mode === "omakase" && !customerCanSeeTalentNames(slots)) {
      if (slot.status === SLOT_STATUS.pending_match) return "お任せ（マッチング中）";
      return "お任せ（割り当て済み）";
    }
    if (slot.mode === "pick" && slot.status === SLOT_STATUS.declined) {
      return `${slot.displayName || "声優"} — 辞退（再選択が必要）`;
    }
    return slot.displayName || slot.talentId || "未設定";
  }

  function countPendingAcceptance(slots) {
    return (slots || []).filter((s) => s.status === SLOT_STATUS.pending_acceptance).length;
  }

  function allSlotsAccepted(slots) {
    return (
      (slots || []).length > 0 &&
      (slots || []).every((s) => s.status === SLOT_STATUS.accepted && s.talentId)
    );
  }

  function hasDeclinedPick(slots) {
    return (slots || []).some((s) => s.mode === "pick" && s.status === SLOT_STATUS.declined);
  }

  /** 自分は回答済みだが、他の声優の回答待ち */
  function isTransactionOnHoldForVoice(slots, myTalentId) {
    const mine = (slots || []).find((s) => s.talentId === myTalentId);
    if (!mine) return false;
    if (mine.status === SLOT_STATUS.pending_acceptance) return false;
    if (mine.status === SLOT_STATUS.accepted) return countPendingAcceptance(slots) > 0;
    return false;
  }

  function getVoiceSlotForTalent(slots, talentId) {
    return (slots || []).find((s) => s.talentId === talentId) || null;
  }

  function applyVoiceAccept(slots, talentId) {
    return (slots || []).map((s) =>
      s.talentId === talentId
        ? { ...s, status: SLOT_STATUS.accepted, respondedAt: new Date().toISOString() }
        : s
    );
  }

  function applyVoiceDecline(slots, talentId, { resolveVoice, omakaseCriteria, allProfiles }) {
    const slot = getVoiceSlotForTalent(slots, talentId);
    if (!slot) return { slots, rematchedOmakase: false, needsCustomerRecast: false };

    if (slot.mode === "omakase") {
      const exclude = (slots || []).map((s) => s.talentId).filter(Boolean);
      const matched = autoMatchOmakaseVoice({
        criteria: omakaseCriteria,
        excludeTalentIds: exclude,
        allProfiles
      });
      const next = (slots || []).map((s) => {
        if (s.talentId !== talentId) return s;
        if (!matched) {
          return {
            ...s,
            talentId: "",
            displayName: "",
            status: SLOT_STATUS.pending_match,
            respondedAt: new Date().toISOString()
          };
        }
        return {
          ...s,
          talentId: matched.talentId,
          displayName: matched.displayName,
          status: SLOT_STATUS.pending_acceptance,
          offerSentAt: new Date().toISOString(),
          respondedAt: new Date().toISOString()
        };
      });
      return { slots: next, rematchedOmakase: true, needsCustomerRecast: false };
    }

    const next = (slots || []).map((s) =>
      s.talentId === talentId
        ? { ...s, status: SLOT_STATUS.declined, respondedAt: new Date().toISOString() }
        : s
    );
    return { slots: next, rematchedOmakase: false, needsCustomerRecast: true };
  }

  function applyCustomerRecast(slots, speakerIndex, talentId, displayName) {
    return (slots || []).map((s) =>
      s.speakerIndex === speakerIndex
        ? {
            ...s,
            mode: "pick",
            talentId,
            displayName,
            status: SLOT_STATUS.pending_acceptance,
            offerSentAt: new Date().toISOString(),
            respondedAt: null
          }
        : s
    );
  }

  function slotStatusLabel(status, { onHold = false } = {}) {
    if (onHold) return "取引保留中";
    switch (status) {
      case SLOT_STATUS.pending_match:
        return "マッチング中";
      case SLOT_STATUS.pending_acceptance:
        return "回答待ち";
      case SLOT_STATUS.accepted:
        return "受諾済み";
      case SLOT_STATUS.declined:
        return "辞退";
      default:
        return status;
    }
  }

  function transactionPhaseLabel(phase) {
    switch (phase) {
      case TRANSACTION_PHASE.paid_provisional:
        return "決済完了";
      case TRANSACTION_PHASE.awaiting_acceptance:
        return "声優の回答待ち";
      case TRANSACTION_PHASE.in_production:
        return "進行中";
      case TRANSACTION_PHASE.cancelled:
        return "キャンセル";
      default:
        return phase || "—";
    }
  }

  global.WavrickTransaction = {
    SLOT_STATUS,
    TRANSACTION_PHASE,
    initCastAcceptanceFromSlots,
    autoMatchOmakaseVoice,
    allSlotsAssigned,
    customerCanSeeTalentNames,
    getCustomerSlotLabel,
    countPendingAcceptance,
    allSlotsAccepted,
    hasDeclinedPick,
    isTransactionOnHoldForVoice,
    getVoiceSlotForTalent,
    applyVoiceAccept,
    applyVoiceDecline,
    applyCustomerRecast,
    slotStatusLabel,
    transactionPhaseLabel
  };
})(typeof window !== "undefined" ? window : globalThis);
