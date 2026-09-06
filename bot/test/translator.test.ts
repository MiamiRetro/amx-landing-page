import { test } from "node:test";
import assert from "node:assert/strict";
import { Translator } from "../src/translate/index.js";
import type { TranslateRequest, TranslateResult, TranslationProvider } from "../src/translate/provider.js";
import { extractJson } from "../src/translate/openai-compatible.js";
import { buildUserPrompt } from "../src/translate/prompt.js";

function fake(id: string, impl: (req: TranslateRequest) => Partial<Record<string, string[]>> | Error): TranslationProvider & { calls: number } {
  return {
    id,
    calls: 0,
    async translate(req): Promise<TranslateResult> {
      this.calls++;
      const r = impl(req);
      if (r instanceof Error) throw r;
      return { translations: r as TranslateResult["translations"], usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1 } };
    },
  };
}

test("returns translations per target and keeps placeholders", async () => {
  const p = fake("p", (req) => ({ zh: req.segments.map((s) => `中 ${s}`), ko: req.segments.map((s) => `한 ${s}`) }));
  const tr = new Translator({ primary: p });
  const r = await tr.translate(["hello ⟦0⟧"], [["<@1>"]], "en", ["zh", "ko"], []);
  assert.equal(r.translated, true);
  assert.deepEqual(r.translations.zh, ["中 hello ⟦0⟧"]);
  assert.deepEqual(r.translations.ko, ["한 hello ⟦0⟧"]);
});

test("retries once when placeholders are damaged, then falls back to the next provider", async () => {
  const bad = fake("bad", (req) => ({ zh: req.segments.map(() => "dropped it") }));
  const good = fake("good", (req) => ({ zh: req.segments.map((s) => `ok ${s}`) }));
  const tr = new Translator({ primary: bad, fallbacks: [good] });
  const r = await tr.translate(["hi ⟦0⟧"], [["<@1>"]], "en", ["zh"], []);
  assert.equal(bad.calls, 2);
  assert.equal(good.calls, 1);
  assert.deepEqual(r.translations.zh, ["ok hi ⟦0⟧"]);
});

test("returns source text untranslated when every provider fails", async () => {
  const p = fake("p", () => new Error("boom"));
  const tr = new Translator({ primary: p });
  const r = await tr.translate(["hi"], [[]], "en", ["zh"], []);
  assert.equal(r.translated, false);
  assert.deepEqual(r.translations.zh, ["hi"]);
});

test("extractJson tolerates fences and prose", () => {
  assert.deepEqual(extractJson('Sure!\n```json\n{"zh":["a"]}\n```'), { zh: ["a"] });
  assert.deepEqual(extractJson('{"ko":["b"]}'), { ko: ["b"] });
});

test("user prompt lists segments with indexes and glossary", () => {
  const p = buildUserPrompt({ segments: ["gm ⟦0⟧", "send it"], sourceLang: "en", targets: ["zh", "id"], glossary: [{ term: "AMX", note: "brand" }] });
  assert.match(p, /\[0\] "gm ⟦0⟧"/);
  assert.match(p, /\[1\] "send it"/);
  assert.match(p, /- AMX — brand/);
  assert.match(p, /keys are the target language codes \(zh, id\)/);
});
