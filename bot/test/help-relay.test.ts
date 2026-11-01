import { test } from "node:test";
import assert from "node:assert/strict";
import type { Lang } from "../src/config.js";
import { SupportDesk, type ThreadTranslator } from "../src/support/desk.js";

/** A translator that tags text with its target, so the test sees which way it went. */
function fakeTranslator(calls: { from: Lang; to: Lang[] }[], ok = true): ThreadTranslator {
  return {
    async translate(segments, _e, from, targets) {
      calls.push({ from, to: targets });
      return { translated: ok, translations: Object.fromEntries(targets.map((t) => [t, segments.map((s) => `[${t}] ${s}`)])) as Record<Lang, string[]> };
    },
  };
}

function fakeMessage(authorId: string, content: string) {
  const replies: any[] = [];
  return { replies, m: { author: { id: authorId }, content, channelId: "t1", reply: async (r: any) => { replies.push(r); } } as any };
}

const relay = (desk: SupportDesk, m: any, lang: Lang) => (desk as any).relay(m, { userId: "member", lang, handedOff: true });

test("a member's message is translated into English for the team", async () => {
  const calls: any[] = [];
  const desk = new SupportDesk({} as any, {} as any, {} as any, "bot", null, fakeTranslator(calls));
  const { m, replies } = fakeMessage("member", "我的 UID 验证不了");
  await relay(desk, m, "zh");
  assert.deepEqual(calls, [{ from: "zh", to: ["en"] }]);
  assert.equal(replies[0].embeds[0].description, "[en] 我的 UID 验证不了");
  assert.match(replies[0].embeds[0].footer.text, /🇬🇧 Auto-translated for the team/);
});

test("a team reply is translated into the member's language", async () => {
  const calls: any[] = [];
  const desk = new SupportDesk({} as any, {} as any, {} as any, "bot", null, fakeTranslator(calls));
  const { m, replies } = fakeMessage("mod", "Please send your UID again");
  await relay(desk, m, "ko");
  assert.deepEqual(calls, [{ from: "en", to: ["ko"] }]);
  assert.equal(replies[0].embeds[0].description, "[ko] Please send your UID again");
  assert.match(replies[0].embeds[0].footer.text, /🇰🇷 자동 번역/);
});

test("English threads, failed translations and unchanged text post nothing", async () => {
  const calls: any[] = [];
  const en = new SupportDesk({} as any, {} as any, {} as any, "bot", null, fakeTranslator(calls));
  const a = fakeMessage("member", "hello");
  await relay(en, a.m, "en");
  assert.equal(a.replies.length, 0);
  assert.equal(calls.length, 0);

  const failing = new SupportDesk({} as any, {} as any, {} as any, "bot", null, fakeTranslator([], false));
  const b = fakeMessage("member", "你好");
  await relay(failing, b.m, "zh");
  assert.equal(b.replies.length, 0);

  const same: ThreadTranslator = { async translate(s, _e, _f, t) { return { translated: true, translations: Object.fromEntries(t.map((x) => [x, s])) as any }; } };
  const c = fakeMessage("member", "BTC 100k");
  await relay(new SupportDesk({} as any, {} as any, {} as any, "bot", null, same), c.m, "zh");
  assert.equal(c.replies.length, 0);
});
