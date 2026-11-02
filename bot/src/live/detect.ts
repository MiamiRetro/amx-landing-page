/**
 * Finding out whether a channel is streaming right now.
 *
 * YouTube: the channel's /live page points at the current broadcast and marks it
 * "isLiveNow":true while it runs (a scheduled stream has the same page with
 * false). No API key needed.
 * Twitch: the Helix streams endpoint, with an app token from TWITCH_CLIENT_ID and
 * TWITCH_CLIENT_SECRET (a free app at dev.twitch.tv).
 * X, TikTok and Kick give bots no way to see a live stream: those go out by /live now.
 */

export const PLATFORMS = ["youtube", "twitch"] as const;
export type WatchPlatform = (typeof PLATFORMS)[number];

export interface LiveNow { id: string; url: string; title: string }

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

/** The /live page for a handle (@name), a channel id (UC…) or a channel URL. */
export function youtubeLivePage(channel: string): string {
  const c = channel.trim().replace(/\/+$/, "").replace(/\/live$/, "");
  if (/^https?:\/\//.test(c)) return `${c}/live`;
  if (/^UC[\w-]{22}$/.test(c)) return `https://www.youtube.com/channel/${c}/live`;
  return `https://www.youtube.com/${c.startsWith("@") ? c : `@${c}`}/live`;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/** Reads a channel's /live page: the broadcast when one is on air, null otherwise. */
export function parseYoutubeLive(html: string): LiveNow | null {
  if (!/"isLiveNow":\s*true/.test(html)) return null;
  const id = html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})"/)?.[1]
    ?? html.match(/"videoDetails":\{"videoId":"([\w-]{11})"/)?.[1];
  if (!id) return null;
  const title = html.match(/<meta name="title" content="([^"]*)"/)?.[1] ?? html.match(/<meta property="og:title" content="([^"]*)"/)?.[1] ?? "";
  return { id, url: `https://www.youtube.com/watch?v=${id}`, title: decodeEntities(title) };
}

export async function youtubeLive(channel: string): Promise<LiveNow | null> {
  const res = await fetch(youtubeLivePage(channel), {
    headers: { "user-agent": UA, "accept-language": "en-US,en;q=0.9", cookie: "SOCS=CAI; CONSENT=YES+1" },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404) throw new Error(`YouTube channel not found: ${channel}`);
  if (!res.ok) throw new Error(`YouTube ${res.status}`);
  return parseYoutubeLive(await res.text());
}

/** The Twitch login from "name", "@name" or a twitch.tv URL. */
export function twitchLogin(channel: string): string {
  const c = channel.trim().replace(/\/+$/, "");
  return (c.match(/twitch\.tv\/([\w]+)/i)?.[1] ?? c.replace(/^@/, "")).toLowerCase();
}

let twitchToken: { token: string; expires: number } | null = null;

export function twitchConfigured() {
  return !!(process.env.TWITCH_CLIENT_ID && process.env.TWITCH_CLIENT_SECRET);
}

async function twitchAppToken(): Promise<string> {
  if (twitchToken && twitchToken.expires > Date.now() + 60_000) return twitchToken.token;
  const q = new URLSearchParams({ client_id: process.env.TWITCH_CLIENT_ID!, client_secret: process.env.TWITCH_CLIENT_SECRET!, grant_type: "client_credentials" });
  const res = await fetch(`https://id.twitch.tv/oauth2/token?${q}`, { method: "POST", signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Twitch token ${res.status}`);
  const j = (await res.json()) as { access_token: string; expires_in: number };
  twitchToken = { token: j.access_token, expires: Date.now() + j.expires_in * 1000 };
  return j.access_token;
}

export async function twitchLive(channel: string): Promise<LiveNow | null> {
  if (!twitchConfigured()) throw new Error("Twitch needs TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET");
  const login = twitchLogin(channel);
  const res = await fetch(`https://api.twitch.tv/helix/streams?user_login=${encodeURIComponent(login)}`, {
    headers: { "client-id": process.env.TWITCH_CLIENT_ID!, authorization: `Bearer ${await twitchAppToken()}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 401) twitchToken = null;
  if (!res.ok) throw new Error(`Twitch ${res.status}`);
  const s = ((await res.json()) as { data: { id: string; type: string; title: string }[] }).data[0];
  return s && s.type === "live" ? { id: s.id, url: `https://www.twitch.tv/${login}`, title: s.title } : null;
}

export function checkLive(platform: WatchPlatform, channel: string): Promise<LiveNow | null> {
  return platform === "youtube" ? youtubeLive(channel) : twitchLive(channel);
}

/** The platform's display name from a stream link, or "" when it isn't one we know. */
export function platformOf(url: string): string {
  const host = (() => { try { return new URL(url).hostname.replace(/^www\.|^m\./, ""); } catch { return ""; } })();
  if (/(^|\.)youtube\.com$|^youtu\.be$/.test(host)) return "YouTube";
  if (/(^|\.)twitch\.tv$/.test(host)) return "Twitch";
  if (/^(x|twitter)\.com$/.test(host)) return "X";
  if (/(^|\.)tiktok\.com$/.test(host)) return "TikTok";
  if (/(^|\.)kick\.com$/.test(host)) return "Kick";
  if (/(^|\.)instagram\.com$/.test(host)) return "Instagram";
  return "";
}

export const PLATFORM_LABEL: Record<WatchPlatform, string> = { youtube: "YouTube", twitch: "Twitch" };
