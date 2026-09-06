import { test } from "node:test";
import assert from "node:assert/strict";
import { detokenize, hasTranslatableText, placeholdersIntact, splitForDiscord, tokenize } from "../src/mirror/placeholders.js";

test("tokenizes every Discord entity type and restores it", () => {
  const src = "BTC just reclaimed 100k <@123> check <#456> <@&789> <:fire:111> <a:party:222> <t:1700000000:F> $BTC https://tradingview.com/x/aB3k9Q. lol `inline` ```js\nconst x = 1;\n``` @everyone";
  const t = tokenize(src);
  assert.equal(t.entities.length, 11, JSON.stringify(t.entities));
  assert.ok(!/<[@#:a]/.test(t.text), "no raw entities left: " + t.text);
  assert.ok(!t.text.includes("http"), "no raw url left");
  assert.equal(detokenize(t.text, t.entities), src);
});

test("url trailing punctuation stays outside the placeholder", () => {
  const t = tokenize("see https://example.com/a, then https://x.y/z).");
  assert.deepEqual(t.entities, ["https://example.com/a", "https://x.y/z"]);
  assert.equal(detokenize(t.text, t.entities), "see https://example.com/a, then https://x.y/z).");
});

test("placeholder validation catches dropped, duplicated and invented placeholders", () => {
  const entities = ["a", "b"];
  assert.equal(placeholdersIntact("x ⟦0⟧ y ⟦1⟧", entities), true);
  assert.equal(placeholdersIntact("x ⟦1⟧ y ⟦0⟧", entities), true);
  assert.equal(placeholdersIntact("x ⟦0⟧", entities), false);
  assert.equal(placeholdersIntact("x ⟦0⟧ ⟦0⟧ ⟦1⟧", entities), false);
  assert.equal(placeholdersIntact("x ⟦0⟧ ⟦1⟧ ⟦2⟧", entities), false);
});

test("skip heuristics", () => {
  assert.equal(hasTranslatableText(tokenize("🔥🔥🔥").text), false);
  assert.equal(hasTranslatableText(tokenize("<@123> <#456>").text), false);
  assert.equal(hasTranslatableText(tokenize("https://x.y/z").text), false);
  assert.equal(hasTranslatableText(tokenize("gm").text), false);
  assert.equal(hasTranslatableText(tokenize("100k!!").text), false);
  assert.equal(hasTranslatableText(tokenize("lfg boys").text), true);
  assert.equal(hasTranslatableText(tokenize("this is the top").text), true);
});

test("splitting respects the limit and prefers line breaks", () => {
  const long = Array.from({ length: 60 }, (_, i) => `line ${i} ` + "x".repeat(50)).join("\n");
  const parts = splitForDiscord(long, 2000);
  assert.ok(parts.length >= 2);
  for (const p of parts) assert.ok(p.length <= 2000);
  assert.equal(parts.join("\n").replace(/\s+/g, " "), long.replace(/\s+/g, " "));
  assert.deepEqual(splitForDiscord("short"), ["short"]);
});
