#!/usr/bin/env node
/**
 * Keep in sync with supabase/functions/_shared/youtube-proxy-timeout.ts
 * Run: node scripts/test-youtube-proxy-timeout.mjs
 */

import assert from "node:assert/strict";

const PROXY_EXTRACT_TIMEOUT_MS = 250_000;

function isAbortTimeoutError(err) {
  if (err == null) return false;
  const name = String(err.name || "");
  const msg = String(err.message || (typeof err === "string" ? err : ""));
  if (name === "TimeoutError" || name === "AbortError") return true;
  return /timed\s*out|timeout|aborted/i.test(`${name} ${msg}`);
}

function proxyTimeoutUserMessage(timeoutMs = PROXY_EXTRACT_TIMEOUT_MS) {
  const sec = Math.round(timeoutMs / 1000);
  return (
    `音声プロキシがタイムアウトしました（${sec}秒）。` +
    `混雑しているか、動画の取得に時間がかかっています。` +
    `少し待って再試行するか、音声ファイルをアップロードしてください。`
  );
}

function retryAfterMs(res, fallbackSec = 8) {
  const raw = String(res.headers?.get?.("Retry-After") || "").trim();
  if (/^\d+$/.test(raw)) {
    return Math.min(30_000, Math.max(2_000, Number(raw) * 1000));
  }
  return fallbackSec * 1000;
}

async function fetchYoutubeProxy(proxyUrl, init, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? PROXY_EXTRACT_TIMEOUT_MS;
  const busyRetryMs = opts.busyRetryMs ?? 90_000;
  const fetchImpl = opts.fetchImpl;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const busyDeadline = now() + busyRetryMs;
  let lastBusy = "";

  while (true) {
    let r;
    try {
      r = await fetchImpl(proxyUrl, { ...init, signal: { timeoutMs } });
    } catch (e) {
      if (isAbortTimeoutError(e)) {
        throw new Error(proxyTimeoutUserMessage(timeoutMs));
      }
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`音声プロキシへの接続に失敗しました: ${msg}`);
    }
    if (r.status === 503) {
      let code = "";
      let error = "";
      try {
        const j = await r.clone().json();
        code = String(j?.errorCode || "").trim();
        error = String(j?.error || "").trim();
      } catch {
        /* ignore */
      }
      if (code === "BUSY" || !code) {
        lastBusy = error || lastBusy;
        const waitMs = retryAfterMs(r);
        if (now() + waitMs <= busyDeadline) {
          await sleep(waitMs);
          continue;
        }
        throw new Error(`[BUSY] ${lastBusy || "混雑"}`);
      }
    }
    return r;
  }
}

assert.equal(isAbortTimeoutError({ name: "TimeoutError", message: "Signal timed out." }), true);
assert.equal(isAbortTimeoutError({ name: "AbortError", message: "The signal has been aborted" }), true);
assert.equal(isAbortTimeoutError(new Error("Signal timed out.")), true);
assert.equal(isAbortTimeoutError(new Error("The operation was aborted")), true);
assert.equal(isAbortTimeoutError(new Error("connection refused")), false);
assert.equal(/timeout/i.test("Signal timed out."), false, "old regex must not match");
assert.match(proxyTimeoutUserMessage(250_000), /250秒/);
assert.equal(proxyTimeoutUserMessage(180_000).includes("Signal timed out"), false);

const headers = (retry) => ({
  get: (k) => (String(k).toLowerCase() === "retry-after" ? String(retry) : null)
});
assert.equal(retryAfterMs({ headers: headers("8") }), 8000);
assert.equal(retryAfterMs({ headers: headers("1") }), 2000);

let calls = 0;
const busyThenOk = async () => {
  calls += 1;
  if (calls === 1) {
    return {
      status: 503,
      headers: headers("2"),
      clone: () => ({
        json: async () => ({ errorCode: "BUSY", error: "混雑しています" })
      })
    };
  }
  return { status: 200, headers: headers(""), clone: () => ({ json: async () => ({}) }) };
};

const slept = [];
const r = await fetchYoutubeProxy(
  "https://example.test/extract",
  { method: "POST" },
  {
    fetchImpl: busyThenOk,
    sleep: async (ms) => {
      slept.push(ms);
    },
    now: (() => {
      let t = 0;
      return () => t;
    })(),
    busyRetryMs: 90_000
  }
);
assert.equal(r.status, 200);
assert.equal(calls, 2);
assert.deepEqual(slept, [2000]);

calls = 0;
await assert.rejects(
  () =>
    fetchYoutubeProxy(
      "https://example.test/extract",
      { method: "POST" },
      {
        timeoutMs: 250_000,
        fetchImpl: async () => {
          const err = new Error("Signal timed out.");
          err.name = "TimeoutError";
          throw err;
        }
      }
    ),
  (e) => {
    assert.match(String(e.message), /音声プロキシがタイムアウトしました（250秒）/);
    assert.equal(String(e.message).includes("接続に失敗"), false);
    assert.equal(String(e.message).includes("Signal timed out"), false);
    return true;
  }
);

console.log("test-youtube-proxy-timeout.mjs: ok");
