/** postMessage 用（ASCII のみ → 文字化けしない） */
export type PostPayload = {
  type: "WAVRICK_YT_OAUTH";
  ok: boolean;
  channelKeyB64: string;
  channelId: string;
  /** 親画面 app.js が日本語に変換するコード */
  code: string;
  /** 補足（英数字のみ。Google エラー等） */
  detail: string;
};

export const OAuthCodes = {
  OK: "OK",
  CANCELLED: "CANCELLED",
  TOKEN_FAILED: "TOKEN_FAILED",
  NO_ACCESS_TOKEN: "NO_ACCESS_TOKEN",
  CHANNEL_RESOLVE_FAILED: "CHANNEL_RESOLVE_FAILED",
  CHANNEL_MISMATCH: "CHANNEL_MISMATCH"
} as const;

export function asciiDetail(raw: string): string {
  return raw.replace(/[^\x20-\x7E]/g, " ").replace(/\s+/g, " ").trim().slice(0, 240);
}
