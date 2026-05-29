/**
 * WAVRICK — 声優実績・ペナルティ指標の自動算出
 *
 * 取引ワークフロー（request_workflows_public）から声優ごとの
 * パフォーマンス指標を集計し、プロフィール画面に表示するための
 * データを提供する。
 */
(function initWavrickTalentStats(global) {
  const STANDARD_DEADLINE_MS = 72 * 60 * 60 * 1000;
  const SPEED_THRESHOLD_MS = 24 * 60 * 60 * 1000;
  const SPEED_BADGE_MIN_RATE = 0.8;
  const REVISION_RESPONSE_THRESHOLD_MS = 8 * 60 * 60 * 1000;
  const RESPONSE_BADGE_MIN_SCORE = 0.75;
  const RESPONSE_BADGE_MIN_PAIRS = 2;

  function computeAllTalentStats(workflows) {
    const statsMap = new Map();

    for (const wf of Object.values(workflows)) {
      const slots = wf.castAcceptance || wf.cast_acceptance || [];
      const deliveries = wf.deliveries || [];
      const messages = wf.messages || [];
      const ratings = wf.ratings || [];
      const phase = wf.transactionPhase || wf.transaction_phase || "draft";

      for (const slot of slots) {
        const tid = slot.talentId;
        if (!tid) continue;

        if (!statsMap.has(tid)) {
          statsMap.set(tid, {
            totalOffered: 0,
            totalDeclined: 0,
            totalAccepted: 0,
            totalDelivered: 0,
            speedDeliveries: 0,
            lateDeliveries: 0,
            abandoned: 0,
            revisionResponseFast: 0,
            revisionResponseTotal: 0,
            deliveryTimeSum: 0,
            deliveryTimeCount: 0,
            revisionResponseTimeSum: 0,
            ratingSum: 0,
            ratingCount: 0
          });
        }
        const s = statsMap.get(tid);

        if (slot.status === "pending_match") continue;

        s.totalOffered++;

        if (slot.status === "declined") {
          s.totalDeclined++;
          continue;
        }

        if (slot.status === "accepted") {
          s.totalAccepted++;

          const deliveryEntry = findDeliveryForSlot(slot, deliveries);

          if (deliveryEntry) {
            s.totalDelivered++;

            const acceptedAt = slot.respondedAt ? new Date(slot.respondedAt).getTime() : 0;
            const deliveredAt = deliveryEntry.createdAt ? new Date(deliveryEntry.createdAt).getTime() : 0;

            if (acceptedAt && deliveredAt) {
              const elapsed = deliveredAt - acceptedAt;
              if (elapsed > 0) {
                s.deliveryTimeSum += elapsed;
                s.deliveryTimeCount++;
              }
              if (elapsed <= SPEED_THRESHOLD_MS) {
                s.speedDeliveries++;
              }
              if (elapsed > STANDARD_DEADLINE_MS) {
                s.lateDeliveries++;
              }
            }
          } else if (phase === "cancelled") {
            s.abandoned++;
          }

          const voiceName = (slot.displayName || "").trim();
          if (voiceName && messages.length > 0 && deliveries.length > 0) {
            const resp = computeRevisionResponseSpeed(messages, deliveries, voiceName);
            s.revisionResponseFast += resp.fast;
            s.revisionResponseTotal += resp.total;
            s.revisionResponseTimeSum += resp.elapsedSum;
          }

          for (const r of ratings) {
            if (r.talentId === tid || (!r.talentId && slots.length === 1)) {
              s.ratingSum += Number(r.score) || 0;
              s.ratingCount++;
            }
          }
        }
      }
    }

    return statsMap;
  }

  /**
   * 修正依頼（kind:"revision"）→ 次の納品（deliveries）のペアを検出し、
   * 8時間以内に提出された件数と合計経過時間を返す。
   */
  function computeRevisionResponseSpeed(messages, deliveries, voiceName) {
    const revisions = messages
      .filter((m) => m.kind === "revision" && (m.sender || "").trim() !== voiceName && m.createdAt)
      .map((m) => new Date(m.createdAt).getTime())
      .filter((t) => t > 0)
      .sort((a, b) => a - b);

    const sortedDeliveries = deliveries
      .filter((d) => d.createdAt)
      .map((d) => new Date(d.createdAt).getTime())
      .filter((t) => t > 0)
      .sort((a, b) => a - b);

    let fast = 0;
    let total = 0;
    let elapsedSum = 0;
    let delivIdx = 0;

    for (const revAt of revisions) {
      while (delivIdx < sortedDeliveries.length && sortedDeliveries[delivIdx] <= revAt) {
        delivIdx++;
      }
      if (delivIdx >= sortedDeliveries.length) break;

      const elapsed = sortedDeliveries[delivIdx] - revAt;
      total++;
      elapsedSum += elapsed;
      if (elapsed <= REVISION_RESPONSE_THRESHOLD_MS) {
        fast++;
      }
      delivIdx++;
    }

    return { fast, total, elapsedSum };
  }

  function findDeliveryForSlot(slot, deliveries) {
    if (!deliveries.length) return null;

    const tid = slot.talentId || "";
    const email = tid.startsWith("voice:") ? tid.slice(6) : "";
    const displayName = (slot.displayName || "").trim();

    for (const d of deliveries) {
      if (d.submitterEmail && email && d.submitterEmail.toLowerCase() === email.toLowerCase()) {
        return d;
      }
    }
    for (const d of deliveries) {
      if (displayName && d.submittedBy && d.submittedBy.trim() === displayName) {
        return d;
      }
    }

    if (deliveries.length > 0) {
      return deliveries[0];
    }
    return null;
  }

  function formatStats(raw) {
    if (!raw || raw.totalOffered === 0) {
      return {
        hasData: false,
        totalOrders: 0,
        speedDeliveryRate: 0,
        speedBadge: false,
        speedResponseRate: 0,
        speedResponseBadge: false,
        declineRate: 0,
        lateDeliveryRate: 0,
        abandonRate: 0,
        avgRating: 0,
        ratingCount: 0,
        avgDeliveryMs: null,
        avgRevisionResponseMs: null
      };
    }

    const totalOrders = raw.totalOffered;
    const speedRate = raw.totalDelivered > 0 ? raw.speedDeliveries / raw.totalDelivered : 0;
    const declineRate = raw.totalOffered > 0 ? raw.totalDeclined / raw.totalOffered : 0;
    const lateRate = raw.totalDelivered > 0 ? raw.lateDeliveries / raw.totalDelivered : 0;
    const abandonRate = raw.totalAccepted > 0 ? raw.abandoned / raw.totalAccepted : 0;
    const responseRate = raw.revisionResponseTotal > 0
      ? raw.revisionResponseFast / raw.revisionResponseTotal
      : 0;
    const avgRating = raw.ratingCount > 0
      ? Math.round((raw.ratingSum / raw.ratingCount) * 2) / 2
      : 0;
    const avgDeliveryMs = raw.deliveryTimeCount > 0
      ? raw.deliveryTimeSum / raw.deliveryTimeCount
      : null;
    const avgRevisionResponseMs = raw.revisionResponseTotal > 0
      ? raw.revisionResponseTimeSum / raw.revisionResponseTotal
      : null;

    return {
      hasData: true,
      totalOrders,
      speedDeliveryRate: speedRate,
      speedBadge: speedRate >= SPEED_BADGE_MIN_RATE && raw.totalDelivered >= 1,
      speedResponseRate: responseRate,
      speedResponseBadge: responseRate >= RESPONSE_BADGE_MIN_SCORE
        && raw.revisionResponseTotal >= RESPONSE_BADGE_MIN_PAIRS,
      declineRate,
      lateDeliveryRate: lateRate,
      abandonRate,
      avgRating,
      ratingCount: raw.ratingCount,
      avgDeliveryMs,
      avgRevisionResponseMs
    };
  }

  function pct(rate) {
    return Math.round(rate * 100) + "%";
  }

  /**
   * 0.5刻みの星評価HTMLを返す。
   * @param {number} rating  0〜5 (0.5刻み)
   * @param {number} count   レビュー件数
   * @param {string} size    "sm" | "md"
   */
  function renderStarRatingHtml(rating, count, size = "sm") {
    if (!count || count === 0) return "";

    const clamped = Math.max(0, Math.min(5, rating));
    let stars = "";
    for (let i = 1; i <= 5; i++) {
      if (clamped >= i) {
        stars += `<span class="star star--full">★</span>`;
      } else if (clamped >= i - 0.5) {
        stars += `<span class="star star--half">★</span>`;
      } else {
        stars += `<span class="star star--empty">★</span>`;
      }
    }

    return `<div class="talent-rating talent-rating--${size}">
      <span class="talent-rating-stars">${stars}</span>
      <span class="talent-rating-score">${clamped.toFixed(1)}</span>
      <span class="talent-rating-count">(${count}件)</span>
    </div>`;
  }

  function renderCardStatsHtml(stats) {
    if (!stats || !stats.hasData) return "";

    const items = [];

    if (stats.speedBadge) {
      items.push(`<span class="talent-stat-badge talent-stat-speed" title="過去の取引のうち${pct(stats.speedDeliveryRate)}を24時間以内に納品">⚡ スピード納品</span>`);
    }

    if (stats.speedResponseBadge) {
      items.push(`<span class="talent-stat-badge talent-stat-response" title="修正依頼の${pct(stats.speedResponseRate)}を8時間以内に提出">💬 スピード対応</span>`);
    }

    if (stats.abandonRate > 0) {
      items.push(`<span class="talent-stat-badge talent-stat-danger" title="仕事を飛ぶ率: ${pct(stats.abandonRate)}">⚠ 要注意</span>`);
    } else if (stats.lateDeliveryRate === 0 && stats.declineRate === 0 && stats.totalOrders >= 1) {
      items.push(`<span class="talent-stat-badge talent-stat-clean" title="遅延・辞退・バックれ 0%">✓ 優良声優</span>`);
    }

    if (!items.length) return "";
    return `<div class="talent-stat-badges">${items.join("")}</div>`;
  }

  function renderDetailedStatsHtml(stats) {
    if (!stats || !stats.hasData) {
      return `<div class="talent-stats-panel"><p class="talent-stats-empty">取引実績はまだありません。</p></div>`;
    }

    const rows = [];

    const highlights = [];
    if (stats.speedBadge) {
      highlights.push(`
        <div class="talent-stats-highlight talent-stats-highlight--speed">
          <span class="talent-stats-highlight-icon">⚡</span>
          <span class="talent-stats-highlight-text">24時間以内の納品が多い声優です</span>
          <span class="talent-stats-highlight-rate">${pct(stats.speedDeliveryRate)}</span>
        </div>`);
    }
    if (stats.speedResponseBadge) {
      highlights.push(`
        <div class="talent-stats-highlight talent-stats-highlight--response">
          <span class="talent-stats-highlight-icon">💬</span>
          <span class="talent-stats-highlight-text">修正依頼への対応が早い声優です</span>
          <span class="talent-stats-highlight-rate">${pct(stats.speedResponseRate)}</span>
        </div>`);
    }

    rows.push(renderStatRow(
      "案件を受けない割合",
      stats.declineRate,
      stats.declineRate === 0 ? "clean" : stats.declineRate >= 0.3 ? "warn" : "neutral"
    ));

    rows.push(renderStatRow(
      "納期遅延率",
      stats.lateDeliveryRate,
      stats.lateDeliveryRate === 0 ? "clean" : stats.lateDeliveryRate >= 0.2 ? "warn" : "neutral"
    ));

    rows.push(renderStatRow(
      "仕事を飛ぶ率",
      stats.abandonRate,
      stats.abandonRate === 0 ? "clean" : "danger"
    ));

    const ratingHtml = stats.ratingCount > 0
      ? `<div class="talent-stats-rating-row">${renderStarRatingHtml(stats.avgRating, stats.ratingCount, "md")}</div>`
      : "";

    return `
      <div class="talent-stats-panel">
        <h4 class="talent-stats-title">実績・信頼指標</h4>
        <p class="talent-stats-orders">過去の取引件数: ${stats.totalOrders}件</p>
        ${ratingHtml}
        ${highlights.join("")}
        ${rows.join("")}
      </div>`;
  }

  function renderStatRow(label, rate, level) {
    const rateText = pct(rate);
    return `
      <div class="talent-stat-row talent-stat-row--${level}">
        <span class="talent-stat-label">${label}</span>
        <span class="talent-stat-value">${rateText}</span>
        <div class="talent-stat-bar">
          <div class="talent-stat-bar-fill talent-stat-bar-fill--${level}" style="width:${Math.min(rate * 100, 100)}%"></div>
        </div>
      </div>`;
  }

  function loadWorkflowsForStats() {
    try {
      return JSON.parse(localStorage.getItem("wavrick_request_workflows") || "{}");
    } catch {
      return {};
    }
  }

  let cachedStatsMap = null;
  let cacheTimestamp = 0;
  const CACHE_TTL_MS = 30000;

  function getAllTalentStats() {
    const now = Date.now();
    if (cachedStatsMap && now - cacheTimestamp < CACHE_TTL_MS) {
      return cachedStatsMap;
    }
    const workflows = loadWorkflowsForStats();
    const rawMap = computeAllTalentStats(workflows);
    const result = new Map();
    for (const [tid, raw] of rawMap) {
      result.set(tid, formatStats(raw));
    }
    cachedStatsMap = result;
    cacheTimestamp = now;
    return result;
  }

  function getTalentStats(talentId) {
    const all = getAllTalentStats();
    return all.get(talentId) || formatStats(null);
  }

  function invalidateCache() {
    cachedStatsMap = null;
    cacheTimestamp = 0;
  }

  global.WavrickTalentStats = {
    STANDARD_DEADLINE_MS,
    SPEED_THRESHOLD_MS,
    SPEED_BADGE_MIN_RATE,
    REVISION_RESPONSE_THRESHOLD_MS,
    RESPONSE_BADGE_MIN_SCORE,
    computeAllTalentStats,
    computeStatsForTalent: function (talentId, workflows) {
      const all = computeAllTalentStats(workflows);
      return formatStats(all.get(talentId));
    },
    formatStats,
    getAllTalentStats,
    getTalentStats,
    invalidateCache,
    renderCardStatsHtml,
    renderDetailedStatsHtml,
    renderStarRatingHtml,
    pct
  };
})(typeof window !== "undefined" ? window : globalThis);
