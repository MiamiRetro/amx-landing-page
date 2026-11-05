import assert from "node:assert/strict";
import { test } from "node:test";
import { LANGS } from "../src/config.js";
import { bareName, NUDGE, nudgeText } from "../src/nudge.js";

test("every language has all three nudges with the right placeholders", () => {
  for (const lang of LANGS) {
    const t = NUDGE[lang];
    assert.ok(t, lang);
    assert.match(t.talk, /\{user\}/, `${lang} talk`);
    assert.match(t.topic, /\{user\}.*\{channel\}/s, `${lang} topic`);
    for (const p of ["{user}", "{host}", "{channel}"]) assert.ok(t.reply.includes(p), `${lang} reply ${p}`);
  }
});

test("nudge text fills the member, host and channel", () => {
  const s = nudgeText("en", "reply", { user: "<@1>", host: "Tone Vays", channel: "bitcoin" });
  assert.equal(s, "🔔 <@1>, **Tone Vays** answered you in **bitcoin**. Verify your exchange UID to read the reply and join the chat.");
  assert.ok(!nudgeText("zh", "topic", { user: "<@1>", channel: "比特币" }).includes("{"));
});

test("channel names lose their emoji prefix", () => {
  assert.equal(bareName("🟠・比特币"), "比特币");
  assert.equal(bareName("general"), "general");
});
