import { test } from "node:test";
import assert from "node:assert/strict";
import { LANGS } from "../src/config.js";
import { Answer, loadFaq, SupportAssistant, systemPrompt } from "../src/support/assistant.js";
import { existsSync } from "node:fs";
import { SUPPORT_OPEN, supportPanel } from "../src/support/desk.js";
import { GUIDES, guideFile } from "../src/support/guides.js";
import { SUPPORT_TEXT } from "../src/support/text.js";
import { confirmButtons, scriptMismatch, SWITCH_CANCEL, SWITCH_CONFIRM, SWITCH_PICK, SWITCH_TEXT, switchButtons } from "../src/support/switch.js";
import { pickerMessage } from "../src/picker.js";

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
  const reply = { reply: "Press Verify my UID in any 🔒 channel.", answered: true, handoff: false, offerHuman: false, summary: "how to verify", guides: ["verify"], wrongLanguage: false, switchTo: null };
  const fake = (out: unknown, stop = "end_turn") => ({ messages: { parse: async () => ({ stop_reason: stop, parsed_output: out }) } });
  const a = await new SupportAssistant("test", fake(reply) as never, "faq").answer("en", [{ from: "member", text: "how do I verify?" }]);
  assert.deepEqual(a, Answer.parse(reply));
  const r = await new SupportAssistant("test", fake(null, "refusal") as never, "faq").answer("en", [{ from: "member", text: "?" }]);
  assert.equal(r.handoff, true);
});

test("the member's latest screenshots go to the model as images", async () => {
  let sent: any;
  const client = { messages: { parse: async (p: unknown) => ((sent = p), { stop_reason: "end_turn", parsed_output: { reply: "ok", answered: true, handoff: false, offerHuman: false, summary: "", guides: [] } }) } };
  const urls = ["https://cdn/1.png", "https://cdn/2.png", "https://cdn/3.png", "https://cdn/4.png"];
  await new SupportAssistant("test", client as never, "faq").answer("en", [{ from: "member", text: "this error", images: urls }]);
  const content = sent.messages[0].content;
  assert.deepEqual(content.filter((c: any) => c.type === "image").map((c: any) => c.source.url), urls.slice(-3));
  assert.match(content.at(-1).text, /4 screenshot\(s\) attached/);
});

test("every Guide: line in the FAQ names a guide that has an image", () => {
  const named = [...loadFaq().matchAll(/^Guide: (.+)$/gm)].map((m) => m[1].trim());
  assert.ok(named.length >= 10);
  for (const g of named) assert.ok((GUIDES as readonly string[]).includes(g), `unknown guide ${g}`);
  for (const g of GUIDES) assert.ok(existsSync(guideFile(g, "en")), `missing image for ${g}`);
  // A language without its own render falls back to the English card.
  assert.ok(existsSync(guideFile("scams", "ko")));
});

test("guides come back once each, at most two, and earlier ones show in the thread", async () => {
  let sent: any;
  const out = { reply: "See below.", answered: true, handoff: false, summary: "", guides: ["verify", "verify", "uid", "scams"] };
  const client = { messages: { parse: async (p: unknown) => ((sent = p), { stop_reason: "end_turn", parsed_output: out }) } };
  const a = await new SupportAssistant("test", client as never, "faq").answer("en", [
    { from: "assistant", text: "Here is how to verify.", guides: ["verify"] },
    { from: "member", text: "where is my uid?" },
  ]);
  assert.deepEqual(a.guides, ["verify", "uid"]);
  assert.match(sent.messages[0].content.at(-1).text, /\[guide: verify\]/);
  assert.equal(sent.system[0].cache_control.type, "ephemeral");
});

