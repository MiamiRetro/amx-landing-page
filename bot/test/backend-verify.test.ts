import { test } from "node:test";
import assert from "node:assert/strict";
import { BackendVerifier, UidClaimedError } from "../src/verify/providers/backend.js";
import { ProviderError } from "../src/verify/types.js";

process.env.VERIFY_BACKEND_URL = "https://api.example/exchange-accounts/verify";
process.env.VERIFY_BACKEND_KEY = "k";

/** Answers the next fetch with this status and JSON body, and records what was sent. */
function reply(status: number, body: unknown) {
  const sent: { url?: string; init?: RequestInit } = {};
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    sent.url = url;
    sent.init = init;
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return sent;
}
const meta = { serverTime: "2026-10-21T00:00:00Z", requestId: "r1" };
const ctx = { discordUserId: "123456789012345678" };

test("a verified main-account UID is referred, and the request carries the key and the member", async () => {
  const sent = reply(200, { success: true, data: { verified: true }, meta });
  const r = await new BackendVerifier("bybit").lookup("12345678", ctx);
  assert.equal(r.referred, true);
  assert.equal((sent.init!.headers as Record<string, string>)["x-api-key"], "k");
  assert.deepEqual(JSON.parse(String(sent.init!.body)), { discordUserId: ctx.discordUserId, exchangeId: "bybit", exchangeUserId: "12345678" });
});

test("verified: false (a sub-account or not ours) is a clean no", async () => {
  reply(200, { success: true, data: { verified: false }, meta });
  assert.equal((await new BackendVerifier("blofin").lookup("12345678", ctx)).referred, false);
});

test("409 means the UID belongs to someone else", async () => {
  reply(409, { success: false, error: { type: "CONFLICT", code: "UID_LINKED_TO_OTHER_USER", message: "taken" }, meta });
  await assert.rejects(new BackendVerifier("bitget").lookup("12345678", ctx), UidClaimedError);
});

test("403 NOT_PARTNER_ACCOUNT is a clean no", async () => {
  reply(403, { success: false, error: { type: "FORBIDDEN", code: "NOT_PARTNER_ACCOUNT", message: "not ours" }, meta });
  assert.equal((await new BackendVerifier("bybit").lookup("12345678", ctx)).referred, false);
});

test("an exchange outage or an unknown 403 is an error to retry, not a no", async () => {
  reply(502, { success: false, error: { type: "EXCHANGE", code: "EXCHANGE_UNREACHABLE", message: "down" }, meta });
  await assert.rejects(new BackendVerifier("bybit").lookup("12345678", ctx), (e: unknown) => e instanceof ProviderError && !(e instanceof UidClaimedError));
  reply(403, { success: false, error: { type: "FORBIDDEN", code: "FORBIDDEN", message: "bad key" }, meta });
  await assert.rejects(new BackendVerifier("bybit").lookup("12345678", ctx), (e: unknown) => e instanceof ProviderError && !(e instanceof UidClaimedError));
});
