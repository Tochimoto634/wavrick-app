import { channelKeyToBase64, readChannelKeyFromRequest } from "../_shared/channel-key.ts";
import { oauthCallbackRedirectUri } from "../_shared/oauth-redirect.ts";
import { signOAuthState } from "../_shared/oauth-state.ts";

const SCOPES = "https://www.googleapis.com/auth/youtube.readonly";

/** origin のみ、または /wavrick のようなサブパス付きベース URL */
function validateParentOrigin(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const u = new URL(trimmed);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    let path = u.pathname.replace(/\/+$/, "");
    if (!path || path === "/") return u.origin;
    return `${u.origin}${path}`;
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const stateSecret = Deno.env.get("YOUTUBE_OAUTH_STATE_SECRET");
  if (!clientId || !stateSecret) {
    return new Response(
      "Missing GOOGLE_CLIENT_ID or YOUTUBE_OAUTH_STATE_SECRET. Set Supabase function secrets.",
      { status: 500 }
    );
  }

  const url = new URL(req.url);
  const channelKey = readChannelKeyFromRequest(url);
  const parentOrigin = validateParentOrigin(url.searchParams.get("parent_origin") || "");
  if (!channelKey) {
    return new Response("Query channel_key is required.", { status: 400 });
  }
  if (!parentOrigin) {
    return new Response(
      "Query parent_origin must be a valid http(s) URL (origin or app base path).",
      { status: 400 }
    );
  }

  const exp = Date.now() + 15 * 60 * 1000;
  const state = await signOAuthState(
    {
      channel_key_b64: channelKeyToBase64(channelKey),
      parent_origin: parentOrigin,
      exp
    },
    stateSecret
  );

  const redirectUri = oauthCallbackRedirectUri(req);
  const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  auth.searchParams.set("client_id", clientId);
  auth.searchParams.set("redirect_uri", redirectUri);
  auth.searchParams.set("response_type", "code");
  auth.searchParams.set("scope", SCOPES);
  auth.searchParams.set("access_type", "online");
  auth.searchParams.set("prompt", "select_account");
  auth.searchParams.set("include_granted_scopes", "true");
  auth.searchParams.set("state", state);

  return Response.redirect(auth.toString(), 302);
});
