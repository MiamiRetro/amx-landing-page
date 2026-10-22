import { test } from "node:test";
import assert from "node:assert/strict";
import { applyStrings, flattenStrings, parseExtraction } from "../src/infographic/schema.js";
import { buildTemplateData, escapeHtml, fontStack } from "../src/infographic/render.js";
import { chooseFiles, InfographicLocalizer, infographicsEnabled, pickCandidates } from "../src/infographic/index.js";
import { mimeFromName } from "../src/infographic/extract.js";
import { Translator } from "../src/translate/index.js";
import type { Renderer } from "../src/infographic/render.js";

const sample = {
  isInfographic: true,
  title: "Connect your exchange",
  subtitle: "Five minutes",
  layout: "steps",
  sections: [
    { heading: "Create a key", body: "Read-only." },
    { heading: "Paste it", bullets: ["Key", "Secret"] },
  ],
  footer: "Ask in #help-desk",
};

test("parseExtraction accepts a valid infographic", () => {
  const ex = parseExtraction(sample);
  assert.ok(ex);
  assert.equal(ex.sections.length, 2);
});

test("parseExtraction rejects non-infographics, bad layouts and empty content", () => {
  assert.equal(parseExtraction({ ...sample, isInfographic: false }), null);
  assert.equal(parseExtraction({ ...sample, layout: "poster" }), null);
  assert.equal(parseExtraction({ ...sample, sections: [] }), null);
  assert.equal(parseExtraction({ ...sample, title: "  " }), null);
  assert.equal(parseExtraction({ title: "x" }), null);
  assert.equal(parseExtraction(null), null);
});

test("flattenStrings and applyStrings round-trip", () => {
  const ex = parseExtraction(sample)!;
  const flat = flattenStrings(ex);
  const up = applyStrings(ex, flat.map((s) => s.toUpperCase()));
  assert.equal(up.title, "CONNECT YOUR EXCHANGE");
  assert.deepEqual(up.sections[1].bullets, ["KEY", "SECRET"]);
  assert.equal(up.sections[1].body, undefined);
  assert.throws(() => applyStrings(ex, flat.slice(1)));
});

test("buildTemplateData drops empty cards and picks columns", () => {
  const ex = parseExtraction({ ...sample, sections: [...sample.sections, { heading: " " }] })!;
  const d = buildTemplateData(ex, "ja");
  assert.equal(d.cards.length, 2);
  assert.equal(d.columns, 1);
  assert.match(d.fontStack, /Noto Sans CJK JP/);
  const cmp = buildTemplateData({ ...ex, layout: "comparison" }, "en");
  assert.equal(cmp.columns, 2);
  const stat = buildTemplateData({ ...ex, layout: "stat", sections: [{ value: "1" }, { value: "2" }, { value: "3" }] }, "en");
  assert.equal(stat.columns, 3);
});

test("fontStack uses Noto Sans for Cyrillic and Vietnamese", () => {
  assert.match(fontStack("ru"), /^"Noto Sans Embed"/);
  assert.match(fontStack("vi"), /^"Noto Sans Embed"/);
  assert.match(fontStack("en"), /^Sora/);
  assert.match(fontStack("ko"), /Noto Sans CJK KR/);
});

test("escapeHtml", () => {
  assert.equal(escapeHtml(`<a href="x">&'`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
});

test("candidates: tutorial groups only, images only, max 4", () => {
  const names = ["a.png", "b.txt", "c.JPG", "d.webp", "e.jpeg", "f.png", "g.gif"];
  assert.deepEqual(pickCandidates("setup-guides", names), [0, 2, 3, 4]);
  assert.deepEqual(pickCandidates("forums", names), []);
  assert.deepEqual(pickCandidates("general", names), []);
  assert.equal(mimeFromName("x.webp"), "image/webp");
  assert.equal(mimeFromName("x.gif"), null);
});

test("flag is off by default", () => {
  assert.equal(infographicsEnabled({}), false);
  assert.equal(infographicsEnabled({ INFOGRAPHIC_TRANSLATION: "1" }), true);
});

test("chooseFiles falls back to originals", () => {
  const files = [{ attachment: Buffer.from("a"), name: "a.jpg" }, { attachment: Buffer.from("b"), name: "b.png" }];
  assert.equal(chooseFiles(files, undefined), files);
  const r = chooseFiles(files, new Map([[0, Buffer.from("R")]]));
  assert.equal(r[0].name, "a.png");
  assert.equal(r[0].attachment.toString(), "R");
  assert.equal(r[1], files[1]);
});

test("localizer keeps originals when not an infographic or translation fails, and caches renders", async () => {
  let renders = 0;
  const renderer = { render: async () => { renders++; return Buffer.from("png"); }, close: async () => {} } as unknown as Renderer;
  const ok = new Translator({ primary: { id: "p", translate: async (req) => ({ translations: Object.fromEntries(req.targets.map((t) => [t, req.segments.map((s) => `${t}:${s}`)])), usage: { inputTokens: 0, cachedTokens: 0, cacheCreationTokens: 0, outputTokens: 0 } }) } });
  const files = [{ attachment: Buffer.from("img"), name: "g.png" }];

  const notInfo = new InfographicLocalizer({ translator: ok, renderer, extract: async () => null });
  assert.equal((await notInfo.localize("setup-guides", files, "en", ["ja"], [])).size, 0);

  let extracts = 0;
  const loc = new InfographicLocalizer({ translator: ok, renderer, extract: async () => { extracts++; return parseExtraction(sample); } });
  const out = await loc.localize("setup-guides", files, "en", ["ja", "ru", "en"], []);
  assert.deepEqual([...out.keys()].sort(), ["ja", "ru"]);
  await loc.localize("setup-guides", files, "en", ["ja", "ru"], []);
  assert.equal(extracts, 1);
  assert.equal(renders, 2);

  const failing = new Translator({ primary: { id: "f", translate: async () => { throw new Error("down"); } } });
  const loc2 = new InfographicLocalizer({ translator: failing, renderer, extract: async () => parseExtraction(sample) });
  assert.equal((await loc2.localize("setup-guides", files, "en", ["ja"], [])).size, 0);
});
