import { test } from "node:test";
import assert from "node:assert/strict";
import type { Db, Verification } from "../src/db/index.js";
import { VerifyService, normaliseUid } from "../src/verify/service.js";
import { ProviderError, type AffiliateProvider, type ExchangeId } from "../src/verify/types.js";

const GUILD = "g1";

/** In-memory stand-in for the Supabase tables the service touches. */
function fakeDb(seed: Verification[] = []) {
  const rows = [...seed];
  const attempts: { userId: string; outcome: string; at: number }[] = [];
  const db = {
    async verificationByUid(exchange: ExchangeId, uid: string) {
      return rows.find((r) => r.exchange === exchange && r.uid === uid) ?? null;
    },
    async saveVerification(v: Omit<Verification, "verified_at">) {
      rows.push({ ...v, verified_at: new Date().toISOString() });
    },
    async logAttempt(row: { discord_user_id: string; outcome: string }) {
      attempts.push({ userId: row.discord_user_id, outcome: row.outcome, at: Date.now() });
    },
    async attemptsSince(_g: string, userId: string, since: Date) {
      return attempts.filter((a) => a.userId === userId && a.at >= since.getTime()).length;
    },
  };
  return { db: db as unknown as Db, rows, attempts };
}

function provider(id: ExchangeId, behaviour: "yes" | "no" | "throw"): AffiliateProvider {
  return {
    id,
    label: id,
    configured: () => true,
    async lookup() {
      if (behaviour === "throw") throw new ProviderError("exchange timed out");
      return { referred: behaviour === "yes", detail: { probe: true } };
    },
  };
}

const service = (db: Db, p: AffiliateProvider) => new VerifyService(db, GUILD, new Map([[p.id, p]]));

test("a member who already holds the role is turned away before any lookup", async () => {
  const { db } = fakeDb();
  let calls = 0;
  const p: AffiliateProvider = { ...provider("bybit", "yes"), async lookup() { calls++; return { referred: true }; } };
  const res = await service(db, p).verify({ userId: "u1", alreadyMember: true, exchange: "bybit", uid: "12345678" });
  assert.equal(res.outcome, "already_member");
  assert.equal(calls, 0, "no exchange call for someone already in");
});

test("a referred uid verifies and is written down", async () => {
  const { db, rows } = fakeDb();
  const res = await service(db, provider("bybit", "yes")).verify({ userId: "u1", alreadyMember: false, exchange: "bybit", uid: " 1234 5678 " });
  assert.equal(res.outcome, "verified");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].uid, "12345678", "whitespace is stripped before storing");
});

test("a uid the exchange does not know comes back as not referred, not an error", async () => {
  const { db, rows } = fakeDb();
  const res = await service(db, provider("blofin", "no")).verify({ userId: "u1", alreadyMember: false, exchange: "blofin", uid: "87654321" });
  assert.equal(res.outcome, "not_referred");
  assert.equal(rows.length, 0, "nothing stored for a rejected uid");
});

test("a uid already linked to someone else is refused", async () => {
  const { db } = fakeDb([
    { guild_id: GUILD, discord_user_id: "u1", exchange: "bitget", uid: "111222", detail: null, verified_at: new Date().toISOString() },
  ]);
  const res = await service(db, provider("bitget", "yes")).verify({ userId: "u2", alreadyMember: false, exchange: "bitget", uid: "111222" });
  assert.equal(res.outcome, "already_claimed");
  assert.equal(res.claimedBy, "u1");
});

test("re-verifying your own uid is allowed", async () => {
  const { db } = fakeDb([
    { guild_id: GUILD, discord_user_id: "u1", exchange: "bitget", uid: "111222", detail: null, verified_at: new Date().toISOString() },
  ]);
  const res = await service(db, provider("bitget", "yes")).verify({ userId: "u1", alreadyMember: false, exchange: "bitget", uid: "111222" });
  assert.equal(res.outcome, "verified");
});

test("junk input is rejected without calling the exchange", async () => {
  const { db } = fakeDb();
  let calls = 0;
  const p: AffiliateProvider = { ...provider("bybit", "yes"), async lookup() { calls++; return { referred: true }; } };
  for (const uid of ["", "ab", "me@example.com", "x".repeat(40), "12 34; drop table"]) {
    const res = await service(db, p).verify({ userId: "u1", alreadyMember: false, exchange: "bybit", uid });
    assert.equal(res.outcome, "bad_uid", `expected bad_uid for ${JSON.stringify(uid)}`);
  }
  assert.equal(calls, 0);
});

test("guessing at uids runs out of attempts", async () => {
  const { db } = fakeDb();
  const svc = service(db, provider("bybit", "no"));
  const outcomes: string[] = [];
  for (let n = 0; n < 7; n++) {
    const res = await svc.verify({ userId: "u1", alreadyMember: false, exchange: "bybit", uid: `1000000${n}` });
    outcomes.push(res.outcome);
  }
  assert.deepEqual(outcomes.slice(0, 5), Array(5).fill("not_referred"));
  assert.deepEqual(outcomes.slice(5), ["rate_limited", "rate_limited"]);
});

test("an exchange outage is reported as an error, never as a rejection", async () => {
  const { db, rows } = fakeDb();
  const res = await service(db, provider("bybit", "throw")).verify({ userId: "u1", alreadyMember: false, exchange: "bybit", uid: "12345678" });
  assert.equal(res.outcome, "provider_error");
  assert.match(res.error ?? "", /timed out/);
  assert.equal(rows.length, 0);
});

test("normaliseUid strips spaces anywhere in the string", () => {
  assert.equal(normaliseUid("  12 34\t56  "), "123456");
});
