/** Google OAuth 用 callback URL（プロキシ経由で url.origin が http になるのを防ぐ） */
export function oauthCallbackRedirectUri(req: Request): string {
  const fromEnv = Deno.env.get("SUPABASE_URL")?.replace(/\/+$/, "");
  if (fromEnv) {
    return `${fromEnv}/functions/v1/youtube-oauth-callback`;
  }
  const url = new URL(req.url);
  const host = url.hostname;
  const origin =
    url.protocol === "https:" || !host.endsWith(".supabase.co")
      ? url.origin
      : `https://${host}`;
  return `${origin}/functions/v1/youtube-oauth-callback`;
}
