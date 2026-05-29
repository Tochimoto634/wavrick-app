/**
 * WAVRICK — 料金計算・リテイク・分配（USD）
 */
(function initWavrickPricing(global) {
  const BILLING_BLOCK_SEC = 10;
  const MIN_PRICE_PER_MINUTE_USD = 15;
  const FREE_RETAKE_LIMIT = 3;
  const PLATFORM_FEE_RATE = 0.3;
  const VOICE_PAYOUT_RATE = 0.7;
  const DEFAULT_CUE_SEC = 4;

  const LINE_RE =
    /^\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?(?:\s*-\s*(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?)?\]\s*(.+)$/;

  const SPEAKER_HEAD_RE = /^【話者\s*(\d+)\s*\/\s*声優:\s*([^】]+)】\s*$/i;

  function fractionToSeconds(frac) {
    if (frac == null || frac === "") return 0;
    const n = Number(frac);
    if (!Number.isFinite(n)) return 0;
    const digits = String(frac).length;
    if (digits <= 2) return n / 100;
    if (digits === 3) return n / 1000;
    return n / Math.pow(10, digits);
  }

  function parseTimeParts(minutes, seconds, fraction) {
    return Number(minutes) * 60 + Number(seconds) + fractionToSeconds(fraction);
  }

  function round2(n) {
    return Math.round(Number(n) * 100) / 100;
  }

  function formatUsd(amount) {
    const n = round2(amount);
    return `$${n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
  }

  /** 生の合計秒 → 10秒単位切り上げ後の課金秒数 */
  function ceilToBillingBlocks(rawTotalSeconds) {
    const s = Math.max(0, Number(rawTotalSeconds) || 0);
    if (s <= 0) return 0;
    return Math.ceil(s / BILLING_BLOCK_SEC) * BILLING_BLOCK_SEC;
  }

  function formatBillableDuration(billableSeconds) {
    const sec = Math.max(0, Number(billableSeconds) || 0);
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}分${s}秒（10秒単位切上・課金${(sec / 60).toFixed(2)}分）`;
  }

  function lineDurationSec(startSec, endSec) {
    if (endSec != null && endSec > startSec) return endSec - startSec;
    return DEFAULT_CUE_SEC;
  }

  /** タイムコード台本から目安枠の合計秒（生） */
  function sumRawSecondsFromScript(script) {
    let total = 0;
    for (const line of String(script || "").split(/\r?\n/)) {
      const t = line.trim();
      const m = LINE_RE.exec(t);
      if (!m) continue;
      const start = parseTimeParts(m[1], m[2], m[3]);
      const end = m[4] != null ? parseTimeParts(m[4], m[5], m[6]) : null;
      total += lineDurationSec(start, end);
    }
    return total;
  }

  function computeBillableSecondsFromScript(script) {
    return ceilToBillingBlocks(sumRawSecondsFromScript(script));
  }

  /** 話者ブロックごとに台本を分割 */
  function splitScriptBySpeaker(script) {
    const raw = String(script || "");
    const sections = [];
    let current = null;
    for (const line of raw.split(/\r?\n/)) {
      const head = SPEAKER_HEAD_RE.exec(line.trim());
      if (head) {
        if (current) sections.push(current);
        current = { speakerIndex: Number(head[1]), label: head[2].trim(), lines: [] };
        continue;
      }
      if (current) current.lines.push(line);
    }
    if (current) sections.push(current);
    if (!sections.length && raw.trim()) {
      sections.push({ speakerIndex: 1, label: "", lines: raw.split(/\r?\n/) });
    }
    return sections.map((s) => ({
      speakerIndex: s.speakerIndex,
      label: s.label,
      script: s.lines.join("\n").trim()
    }));
  }

  function normalizeVoicePricing(profile) {
    const ppmRaw = profile?.pricePerMinute ?? profile?.price_per_minute ?? null;
    let pricePerMinute =
      ppmRaw !== null && ppmRaw !== "" && Number.isFinite(Number(ppmRaw))
        ? Number(ppmRaw)
        : MIN_PRICE_PER_MINUTE_USD;
    pricePerMinute = Math.max(MIN_PRICE_PER_MINUTE_USD, pricePerMinute);
    const minimumOrderPrice = Math.max(
      0,
      Number(profile?.minimumOrderPrice ?? profile?.minimum_order_price ?? 0) || 0
    );
    const additionalRetakePrice = Math.max(
      0,
      Number(profile?.additionalRetakePrice ?? profile?.additional_retake_price ?? 0) || 0
    );
    return { pricePerMinute, minimumOrderPrice, additionalRetakePrice };
  }

  function validateVoicePricingInput(data) {
    const p = normalizeVoicePricing(data);
    const errors = [];
    const ppmIn = Number(data?.pricePerMinute ?? data?.price_per_minute);
    if (data?.pricePerMinute !== "" && data?.pricePerMinute != null && ppmIn < MIN_PRICE_PER_MINUTE_USD) {
      errors.push(`1分あたり単価は最低 ${formatUsd(MIN_PRICE_PER_MINUTE_USD)} です。`);
    }
    return { ok: errors.length === 0, errors, normalized: p };
  }

  function computeSpeakerSubtotalUsd(billableSeconds, profile) {
    const { pricePerMinute, minimumOrderPrice } = normalizeVoicePricing(profile || {});
    const minutes = billableSeconds / 60;
    let subtotalUsd = minutes * pricePerMinute;
    const minimumApplied = subtotalUsd < minimumOrderPrice;
    if (minimumApplied) subtotalUsd = minimumOrderPrice;
    return {
      billableSeconds,
      rawSeconds: null,
      minutes: round2(minutes),
      pricePerMinute,
      minimumOrderPrice,
      minimumApplied,
      subtotalUsd: round2(subtotalUsd)
    };
  }

  /**
   * @param {{ castSlots: object[], script: string, resolveVoice: (talentId:string)=>object|null }} params
   */
  function computeProjectQuote(params) {
    const castSlots = Array.isArray(params.castSlots) ? params.castSlots : [];
    const script = params.script || "";
    const resolveVoice = params.resolveVoice || (() => null);
    const sections = splitScriptBySpeaker(script);
    const speakerLines = [];

    for (const slot of castSlots) {
      const idx = Number(slot.speakerIndex) || 0;
      const section = sections.find((s) => s.speakerIndex === idx);
      const sectionScript = section?.script || script;
      const rawSec = sumRawSecondsFromScript(sectionScript);
      const billableSeconds = ceilToBillingBlocks(rawSec);
      const talentId = slot.mode === "pick" ? slot.talentId : "";
      const voice = talentId ? resolveVoice(talentId) : null;
      const line = computeSpeakerSubtotalUsd(billableSeconds, voice || { pricePerMinute: MIN_PRICE_PER_MINUTE_USD });
      speakerLines.push({
        speakerIndex: idx,
        castMode: slot.mode,
        talentId: talentId || null,
        displayName: slot.displayName || (voice?.displayName ?? "おまかせ"),
        rawSeconds: rawSec,
        ...line
      });
    }

    const totalUsd = round2(speakerLines.reduce((a, l) => a + l.subtotalUsd, 0));
    const platformUsd = round2(totalUsd * PLATFORM_FEE_RATE);
    const voiceUsd = round2(totalUsd * VOICE_PAYOUT_RATE);

    return {
      currency: "USD",
      totalUsd,
      platformUsd,
      voiceUsd,
      platformFeeRate: PLATFORM_FEE_RATE,
      voicePayoutRate: VOICE_PAYOUT_RATE,
      totalBillableSeconds: speakerLines.reduce((a, l) => a + l.billableSeconds, 0),
      speakers: speakerLines
    };
  }

  function countRevisionSessions(messages) {
    if (!Array.isArray(messages)) return 0;
    return messages.filter((m) => m && m.kind === "revision").length;
  }

  function evaluateRetakeRequest(params) {
    const used = Number(params.freeRetakesUsed ?? params.revisionCount ?? 0);
    const messages = params.messages || [];
    const usedFromMessages = countRevisionSessions(messages);
    const freeUsed = Math.max(used, usedFromMessages);
    const feeUsd = round2(Number(params.paidRetakeFeeUsd) || 0);
    if (freeUsed < FREE_RETAKE_LIMIT) {
      return {
        allowed: true,
        isFree: true,
        freeRetakesUsed: freeUsed,
        freeRetakesRemaining: FREE_RETAKE_LIMIT - freeUsed - 1,
        feeUsd: 0,
        requiresPayment: false,
        reason: ""
      };
    }
    return {
      allowed: feeUsd > 0 ? Boolean(params.retakePaid) : false,
      isFree: false,
      freeRetakesUsed: freeUsed,
      freeRetakesRemaining: 0,
      feeUsd,
      requiresPayment: true,
      reason:
        feeUsd > 0
          ? `無料修正は${FREE_RETAKE_LIMIT}回までです。${freeUsed + 1}回目以降は ${formatUsd(feeUsd)} の決済が必要です。`
          : `無料修正は${FREE_RETAKE_LIMIT}回までです。声優の追加リテイク料金が未設定のため送信できません。`
    };
  }

  function computePaidRetakeFeeUsd(castSlots, resolveVoice) {
    let sum = 0;
    for (const slot of castSlots || []) {
      if (slot.mode !== "pick" || !slot.talentId) continue;
      const v = resolveVoice(slot.talentId);
      sum += normalizeVoicePricing(v || {}).additionalRetakePrice;
    }
    return round2(sum);
  }

  function formatVoicePricingLines(profile) {
    const p = normalizeVoicePricing(profile || {});
    const minLabel =
      p.minimumOrderPrice > 0 ? formatUsd(p.minimumOrderPrice) : "$0";
    return {
      perMinute: `${formatUsd(p.pricePerMinute)} / min`,
      minimum: `Min ${minLabel}`,
      retake: `Retake ${formatUsd(p.additionalRetakePrice)}`
    };
  }

  global.WavrickPricing = {
    BILLING_BLOCK_SEC,
    MIN_PRICE_PER_MINUTE_USD,
    FREE_RETAKE_LIMIT,
    PLATFORM_FEE_RATE,
    VOICE_PAYOUT_RATE,
    formatUsd,
    ceilToBillingBlocks,
    formatBillableDuration,
    sumRawSecondsFromScript,
    computeBillableSecondsFromScript,
    splitScriptBySpeaker,
    normalizeVoicePricing,
    validateVoicePricingInput,
    computeSpeakerSubtotalUsd,
    computeProjectQuote,
    countRevisionSessions,
    evaluateRetakeRequest,
    computePaidRetakeFeeUsd,
    formatVoicePricingLines,
    computePayoutSplit(totalUsd) {
      const t = round2(totalUsd);
      return {
        totalUsd: t,
        platformUsd: round2(t * PLATFORM_FEE_RATE),
        voiceUsd: round2(t * VOICE_PAYOUT_RATE)
      };
    }
  };
})(typeof window !== "undefined" ? window : globalThis);
