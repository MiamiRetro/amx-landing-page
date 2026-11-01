import { test } from "node:test";
import assert from "node:assert/strict";
import { LANGS, type Lang } from "../src/config.js";
import { languageHeld } from "../src/roles.js";

// Role ids like "ja:base" / "ja:member", one pair per language.
const roleOf = (l: Lang, t: "base" | "member") => `${l}:${t}`;
const holding = (...ids: string[]) => (id: string) => ids.includes(id);

test("a rerun keeps every language, including the ones added in the migration", () => {
  for (const l of LANGS) {
    assert.equal(languageHeld(holding(`${l}:base`), roleOf), l, `${l} base`);
    assert.equal(languageHeld(holding(`${l}:member`), roleOf), l, `${l} member`);
  }
});

test("no language role means English, and a non-English role wins over English", () => {
  assert.equal(languageHeld(holding(), roleOf), "en");
  assert.equal(languageHeld(holding("en:member", "ja:member"), roleOf), "ja");
});

test("roles that don't exist yet (dry run before the roles step) are ignored", () => {
  assert.equal(languageHeld(holding("vi:base"), (l, t) => (l === "vi" ? undefined : `${l}:${t}`)), "en");
});
