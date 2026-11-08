import assert from "node:assert/strict";
import { test } from "node:test";
import { LANGS } from "../src/config.js";
import { GATE_TEXT, gateText, imageMime, parseVerdict } from "../src/image-gate.js";

test("every language has all three image-gate cards with the member's mention", () => {
  for (const lang of LANGS) {
    const t = GATE_TEXT[lang];
    assert.ok(t, lang);
    for (const k of ["allowed", "removed", "failed"] as const) assert.match(t[k], /\{user\}/, `${lang} ${k}`);
  }
  assert.ok(gateText("en", "removed", "<@1>").startsWith("🖼️ <@1>, until you verify"));
});

test("only a clear ALLOW lets a picture through", () => {
  assert.equal(parseVerdict("ALLOW"), "allow");
  assert.equal(parseVerdict(" allow."), "allow");
  assert.equal(parseVerdict("REMOVE"), "remove");
  assert.equal(parseVerdict("I think ALLOW"), "remove");
  assert.equal(parseVerdict(""), "remove");
});

test("pictures are recognised by content type or file name; other files aren't", () => {
  assert.equal(imageMime({ name: "chart.PNG", contentType: null }), "image/png");
  assert.equal(imageMime({ name: "x", contentType: "image/jpeg" }), "image/jpeg");
  assert.equal(imageMime({ name: "a.gif", contentType: null }), "image/gif");
  assert.equal(imageMime({ name: "setup.exe", contentType: "application/octet-stream" }), null);
  assert.equal(imageMime({ name: "clip.mp4", contentType: "video/mp4" }), null);
});
