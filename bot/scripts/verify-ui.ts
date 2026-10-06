/**
 * A small web page for checking UIDs against the affiliate APIs by hand,
 * through the same providers the bot uses, so a ticket can be answered or an
 * exchange proven without going through Discord.
 *
 *   railway run npx tsx scripts/verify-ui.ts        # then open http://localhost:8611
 *
 * Read-only: it never records an attempt, saves a verification or grants a
 * role. It answers only loopback and Tailscale (100.64.0.0/10) addresses,
 * because a referred UID comes back with the invitee's deposits and volume.
 */
import "dotenv/config";
import { createServer, type IncomingMessage } from "node:http";
import { Db } from "../src/db/index.js";
import { buildProviders } from "../src/verify/providers/index.js";
import { normaliseUid, UID_RE } from "../src/verify/service.js";
import { EXCHANGE_LABELS, ProviderError, isExchange, type ExchangeId } from "../src/verify/types.js";

const PORT = Number(process.env.VERIFY_UI_PORT ?? 8611);
const MAX_UIDS = 25;

const providers = buildProviders();
const db = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY ? new Db() : null;

function allowed(req: IncomingMessage): boolean {
  const ip = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
  if (ip === "127.0.0.1" || ip === "::1") return true;
  const m = ip.match(/^100\.(\d+)\./);
  return Boolean(m && Number(m[1]) >= 64 && Number(m[1]) <= 127);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 20_000) throw new Error("request too large");
  }
  return JSON.parse(raw || "{}");
}

interface Row {
  uid: string;
  verdict: "referred" | "not_referred" | "bad_uid" | "error" | "stand_in";
  ms?: number;
  detail?: unknown;
  error?: string;
  body?: string;
  claimedBy?: string;
}

async function check(exchange: ExchangeId, raw: string): Promise<Row> {
  const uid = normaliseUid(raw);
  if (!UID_RE.test(uid)) return { uid, verdict: "bad_uid" };
  const provider = providers.get(exchange);
  if (!provider) return { uid, verdict: "error", error: "no provider configured" };
  if (!provider.live) return { uid, verdict: "stand_in" };
  const claimedBy = (await db?.verificationByUid(exchange, uid).catch(() => null))?.discord_user_id;
  const started = Date.now();
  try {
    const res = await provider.lookup(uid);
    return { uid, verdict: res.referred ? "referred" : "not_referred", ms: Date.now() - started, detail: res.detail, claimedBy };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return { uid, verdict: "error", ms: Date.now() - started, error, body: e instanceof ProviderError ? e.body : undefined, claimedBy };
  }
}

