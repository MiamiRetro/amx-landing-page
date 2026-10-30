/**
 * One-time Google sign-in for the concierge's calendar check. Run it on a
 * machine with a browser, sign in as the calendar owner (blkboxai@gmail.com)
 * and approve. It asks only for free/busy (calendar.freebusy): the bot can see
 * when you're busy, never what the events are, and can't change anything.
 *
 *   npx tsx scripts/google-calendar-auth.ts [path/to/client_secret.json]
 *
 * The client defaults to ~/.config/gog/client_secret.json (a Google "installed
 * app" client). The refresh token is written to
 * ~/.config/blkbox/google-calendar.json (mode 600), never printed; put its
 * three values in Railway as GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and
 * GOOGLE_CALENDAR_REFRESH_TOKEN.
 */
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

const SCOPE = "https://www.googleapis.com/auth/calendar.freebusy";
const secretPath = process.argv[2] ?? join(homedir(), ".config", "gog", "client_secret.json");
const raw = JSON.parse(readFileSync(secretPath, "utf8"));
const client = raw.installed ?? raw.web;
if (!client?.client_id || !client?.client_secret) throw new Error(`no OAuth client in ${secretPath}`);

const server = createServer();
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;
const redirect = `http://127.0.0.1:${port}`;
const url = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
  client_id: client.client_id,
  redirect_uri: redirect,
  response_type: "code",
  scope: SCOPE,
  access_type: "offline",
  prompt: "consent",
  login_hint: "blkboxai@gmail.com",
})}`;

console.log("Opening Google sign-in. Sign in as blkboxai@gmail.com and approve \"See your free/busy\".\nIf no browser opens, open this link:\n" + url);
execFile("open", [url], () => {});

const code = await new Promise<string>((resolve, reject) => {
  server.on("request", (req, res) => {
    const q = new URL(req.url ?? "/", redirect).searchParams;
    res.end(q.get("code") ? "Done. You can close this tab." : `Sign-in failed: ${q.get("error") ?? "no code"}`);
    if (q.get("code")) resolve(q.get("code")!);
    else reject(new Error(q.get("error") ?? "no code"));
  });
});
server.close();

const r = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  body: new URLSearchParams({ code, client_id: client.client_id, client_secret: client.client_secret, redirect_uri: redirect, grant_type: "authorization_code" }),
});
const tok = (await r.json()) as { refresh_token?: string; error?: string; error_description?: string };
if (!tok.refresh_token) throw new Error(`no refresh token: ${tok.error ?? ""} ${tok.error_description ?? ""}`);

const out = join(homedir(), ".config", "blkbox", "google-calendar.json");
mkdirSync(join(homedir(), ".config", "blkbox"), { recursive: true });
writeFileSync(out, JSON.stringify({ GOOGLE_CLIENT_ID: client.client_id, GOOGLE_CLIENT_SECRET: client.client_secret, GOOGLE_CALENDAR_REFRESH_TOKEN: tok.refresh_token }, null, 2), { mode: 0o600 });
console.log(`Saved to ${out}. Free/busy access granted.`);
