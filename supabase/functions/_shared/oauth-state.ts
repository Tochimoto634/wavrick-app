const enc = new TextEncoder();

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(s: string): Uint8Array {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xff;
  return out;
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

export type OAuthStatePayload = {
  /** ASCII のみ（UTF-8 文字化け防止） */
  channel_key_b64: string;
  /** 旧トークン互換（新規発行では使わない） */
  channel_key?: string;
  parent_origin: string;
  exp: number;
};

export async function signOAuthState(payload: OAuthStatePayload, secret: string): Promise<string> {
  const body = JSON.stringify(payload);
  const key = await importHmacKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
  return `${base64UrlEncode(enc.encode(body))}.${base64UrlEncode(sig)}`;
}

export async function verifyOAuthState(
  token: string,
  secret: string,
  graceMs: number
): Promise<OAuthStatePayload | null> {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  let bodyBytes: Uint8Array;
  let sigBytes: Uint8Array;
  try {
    bodyBytes = base64UrlDecode(parts[0]!);
    sigBytes = base64UrlDecode(parts[1]!);
  } catch {
    return null;
  }
  const body = new TextDecoder().decode(bodyBytes);
  const key = await importHmacKey(secret);
  const ok = await crypto.subtle.verify("HMAC", key, sigBytes, bodyBytes);
  if (!ok) return null;
  let parsed: OAuthStatePayload;
  try {
    parsed = JSON.parse(body) as OAuthStatePayload;
  } catch {
    return null;
  }
  if (
    (!parsed.channel_key_b64 && !parsed.channel_key) ||
    typeof parsed.parent_origin !== "string"
  ) {
    return null;
  }
  if (typeof parsed.exp !== "number" || Date.now() > parsed.exp + graceMs) return null;
  return parsed;
}
