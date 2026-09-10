/**
 * YouTube audio proxy fetch: never leak Deno's "Signal timed out."
 *
 * Time budget (keep these aligned):
 * - Railway gunicorn --timeout = 240s (start-railway.sh)
 * - Edge AbortSignal = 250s (this file) so gunicorn can fail the HTTP
 *   request before Deno aborts the TCP wait
 * - Proxy semaphore wait = ~2s then 503 BUSY (extract_slot.py)
 * - BUSY retries here wait on Retry-After instead of blocking a sync worker
 */

export const PROXY_EXTRACT_TIMEOUT_MS = 250_000;
export const PROXY_META_TIMEOUT_MS = 60_000;
export const PROXY_BUSY_RETRY_MS = 90_000;

export function isAbortTimeoutError(err: unknown): boolean {
  if (err == null) return false;
  const e = err as { name?: string; message?: string };
  const name = String(e.name || "");
  const msg = String(e.message || (typeof err === "string" ? err : ""));
  if (name === "TimeoutError" || name === "AbortError") return true;
  return /timed\s*out|timeout|aborted/i.test(`${name} ${msg}`);
}

export function proxyTimeoutUserMessage(timeoutMs = PROXY_EXTRACT_TIMEOUT_MS): string {
  const sec = Math.round(timeoutMs / 1000);
  return (
    `音声プロキシがタイムアウトしました（${sec}秒）。` +
    `混雑しているか、動画の取得に時間がかかっています。` +
    `少し待って再試行してください（取得済みトラックはキャッシュされ、再試行時は YouTube 接触が減ります）。` +
    `急ぐ場合は音声ファイルをアップロードしてください。`
  );
}

export function proxyBusyUserMessage(detail?: string): string {
  const extra = String(detail || "").trim();
  return extra
    ? `[BUSY] ${extra}`
    : "[BUSY] YouTube 音声取得が混雑しています。しばらく待ってから再試行してください。";
}

function retryAfterMs(res: Response, fallbackSec = 8): number {
  const raw = (res.headers.get("Retry-After") || "").trim();
  if (/^\d+$/.test(raw)) {
    return Math.min(30_000, Math.max(2_000, Number(raw) * 1000));
  }
  return fallbackSec * 1000;
}

async function busyDetail(res: Response): Promise<{ code: string; error: string }> {
  try {
    const j = (await res.clone().json()) as { errorCode?: string; error?: string };
    return {
      code: String(j?.errorCode || "").trim(),
      error: String(j?.error || "").trim()
    };
  } catch {
    return { code: "", error: "" };
  }
}

export type YoutubeProxyFetchOpts = {
  timeoutMs?: number;
  busyRetryMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export async function fetchYoutubeProxy(
  proxyUrl: string,
  init: RequestInit,
  opts?: YoutubeProxyFetchOpts
): Promise<Response> {
  const timeoutMs = opts?.timeoutMs ?? PROXY_EXTRACT_TIMEOUT_MS;
  const busyRetryMs = opts?.busyRetryMs ?? PROXY_BUSY_RETRY_MS;
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const sleep =
    opts?.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = opts?.now ?? Date.now;
  const busyDeadline = now() + busyRetryMs;
  let lastBusy = "";

  while (true) {
    let r: Response;
    try {
      r = await fetchImpl(proxyUrl, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (e) {
      if (isAbortTimeoutError(e)) {
        throw new Error(proxyTimeoutUserMessage(timeoutMs));
      }
      const msg = e instanceof Error ? e.message : String(e);
      if (/dns|lookup|trycloudflare|Name or service not known/i.test(msg)) {
        throw new Error(
          "YouTube音声プロキシに接続できません。YOUTUBE_AUDIO_PROXY_URL が正しくありません。"
        );
      }
      throw new Error(`音声プロキシへの接続に失敗しました: ${msg}`);
    }

    if (r.status === 503) {
      const detail = await busyDetail(r);
      if (detail.code === "BUSY" || !detail.code) {
        lastBusy = detail.error || lastBusy;
        const waitMs = retryAfterMs(r);
        if (now() + waitMs <= busyDeadline) {
          await sleep(waitMs);
          continue;
        }
        throw new Error(proxyBusyUserMessage(lastBusy));
      }
    }
    return r;
  }
}