const server = createServer(async (req, res) => {
  if (!allowed(req)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  const send = (status: number, type: string, body: string) => res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" }).end(body);
  try {
    if (req.method === "GET" && (req.url === "/" || req.url?.startsWith("/?"))) {
      const exchanges = [...providers.entries()].map(([id, p]) => ({ id, label: EXCHANGE_LABELS[id], live: p.live }));
      return send(200, "text/html; charset=utf-8", PAGE.replace("__EXCHANGES__", JSON.stringify(exchanges)));
    }
    if (req.method === "POST" && req.url === "/api/check") {
      const body = (await readJson(req)) as { exchange?: string; uids?: unknown };
      const exchange = String(body.exchange ?? "");
      if (!isExchange(exchange)) return send(400, "application/json", JSON.stringify({ error: "unknown exchange" }));
      const uids = (Array.isArray(body.uids) ? body.uids : []).map(String).filter((u) => u.trim()).slice(0, MAX_UIDS);
      const rows: Row[] = [];
      // One at a time: the affiliate APIs rate-limit per key, and the bot shares it.
      for (const uid of uids) rows.push(await check(exchange, uid));
      return send(200, "application/json", JSON.stringify({ exchange, rows }));
    }
    send(404, "text/plain", "not found");
  } catch (e) {
    send(500, "application/json", JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
  }
});

server.listen(PORT, "0.0.0.0", () => {
  const live = [...providers.values()].filter((p) => p.live).map((p) => p.label);
  console.log(`UID tester on http://localhost:${PORT} (live: ${live.join(", ") || "none"}${db ? "; claims from Supabase" : ""})`);
});

const PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>UID Tester</title>
<style>
  :root {
    --bg: #0b1220; --panel: #121b2e; --line: #22304a; --text: #e6edf7; --muted: #8b9ab3;
    --cyan: #22d3ee; --green: #34d399; --red: #f87171; --amber: #fbbf24;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 24px 16px 48px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: var(--muted); margin: 0 0 20px; font-size: 13px; }
  .tabs { display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
  .tab { border: 1px solid var(--line); background: var(--panel); color: var(--text); padding: 8px 14px; border-radius: 999px; cursor: pointer; font: inherit; }
  .tab[aria-pressed="true"] { border-color: var(--cyan); color: var(--cyan); }
  .tab small { color: var(--amber); margin-left: 4px; }
  textarea { width: 100%; min-height: 92px; resize: vertical; background: var(--panel); color: var(--text); border: 1px solid var(--line); border-radius: 10px; padding: 12px; font: 16px ui-monospace, SFMono-Regular, Menlo, monospace; }
  textarea:focus { outline: none; border-color: var(--cyan); }
  .row { display: flex; gap: 10px; align-items: center; margin: 10px 0 20px; flex-wrap: wrap; }
  button.go { background: var(--green); color: #052016; border: 0; border-radius: 10px; padding: 10px 18px; font: 600 15px system-ui, sans-serif; cursor: pointer; }
  button.go:disabled { opacity: .5; cursor: wait; }
  .hint { color: var(--muted); font-size: 13px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; margin-bottom: 10px; }
  .head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .uid { font: 15px ui-monospace, SFMono-Regular, Menlo, monospace; }
  .pill { font-size: 12px; font-weight: 600; padding: 3px 10px; border-radius: 999px; }
  .referred { background: rgba(52,211,153,.15); color: var(--green); }
  .not_referred { background: rgba(248,113,113,.15); color: var(--red); }
  .error, .bad_uid, .stand_in { background: rgba(251,191,36,.15); color: var(--amber); }
  .ms { color: var(--muted); font-size: 12px; margin-left: auto; }
  .facts { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 6px 14px; margin-top: 10px; font-size: 13px; }
  .facts span { color: var(--muted); display: block; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
  .note { margin-top: 8px; font-size: 13px; color: var(--muted); }
  .note.warn { color: var(--amber); }
  details { margin-top: 8px; font-size: 12px; color: var(--muted); }
  pre { white-space: pre-wrap; word-break: break-all; background: #0a0f1b; padding: 10px; border-radius: 8px; margin: 6px 0 0; color: var(--text); }
</style>
</head>
<body>
<main>
  <h1>UID Tester</h1>
  <p class="sub">Asks the exchange's affiliate API whether a UID signed up under our link, using the bot's own code. Nothing is saved and no roles change.</p>
  <div class="tabs" id="tabs"></div>
  <textarea id="uids" placeholder="Paste one or more UIDs, one per line" autofocus></textarea>
  <div class="row">
    <button class="go" id="go">Check</button>
    <span class="hint">Up to ${MAX_UIDS} at once · Ctrl/⌘ + Enter</span>
  </div>
  <div id="out"></div>
</main>
<script>
const EXCHANGES = __EXCHANGES__;
const SAYS = {
  referred: "Referred: the bot would verify",
  not_referred: "Not ours: the bot would say it can't see this UID",
  error: "Exchange error: the bot would say try again later",
  bad_uid: "Not a valid UID format",
  stand_in: "Stand-in: this exchange has no API keys set",
};
const FACTS = ["registerTime", "kycLevel", "vipLevel", "KycLevel", "tradeVol30Day", "totalTradingVolume", "totalDeposit", "equity", "referralCode"];
let exchange = new URLSearchParams(location.search).get("x") || (EXCHANGES.find((e) => e.id === "blofin") || EXCHANGES[0] || {}).id;

const tabs = document.getElementById("tabs");
function drawTabs() {
  tabs.innerHTML = "";
  for (const e of EXCHANGES) {
    const b = document.createElement("button");
    b.className = "tab";
    b.textContent = e.label;
    if (!e.live) b.insertAdjacentHTML("beforeend", "<small>stand-in</small>");
    b.setAttribute("aria-pressed", String(e.id === exchange));
    b.onclick = () => { exchange = e.id; history.replaceState(null, "", "?x=" + e.id); drawTabs(); };
    tabs.append(b);
  }
}
drawTabs();

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function fmtTime(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 1e11 ? new Date(n).toISOString().slice(0, 16).replace("T", " ") + " UTC" : v;
}
function facts(detail) {
  const src = detail && (detail.first || detail);
  if (!src || typeof src !== "object") return "";
  const items = FACTS.filter((k) => src[k] !== undefined && src[k] !== null && src[k] !== "")
    .map((k) => "<div><span>" + esc(k) + "</span>" + esc(k === "registerTime" ? fmtTime(src[k]) : src[k]) + "</div>");
  return items.length ? '<div class="facts">' + items.join("") + "</div>" : "";
}
function card(r) {
  let html = '<div class="card"><div class="head"><span class="uid">' + esc(r.uid) + '</span><span class="pill ' + r.verdict + '">' + esc(SAYS[r.verdict]) + "</span>";
  if (r.ms !== undefined) html += '<span class="ms">' + r.ms + " ms</span>";
  html += "</div>";
  if (r.verdict === "referred") html += facts(r.detail);
  if (r.error) html += '<div class="note warn">' + esc(r.error) + "</div>";
  if (r.claimedBy) html += '<div class="note warn">Already claimed in Discord by user ' + esc(r.claimedBy) + "</div>";
  const raw = { detail: r.detail, body: r.body };
  if (r.detail || r.body) html += "<details><summary>Raw answer</summary><pre>" + esc(JSON.stringify(raw, null, 2)) + "</pre></details>";
  return html + "</div>";
}

const go = document.getElementById("go"), box = document.getElementById("uids"), out = document.getElementById("out");
async function run() {
  const uids = box.value.split(/[\\s,;]+/).map((s) => s.trim()).filter(Boolean);
  if (!uids.length || !exchange) return;
  go.disabled = true;
  out.innerHTML = '<p class="hint">Asking ' + esc((EXCHANGES.find((e) => e.id === exchange) || {}).label) + "…</p>";
  try {
    const res = await fetch("/api/check", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ exchange, uids }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    out.innerHTML = data.rows.map(card).join("");
  } catch (e) {
    out.innerHTML = '<div class="card"><div class="note warn">' + esc(e.message) + "</div></div>";
  } finally {
    go.disabled = false;
  }
}
go.onclick = run;
box.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) run(); });
</script>
</body>
</html>`;
