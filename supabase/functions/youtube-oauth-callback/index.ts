import {
  channelKeyFromOAuthState,
  channelKeyToBase64
} from "../_shared/channel-key.ts";
import { redirectToOauthDone, utf8HtmlResponse } from "../_shared/oauth-callback-html.ts";
import { oauthCallbackRedirectUri } from "../_shared/oauth-redirect.ts";
import { asciiDetail, OAuthCodes, type PostPayload } from "../_shared/oauth-payload.ts";
import type { OAuthStatePayload } from "../_shared/oauth-state.ts";
import { verifyOAuthState } from "../_shared/oauth-state.ts";
import { listMyChannelIds, resolveChannelKeyToId } from "../_shared/youtube-resolve.ts";

function postPayload(
  state: OAuthStatePayload,
  partial: Pick<PostPayload, "ok" | "channelId" | "code" | "detail">
): PostPayload {
  const channelKey = channelKeyFromOAuthState(state);
  return {
    type: "WAVRICK_YT_OAUTH",
    channelKeyB64: channelKey ? channelKeyToBase64(channelKey) : state.channel_key_b64 || "",
    ...partial
  };
}

function reply(targetOrigin: string, data: PostPayload): Response {
  return redirectToOauthDone(targetOrigin, data);
}

Deno.serve(async (req) => {
  if (req.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const url = new URL(req.url);
  const oauthErr = url.searchParams.get("error");
  let oauthErrDesc = url.searchParams.get("error_description") || "";
  try {
    oauthErrDesc = decodeURIComponent(oauthErrDesc.replace(/\+/g, " "));
  } catch {
    /* keep raw */
  }

  const stateSecret = Deno.env.get("YOUTUBE_OAUTH_STATE_SECRET");
  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
  if (!stateSecret || !clientId || !clientSecret) {
    return new Response("Missing function secrets.", { status: 500 });
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (oauthErr) {
    const parsed = state ? await verifyOAuthState(state, stateSecret, 120_000) : null;
    if (!parsed) {
      const safe = oauthErr.replace(/</g, "&lt;");
      return utf8HtmlResponse(
        `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/></head><body><p>Auth error: ${safe}</p><p>You may close this window.</p></body></html>`
      );
    }
    return reply(
      parsed.parent_origin,
      postPayload(parsed, {
        ok: false,
        channelId: "",
        code: OAuthCodes.CANCELLED,
        detail: asciiDetail(`${oauthErr} ${oauthErrDesc}`)
      })
    );
  }

  if (!code || !state) {
    return new Response("Missing code or state.", { status: 400 });
  }

  const payload = await verifyOAuthState(state, stateSecret, 120_000);
  if (!payload) {
    return new Response("Invalid or expired state.", { status: 400 });
  }

  const channelKey = channelKeyFromOAuthState(payload);
  if (!channelKey) {
    return new Response("Invalid channel in state.", { status: 400 });
  }

  const redirectUri = oauthCallbackRedirectUri(req);
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code"
    })
  });
  const tokenJson = await tokenRes.json();
  if (!tokenRes.ok) {
    return reply(
      payload.parent_origin,
      postPayload(payload, {
        ok: false,
        channelId: "",
        code: OAuthCodes.TOKEN_FAILED,
        detail: asciiDetail(
          typeof tokenJson?.error === "string" ? tokenJson.error : JSON.stringify(tokenJson)
        )
      })
    );
  }

  const accessToken = tokenJson.access_token as string | undefined;
  if (!accessToken) {
    return reply(
      payload.parent_origin,
      postPayload(payload, {
        ok: false,
        channelId: "",
        code: OAuthCodes.NO_ACCESS_TOKEN,
        detail: ""
      })
    );
  }

  const resolved = await resolveChannelKeyToId(channelKey, accessToken);
  if (!resolved.ok) {
    return reply(
      payload.parent_origin,
      postPayload(payload, {
        ok: false,
        channelId: "",
        code: OAuthCodes.CHANNEL_RESOLVE_FAILED,
        detail: ""
      })
    );
  }

  const mine = await listMyChannelIds(accessToken);
  const mineSet = new Set(mine.map((x) => x.toLowerCase()));
  if (!mineSet.has(resolved.channelId.toLowerCase())) {
    return reply(
      payload.parent_origin,
      postPayload(payload, {
        ok: false,
        channelId: resolved.channelId,
        code: OAuthCodes.CHANNEL_MISMATCH,
        detail: ""
      })
    );
  }

  return reply(
    payload.parent_origin,
    postPayload(payload, {
      ok: true,
      channelId: resolved.channelId,
      code: OAuthCodes.OK,
      detail: ""
    })
  );
});
