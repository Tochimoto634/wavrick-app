/** channel_key の % エンコードずれを直す（@パワフル日本 など） */
export function decodePercentRepeated(raw: string): string {
  let s = raw.trim();
  for (let i = 0; i < 3; i++) {
    if (!/%[0-9A-Fa-f]{2}/.test(s)) break;
    try {
      const next = decodeURIComponent(s.replace(/\+/g, " "));
      if (next === s) break;
      s = next;
    } catch {
      break;
    }
  }
  return s;
}

export function channelKeyToBase64(channelKey: string): string {
  const bytes = new TextEncoder().encode(channelKey.trim());
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

export function channelKeyFromBase64(b64: string): string {
  const std = b64.replace(/-/g, "+").replace(/_/g, "/");
  const pad = std + "=".repeat((4 - (std.length % 4)) % 4);
  const bin = atob(pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i) & 0xff;
  return new TextDecoder().decode(bytes).trim();
}

export function readChannelKeyFromRequest(url: URL): string {
  const b64 = url.searchParams.get("channel_key_b64");
  if (b64) {
    try {
      return channelKeyFromBase64(b64);
    } catch {
      /* legacy param */
    }
  }
  return decodePercentRepeated(url.searchParams.get("channel_key") || "");
}

/** OAuth state（channel_key 文字列 or channel_key_b64）から復元 */
export function channelKeyFromOAuthState(payload: {
  channel_key_b64?: string;
  channel_key?: string;
}): string {
  if (payload.channel_key_b64) {
    try {
      return channelKeyFromBase64(payload.channel_key_b64);
    } catch {
      /* fall through */
    }
  }
  return decodePercentRepeated(payload.channel_key || "");
}

export function channelKeysMatch(a: string, b: string): boolean {
  return decodePercentRepeated(a).toLowerCase() === decodePercentRepeated(b).toLowerCase();
}
