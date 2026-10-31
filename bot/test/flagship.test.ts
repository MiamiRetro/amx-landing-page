import { test } from "node:test";
import assert from "node:assert/strict";
import { stateOf, ICONS, STATE_PREFIX } from "../src/flagship.js";

const e = (signal: string, direction: string, day: number) => ({ signal, direction, fired_at: `2026-08-${String(day).padStart(2, "0")}T00:00:00Z` });

test("all three bullish is a strong bull, double green", () => {
  const s = stateOf([e("weekly_diamond", "bullish", 1), e("three_day_cross", "bullish", 2), e("wave_flip", "bullish", 3)]);
  assert.equal(s, "strong-bull");
  assert.equal(ICONS[s], "🟢🟢");
});

test("the latest event per signal wins", () => {
  assert.equal(stateOf([e("weekly_diamond", "bullish", 1), e("three_day_cross", "bullish", 2), e("three_day_cross", "bearish", 9), e("wave_flip", "bullish", 3)]), "lean-bull");
});

test("one bullish is leaning bearish, red then yellow", () => {
  assert.equal(ICONS[stateOf([e("wave_flip", "bullish", 3), e("three_day_cross", "bearish", 2)])], "🔴🟡");
});

test("nothing fired counts as a strong bear, double red", () => {
  assert.equal(ICONS[stateOf([])], "🔴🔴");
});

test("old and new channel prefixes both match", () => {
  for (const n of ["🟢・alphanumetrix", "🔴🟡・alphanumetrix"]) assert.ok(STATE_PREFIX.test(n));
  assert.ok(!STATE_PREFIX.test("🟠・bitcoin"));
});
