import { test } from "node:test";
import assert from "node:assert/strict";
import { severityOf, stateOf } from "../src/flagship.js";

const e = (signal: string, direction: string, day: number) => ({ signal, direction, fired_at: `2026-08-${String(day).padStart(2, "0")}T00:00:00Z` });

test("all three bullish with a green diamond is a strong bull, shown green", () => {
  const s = severityOf([e("weekly_diamond", "bullish", 1), e("three_day_cross", "bullish", 2), e("wave_flip", "bullish", 3)]);
  assert.equal(s, "max-bull");
  assert.equal(stateOf(s), "bullish");
});

test("the latest event per signal wins", () => {
  const s = severityOf([e("weekly_diamond", "bullish", 1), e("three_day_cross", "bullish", 2), e("three_day_cross", "bearish", 9), e("wave_flip", "bullish", 3)]);
  assert.equal(s, "mixed");
  assert.equal(stateOf(s), "caution");
});

test("no diamond with both others bearish is a bear trend, shown red", () => {
  const s = severityOf([e("three_day_cross", "bearish", 2), e("wave_flip", "bearish", 3)]);
  assert.equal(s, "max-bear");
  assert.equal(stateOf(s), "bearish");
});

test("bull without the diamond is caution, not green", () => {
  assert.equal(stateOf(severityOf([e("three_day_cross", "bullish", 2), e("wave_flip", "bullish", 3)])), "caution");
});