test("the prompt asks the assistant to spot a member on the wrong language", () => {
  const prompt = systemPrompt("faq", "en");
  assert.match(prompt, /wrongLanguage/);
  assert.match(prompt, /don't speak or understand English/);
});

test("a switch to the thread's own language is no switch", async () => {
  const out = { reply: "ok", answered: true, handoff: false, offerHuman: false, summary: "", guides: [], wrongLanguage: true, switchTo: "ko" };
  const client = { messages: { parse: async () => ({ stop_reason: "end_turn", parsed_output: out }) } };
  const a = await new SupportAssistant("test", client as never, "faq").answer("ko", [{ from: "member", text: "안녕하세요" }]);
  assert.equal(a.switchTo, null);
  const b = await new SupportAssistant("test", client as never, "faq").answer("en", [{ from: "member", text: "안녕하세요" }]);
  assert.equal(b.switchTo, "ko");
  assert.equal(b.wrongLanguage, true);
});

test("the language buttons leave out the current language and put the suggested one first", () => {
  const rows = switchButtons("en", "zh").map((r) => r.toJSON().components as { custom_id: string }[]);
  assert.ok(rows.every((r) => r.length <= 5));
  const ids = rows.flat().map((b) => b.custom_id);
  assert.equal(ids.length, LANGS.length - 1);
  assert.equal(ids[0], `${SWITCH_PICK}zh`);
  assert.ok(!ids.includes(`${SWITCH_PICK}en`));
  const unsure = switchButtons("ja", null).flatMap((r) => r.toJSON().components as { custom_id: string }[]).map((b) => b.custom_id);
  assert.equal(unsure[0], `${SWITCH_PICK}en`);
  // All of them land in the help-desk's button handler, not the picker's.
  for (const id of [...ids, `${SWITCH_CONFIRM}zh`, `${SWITCH_CANCEL}zh`]) assert.ok(id.startsWith("support:"));
  const confirm = confirmButtons("ru")[0].toJSON().components as { custom_id: string; label: string }[];
  assert.deepEqual(confirm.map((b) => b.custom_id), [`${SWITCH_CONFIRM}ru`, `${SWITCH_CANCEL}ru`]);
  assert.equal(confirm[0].label, SWITCH_TEXT.ru.confirmButton);
});

test("every language has every language-switch string, with its placeholders", () => {
  const keys = Object.keys(SWITCH_TEXT.en) as (keyof typeof SWITCH_TEXT.en)[];
  for (const lang of LANGS) {
    for (const k of keys) assert.ok(SWITCH_TEXT[lang][k]?.trim(), `${lang}.${k}`);
    assert.match(SWITCH_TEXT[lang].confirm, /\{lang\}/, `${lang}.confirm`);
    assert.match(SWITCH_TEXT[lang].switched, /\{link\}/, `${lang}.switched`);
    assert.match(SWITCH_TEXT[lang].moved, /\{link\}/, `${lang}.moved`);
    assert.match(SWITCH_TEXT[lang].intro, /\{user\}/, `${lang}.intro`);
  }
});

test("the picker still offers all ten languages in order", () => {
  const ids = pickerMessage().components.flatMap((r) => r.toJSON().components as { custom_id: string }[]).map((b) => b.custom_id);
  assert.deepEqual(ids, LANGS.map((l) => `lang:${l}`));
});

test("the script check spots a sentence in another writing system", () => {
  assert.equal(scriptMismatch("hi i dont speak chinese", "ja"), "en");
  assert.equal(scriptMismatch("我看不懂英文，请帮帮我", "en"), "zh");
  assert.equal(scriptMismatch("영어를 못 해요 도와주세요", "en"), "ko");
  assert.equal(scriptMismatch("Я не говорю по-английски", "en"), "ru");
  assert.equal(scriptMismatch("日本語でお願いします", "zh"), "ja");
  // Fits, or too little to tell.
  assert.equal(scriptMismatch("BTC の UID はどこですか", "ja"), null);
  assert.equal(scriptMismatch("UID 在哪里 https://example.com/long/link", "zh"), null);
  assert.equal(scriptMismatch("ok thx", "ja"), null);
  assert.equal(scriptMismatch("hola, no hablo inglés", "en"), null);
});
