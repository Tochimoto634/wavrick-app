import type { PostPayload } from "./oauth-payload.ts";

function postPayloadToBase64Url(data: PostPayload): string {
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  const b64 = btoa(bin);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** ローカル依頼フォーム（parent_origin）上の完了ページ URL（ASCII のみ） */
export function oauthDonePageUrl(targetOrigin: string, data: PostPayload): string {
  const base = targetOrigin.replace(/\/$/, "");
  const token = postPayloadToBase64Url(data);
  return `${base}/oauth-done.html?r=${encodeURIComponent(token)}`;
}

/** Supabase コールバック → 8889/oauth-done.html へ即リダイレクト（中間 HTML なし） */
export function redirectToOauthDone(targetOrigin: string, data: PostPayload): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: oauthDonePageUrl(targetOrigin, data),
      "Cache-Control": "no-store"
    }
  });
}

export function utf8HtmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Disposition": "inline",
      "X-Content-Type-Options": "nosniff"
    }
  });
}
