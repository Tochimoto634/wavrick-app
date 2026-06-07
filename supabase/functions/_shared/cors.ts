/**
 * Browser CORS for Supabase Edge Functions.
 * Set WAVRICK_CORS_ORIGIN (comma-separated) e.g. https://wavrick.com,http://127.0.0.1:8889
 */
const LOCAL_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;

function parseAllowedOrigins(): string[] {
  const raw = (Deno.env.get("WAVRICK_CORS_ORIGIN") || "").trim();
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/** Reflect request Origin when it is on the allowlist (or local dev without env). */
export function resolveCorsOrigin(request?: Request): string {
  const allowed = parseAllowedOrigins();
  const reqOrigin = request?.headers.get("Origin")?.trim() || "";

  if (allowed.length === 1 && allowed[0] === "*") return "*";
  if (reqOrigin && allowed.includes(reqOrigin)) return reqOrigin;
  if (allowed.length === 1) return allowed[0];
  if (allowed.length > 1 && reqOrigin && allowed.includes(reqOrigin)) return reqOrigin;

  if (!allowed.length && reqOrigin && LOCAL_ORIGIN_RE.test(reqOrigin)) {
    return reqOrigin;
  }

  return "";
}

export function corsHeadersForRequest(request?: Request): Record<string, string> {
  const origin = resolveCorsOrigin(request);
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
  if (origin) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}
