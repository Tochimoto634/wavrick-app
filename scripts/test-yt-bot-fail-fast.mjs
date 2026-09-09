#!/usr/bin/env node
/**
 * Mirrors youtube-audio-proxy bot fail-fast helpers.
 * Run: node scripts/test-yt-bot-fail-fast.mjs
 */
import assert from "node:assert/strict";

function isYtRateLimitError(msg) {
  const m = String(msg || "").toLowerCase();
  return /rate.?limit|too many requests|try again later/.test(m);
}

function isBotOrBlockError(detail) {
  const msg = String(detail || "").toLowerCase();
  if (isYtRateLimitError(detail)) return true;
  return [
    "sign in to confirm",
    "not a bot",
    "http error 403",
    "forbidden",
    "ボット判定",
  ].some((t) => msg.includes(t));
}

function isFormatOrChallengeError(exc) {
  if (isBotOrBlockError(String(exc))) return false;
  const msg = String(exc || "").toLowerCase();
  return [
    "no video formats found",
    "requested format is not available",
    "page needs to be reloaded",
    "no formats are available",
  ].some((t) => msg.includes(t));
}

const bot = "ERROR: [youtube] x: Sign in to confirm you’re not a bot";
assert.equal(isBotOrBlockError(bot), true);
assert.equal(isFormatOrChallengeError(bot), false, "bot must NOT be treated as retryable format challenge");

const fmt = "ERROR: [youtube] x: Requested format is not available";
assert.equal(isBotOrBlockError(fmt), false);
assert.equal(isFormatOrChallengeError(fmt), true);

const reload = "The page needs to be reloaded.";
assert.equal(isFormatOrChallengeError(reload), true);
assert.equal(isBotOrBlockError(reload), false);

// Edge: YT_EXTRACT_BLOCKED is never retryable
function edgeRetryable(code, msg) {
  return (
    code !== "YT_EXTRACT_BLOCKED" &&
    (code === "RATE_LIMIT" || code === "BUSY" || /page needs to be reloaded|fetch_failed|502/.test(msg))
  );
}
assert.equal(edgeRetryable("YT_EXTRACT_BLOCKED", "bot"), false);
assert.equal(edgeRetryable("BUSY", "[BUSY] wait"), true);
assert.equal(edgeRetryable("FETCH_FAILED", "page needs to be reloaded"), true);

console.log("test-yt-bot-fail-fast: ok");
