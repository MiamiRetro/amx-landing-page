import assert from "node:assert/strict";
import { test } from "node:test";
import { LANGS } from "../src/config.js";
import { bareName, NUDGE, nudgeText, parseHosts } from "../src/nudge.js";

test("every language has all four nudges with the right placeholders", () => {
  for (const lang of LANGS) {
    const t = NUDGE[lang];
    assert.ok(t, lang);
    assert.match(t.talk, /\{user\}/, `${lang} talk`);
    assert.match(t.topic, /\{user\}.*\{channel\}/s, `${lang} topic`);
    for (const p of ["{user}", "{host}", "{channel}"]) assert.ok(t.reply.includes(p), `${lang} reply ${p}`);
    for (const p of ["{user}", "{host}"]) assert.ok(t.here.includes(p), `${lang} here ${p}`);
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

test("a general reply teases the rest of the floor", () => {
  const s = nudgeText("en", "here", { user: "<@1>", host: "Tone Vays", channel: "general" });
  assert.match(s, /^🔔 <@1>, \*\*Tone Vays\*\* just answered you!/);
  assert.ok(!s.includes("{"));
});

test("hosts default to JT and Matt, env list replaces them", () => {
  assert.deepEqual([...parseHosts(undefined)], ["baloo.btc", "alphanumetrix"]);
  assert.deepEqual([...parseHosts(" @Baloo.BTC , someone ")], ["baloo.btc", "someone"]);
});
