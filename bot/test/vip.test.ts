import { test } from "node:test";
import assert from "node:assert/strict";
import { nextTier, tierFor } from "../src/vip/tracker.js";
import { SHARE } from "../src/vip/commission.js";

const T = [1000, 2500, 5000, 10000];

test("tiers start at the threshold, not above it", () => {
  assert.equal(tierFor(999.99, T), 0);
  assert.equal(tierFor(1000, T), 1);
  assert.equal(tierFor(2499, T), 1);
  assert.equal(tierFor(2500, T), 2);
  assert.equal(tierFor(9999, T), 3);
  assert.equal(tierFor(10000, T), 4);
  assert.equal(tierFor(250000, T), 4);
});

test("no commission is no tier", () => {
  assert.equal(tierFor(0, T), 0);
});

test("the check raises a tier but never lowers one", () => {
  assert.equal(nextTier(2, 0), 2);
  assert.equal(nextTier(3, 1), 3);
  assert.equal(nextTier(0, 1), 1);
  assert.equal(nextTier(1, 4), 4);
  assert.equal(nextTier(0, 0), 0);
});

test("our share is half of 0.06% taker and 0.02% maker", () => {
  // $1M taker volume earns $300, $1M maker earns $100
  assert.equal(Math.round(1_000_000 * SHARE.taker), 300);
  assert.equal(Math.round(1_000_000 * SHARE.maker), 100);
});
