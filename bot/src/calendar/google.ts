import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Db } from "../db/index.js";
import { log, errInfo } from "../log.js";

/**
 * Read-only Google Calendar free/busy for the concierge hosts. The bot never
 * sees what an event is, only when someone is busy, and never writes.
 *
 * Two ways a host's calendar gets connected:
 *  - the owner's calendar (JT, blkboxai@gmail.com) through
 *    scripts/google-calendar-auth.ts on the Mac: GOOGLE_CLIENT_ID,
 *    GOOGLE_CLIENT_SECRET, GOOGLE_CALENDAR_REFRESH_TOKEN in the environment;
 *  - anyone else (Matt) through a one-time link from scripts/calendar-link.ts:
 *    they open it, sign in, press Allow, and the bot keeps the key in the
 *    settings table as calendar_token:<host>. That needs a "web" OAuth client
 *    (GOOGLE_WEB_CLIENT_ID, GOOGLE_WEB_CLIENT_SECRET) and PUBLIC_URL;
 *  - or, simplest, the host shares their calendar's free/busy with the
 *    owner's Google account and CONCIERGE_CAL_<HOST> names that calendar
 *    (their Gmail address): the owner's key reads it.
 */

const SCOPE = "https://www.googleapis.com/auth/calendar.freebusy";
const LINK_TTL_MS = 7 * 24 * 3600_000;
const OWNER_HOST = "jt";

const publicUrl = () => process.env.PUBLIC_URL?.trim().replace(/\/$/, "") ?? "";
const callbackUrl = () => `${publicUrl()}/calendar/callback`;
const webClient = () => {
  const id = process.env.GOOGLE_WEB_CLIENT_ID?.trim(), secret = process.env.GOOGLE_WEB_CLIENT_SECRET?.trim();
  return id && secret ? { id, secret } : null;
};

export function linkConfigured() {
  return !!(webClient() && publicUrl());
}

/** A one-time link that connects a host's calendar, good for a week. */
export async function createLink(db: Db, guildId: string, host: string): Promise<string> {
  if (!linkConfigured()) throw new Error("GOOGLE_WEB_CLIENT_ID, GOOGLE_WEB_CLIENT_SECRET and PUBLIC_URL must be set");
  const state = randomBytes(18).toString("base64url");
  await db.setSetting(guildId, `calendar_link:${state}`, `${host}|${Date.now() + LINK_TTL_MS}`);
  return `${publicUrl()}/calendar/connect?k=${state}`;
}

const page = (res: ServerResponse, status: number, title: string, body: string) => {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>`
    + `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;text-align:center;background:#0b0b0c;color:#eee">`
    + `<h1 style="font-size:1.6rem">${title}</h1><p style="color:#bbb;line-height:1.5">${body}</p></body>`);
};

async function linkHost(db: Db, guildId: string, state: string | null): Promise<string | null> {
  if (!state || !/^[\w-]{10,64}$/.test(state)) return null;
  const v = await db.getSetting(guildId, `calendar_link:${state}`);
  if (!v) return null;
  const [host, exp] = v.split("|");
  return Number(exp) > Date.now() ? host : null;
}

/** /calendar/connect and /calendar/callback on the bot's web server. Returns false for any other path. */
export async function handleCalendarHttp(req: IncomingMessage, res: ServerResponse, db: Db, guildId: string): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname !== "/calendar/connect" && url.pathname !== "/calendar/callback") return false;
  const client = webClient();
  if (!client || !publicUrl()) {
    page(res, 503, "Not set up yet", "Calendar linking isn't switched on yet. Please let JT know.");
    return true;
  }
  try {
    if (url.pathname === "/calendar/connect") {
      const state = url.searchParams.get("k");
      if (!(await linkHost(db, guildId, state))) return page(res, 410, "Link expired", "This link has expired or was already used. Ask JT for a new one."), true;
      const google = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
        client_id: client.id, redirect_uri: callbackUrl(), response_type: "code", scope: SCOPE,
        access_type: "offline", prompt: "consent", state: state!,
      })}`;
      res.writeHead(302, { location: google });
      res.end();
      return true;
    }
    const state = url.searchParams.get("state");
    const host = await linkHost(db, guildId, state);
    if (!host) return page(res, 410, "Link expired", "This link has expired or was already used. Ask JT for a new one."), true;
    const code = url.searchParams.get("code");
    if (!code) return page(res, 400, "Not connected", "Google didn't give permission, so nothing was connected. You can open the link again and press Allow."), true;
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      body: new URLSearchParams({ code, client_id: client.id, client_secret: client.secret, redirect_uri: callbackUrl(), grant_type: "authorization_code" }),
    });
    const tok = (await r.json()) as { refresh_token?: string; error?: string };
    if (!tok.refresh_token) throw new Error(`no refresh token (${tok.error ?? r.status})`);
    await db.setSetting(guildId, `calendar_token:${host}`, tok.refresh_token);
    await db.deleteSetting(guildId, `calendar_link:${state}`);
    log.info("calendar connected", { host });
    page(res, 200, "✅ All set, thank you!", "Your calendar is connected. The BLKBöX concierge can now see when you're free or busy (never what your events are) to suggest session times. You can close this page.");
  } catch (e) {
    log.error("calendar link failed", errInfo(e));
    page(res, 500, "Something went wrong", "Nothing was connected. Please let JT know.");
  }
  return true;
}

async function accessToken(db: Db, guildId: string, host: string): Promise<string | null> {
  const stored = await db.getSetting(guildId, `calendar_token:${host}`).catch(() => null);
  const web = webClient();
  const creds = stored && web
    ? { id: web.id, secret: web.secret, refresh: stored }
    : host === OWNER_HOST && process.env.GOOGLE_CALENDAR_REFRESH_TOKEN
      ? { id: process.env.GOOGLE_CLIENT_ID ?? "", secret: process.env.GOOGLE_CLIENT_SECRET ?? "", refresh: process.env.GOOGLE_CALENDAR_REFRESH_TOKEN }
      : null;
  if (!creds) return null;
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({ client_id: creds.id, client_secret: creds.secret, refresh_token: creds.refresh, grant_type: "refresh_token" }),
  });
  const j = (await r.json()) as { access_token?: string; error?: string };
  if (!j.access_token) throw new Error(`calendar token for ${host}: ${j.error ?? r.status}`);
  return j.access_token;
}

export interface Busy { start: Date; end: Date }

/** The host's busy blocks between two times, or null when their calendar isn't connected. */
export async function busyTimes(db: Db, guildId: string, host: string, from: Date, to: Date): Promise<Busy[] | null> {
  // Their own key first; else their calendar shared with the owner, read with the owner's key.
  const shared = host !== OWNER_HOST ? process.env[`CONCIERGE_CAL_${host.toUpperCase()}`]?.trim() : undefined;
  const own = await accessToken(db, guildId, host);
  const token = own ?? (shared ? await accessToken(db, guildId, OWNER_HOST) : null);
  if (!token) return null;
  const id = own ? "primary" : shared!;
  const r = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ timeMin: from.toISOString(), timeMax: to.toISOString(), items: [{ id }] }),
  });
  const j = (await r.json()) as { calendars?: Record<string, { busy?: { start: string; end: string }[]; errors?: unknown[] }> };
  const cal = j.calendars?.[id];
  if (!r.ok || !cal || cal.errors?.length) throw new Error(`free/busy for ${host}: ${r.status} ${JSON.stringify(cal?.errors ?? j).slice(0, 200)}`);
  return (cal.busy ?? []).map((b) => ({ start: new Date(b.start), end: new Date(b.end) }));
}
