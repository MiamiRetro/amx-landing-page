import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReport, formatReport, pct, type FunnelRow } from "../src/funnel.js";

const row = (user: string, event: string, extra: Partial<FunnelRow> = {}): FunnelRow => ({ discord_user_id: user, event, lang: null, invite_code: null, ...extra });

const rows: FunnelRow[] = [
  row("a", "join", { invite_code: "abc" }),
  row("b", "join", { invite_code: "abc" }),
  row("c", "join", { invite_code: "xyz" }),
  row("d", "join"),
  row("a", "language_picked", { lang: "zh" }),
  row("b", "language_picked", { lang: "zh" }),
  row("c", "language_picked", { lang: "en" }),
  row("a", "verify_opened"),
  row("a", "verify_opened"),
  row("b", "verify_opened"),
  row("a", "verify_result", { lang: "zh" }),
  row("a", "verified", { lang: "zh" }),
];

test("counts distinct members per step and splits by the language they picked", () => {
  const r = buildReport(rows);
  assert.deepEqual(r.total, [4, 3, 2, 1]);
  assert.deepEqual(r.byLang.get("zh"), [2, 2, 2, 1]);
  assert.deepEqual(r.byLang.get("en"), [1, 1, 0, 0]);
  assert.deepEqual(r.byLang.get("none"), [1, 0, 0, 0]);
});

test("ranks invite codes by joins and by verified members", () => {
  const r = buildReport(rows);
  assert.deepEqual(r.topJoins, [["abc", 2], ["xyz", 1]]);
  assert.deepEqual(r.topVerified, [["abc", 1]]);
});

test("lang filter keeps only that language", () => {
  const r = buildReport(rows, { lang: "en" });
  assert.deepEqual(r.total, [1, 1, 0, 0]);
  assert.deepEqual([...r.byLang.keys()], ["en"]);
});

test("conversion is a share of the previous step", () => {
  assert.equal(pct(1, 2), "50%");
  assert.equal(pct(2, 3), "67%");
  assert.equal(pct(0, 0), "–");
  const text = formatReport(buildReport(rows), 30);
  assert.match(text, /\*\*All:\*\* 4 → 3 \(75%\) → 2 \(67%\) → 1 \(50%\)/);
  assert.ok(text.length < 2000);
});

test("empty data says so instead of dividing by zero", () => {
  const r = buildReport([]);
  assert.deepEqual(r.total, [0, 0, 0, 0]);
  assert.equal(r.byLang.size, 0);
  assert.match(formatReport(r, 7), /No onboarding events/);
});
