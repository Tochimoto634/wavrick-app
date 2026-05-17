import { decodePercentRepeated } from "./channel-key.ts";

export async function resolveChannelKeyToId(
  channelKey: string,
  accessToken: string
): Promise<{ ok: true; channelId: string } | { ok: false; error: string }> {
  const k = decodePercentRepeated(channelKey);
  if (k.startsWith("channel:")) {
    const id = k.slice("channel:".length).trim();
    if (!/^UC[\w-]{10,}$/i.test(id)) {
      return { ok: false, error: "チャンネルIDの形式が不正です。" };
    }
    return { ok: true, channelId: id };
  }
  if (k.startsWith("handle:")) {
    const handle = k.slice("handle:".length).trim().replace(/^@/, "");
    if (!handle) return { ok: false, error: "ハンドルが空です。" };
    const url = `https://www.googleapis.com/youtube/v3/channels?part=id&forHandle=${encodeURIComponent(handle)}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    const j = await r.json();
    const id = j?.items?.[0]?.id;
    if (!id) return { ok: false, error: "ハンドルに一致するチャンネルが見つかりません。" };
    return { ok: true, channelId: id };
  }
  if (k.startsWith("user:") || k.startsWith("custom:")) {
    const slug = (k.split(":")[1] || "").trim();
    if (!slug) return { ok: false, error: "URLからチャンネルを特定できません。" };
    const url = `https://www.googleapis.com/youtube/v3/channels?part=id&forHandle=${encodeURIComponent(slug)}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    const j = await r.json();
    const id = j?.items?.[0]?.id;
    if (!id) {
      return {
        ok: false,
        error:
          "このURL形式は自動解決できませんでした。@ハンドル（例: youtube.com/@name）または /channel/UC... を使ってください。"
      };
    }
    return { ok: true, channelId: id };
  }
  return { ok: false, error: "未対応のチャンネルURL形式です。" };
}

export async function listMyChannelIds(accessToken: string): Promise<string[]> {
  const out: string[] = [];
  let pageToken = "";
  for (let i = 0; i < 6; i++) {
    const url = new URL("https://www.googleapis.com/youtube/v3/channels");
    url.searchParams.set("part", "id");
    url.searchParams.set("mine", "true");
    url.searchParams.set("maxResults", "50");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    const j = await r.json();
    const items = j?.items;
    if (!Array.isArray(items)) break;
    for (const it of items) {
      if (it?.id) out.push(String(it.id));
    }
    pageToken = j?.nextPageToken || "";
    if (!pageToken) break;
  }
  return out;
}
