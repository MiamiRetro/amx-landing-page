import { test } from "node:test";
import assert from "node:assert/strict";
import { LANGS } from "../src/config.js";
import { Answer, loadFaq, SupportAssistant, systemPrompt } from "../src/support/assistant.js";
import { SUPPORT_OPEN, supportPanel } from "../src/support/desk.js";
import { SUPPORT_TEXT } from "../src/support/text.js";

test("the FAQ ships with the bot and goes into the prompt whole", () => {
  const faq = loadFaq();
  assert.match(faq, /## How do I unlock the full server\?/);
  const prompt = systemPrompt(faq, "ko");
  assert.ok(prompt.includes(faq));
  assert.match(prompt, /Reply in Korean/);
});

test("every language has every help-desk string, with its placeholders", () => {
  const keys = Object.keys(SUPPORT_TEXT.en) as (keyof typeof SUPPORT_TEXT.en)[];
  for (const lang of LANGS) {
    for (const k of keys) assert.ok(SUPPORT_TEXT[lang][k]?.trim(), `${lang}.${k}`);
    assert.match(SUPPORT_TEXT[lang].intro, /\{user\}/, `${lang}.intro`);
    assert.match(SUPPORT_TEXT[lang].handedOff, /\{mods\}/, `${lang}.handedOff`);
    assert.match(SUPPORT_TEXT[lang].already, /\{link\}/, `${lang}.already`);
    assert.match(SUPPORT_TEXT[lang].opened, /\{link\}/, `${lang}.opened`);
  }
});

test("the panel carries the open button in the member's language", () => {
  const p = supportPanel("ja");
  assert.match(p.content, /お困りですか/);
  const button = p.components[0].toJSON().components[0] as { custom_id: string; label: string };
  assert.equal(button.custom_id, SUPPORT_OPEN);
  assert.equal(button.label, SUPPORT_TEXT.ja.openButton);
});

test("an answer goes back as parsed, and a refusal hands off", async () => {
  const reply = { reply: "Press Verify my UID in any 🔒 channel.", answered: true, handoff: false, summary: "how to verify" };
  const fake = (out: unknown, stop = "end_turn") => ({ messages: { parse: async () => ({ stop_reason: stop, parsed_output: out }) } });
  const a = await new SupportAssistant("test", fake(reply) as never, "faq").answer("en", [{ from: "member", text: "how do I verify?" }]);
  assert.deepEqual(a, Answer.parse(reply));
  const r = await new SupportAssistant("test", fake(null, "refusal") as never, "faq").answer("en", [{ from: "member", text: "?" }]);
  assert.equal(r.handoff, true);
});

test("the member's latest screenshots go to the model as images", async () => {
  let sent: any;
  const client = { messages: { parse: async (p: unknown) => ((sent = p), { stop_reason: "end_turn", parsed_output: { reply: "ok", answered: true, handoff: false, summary: "" } }) } };
  const urls = ["https://cdn/1.png", "https://cdn/2.png", "https://cdn/3.png", "https://cdn/4.png"];
  await new SupportAssistant("test", client as never, "faq").answer("en", [{ from: "member", text: "this error", images: urls }]);
  const content = sent.messages[0].content;
  assert.deepEqual(content.filter((c: any) => c.type === "image").map((c: any) => c.source.url), urls.slice(-3));
  assert.match(content.at(-1).text, /4 screenshot\(s\) attached/);
});
