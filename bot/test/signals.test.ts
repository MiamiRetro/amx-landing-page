import { test } from "node:test";
import assert from "node:assert/strict";
import { toEvents, boardAfter, signalEmbed, boardEmbed, cardSpec, type EventRow } from "../src/signals/model.js";

// The live history as of 2026-10-25: three hand-entered seeds, then four alerts.
const row = (id: number, signal: string, direction: string, fired: string, received: string, price: number | null, seed = false): EventRow =>
  ({ id, symbol: "BTC", signal, direction, fired_at: `${fired}T00:00:00Z`, received_at: `${received}T00:00:08Z`, price, raw: seed ? { seed: true } : {} });
const rows = [
  row(7, "three_day_cross", "bullish", "2026-08-20", "2026-08-23", 77088.42),
  row(1, "weekly_diamond", "bullish", "2026-02-09", "2026-05-07", null, true),
  row(2, "wave_flip", "bullish", "2026-04-13", "2026-05-07", null, true),
  row(3, "three_day_cross", "bullish", "2026-04-19", "2026-05-07", null, true),
  row(4, "wave_flip", "bearish", "2026-06-02", "2026-06-03", 66673.66),
  row(5, "three_day_cross", "bearish", "2026-06-03", "2026-06-06", 61060.24),
  row(6, "wave_flip", "bullish", "2026-08-20", "2026-08-21", 73010.81),
  { ...row(8, "wave_flip", "bullish", "2026-08-20", "2026-08-21", 1), symbol: "ETH" },
];

test("events are BTC only, oldest first and numbered", () => {
  const ev = toEvents(rows);
  assert.deepEqual(ev.map((e) => e.n), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(ev[0].confirmed, undefined, "seed rows have no confirmation date");
  assert.equal(ev[6].confirmed, "2026-08-23");
  // The feed RPC returns no raw payload: an alert without a price is the hand-entered history.
  const bare = toEvents(rows.map(({ raw: _raw, ...r }) => r));
  assert.equal(bare[0].confirmed, undefined);
  assert.equal(bare[0].fired, "2026-02-09");
});

test("the board counts lit signals and leaves unfired ones dark", () => {
  const ev = toEvents(rows);
  const first = boardAfter(ev.slice(0, 1));
  assert.equal(first.count, 1);
  assert.equal(first.board["Wave Flip"].none, true);
  assert.equal(boardAfter(ev.slice(0, 5)).count, 1);
  assert.equal(boardAfter(ev).count, 3);
});

test("a new card says how the reading moved", () => {
  const ev = toEvents(rows);
  const e = signalEmbed(ev, 4);
  assert.equal(e.title, "🔴 #5 · 3-Day Cross flipped bearish");
  assert.match(e.description!, /moves from Leaning Bullish to \*\*Leaning Bearish\*\*/);
  assert.equal(e.fields![1].value, "$61,060.24");
  assert.match(signalEmbed(ev, 0).description!, /once per market cycle/);
  assert.match(boardEmbed(ev).description!, /3 of 3 bullish → 🟢🟢 Strong Bull Trend/);
});

test("the card image gets numbers only", () => {
  const s = cardSpec(toEvents(rows), 6);
  assert.equal(s.price, "77,088");
  assert.equal(s.date, "2026-08-23");
  assert.equal(s.count, 3);
});
