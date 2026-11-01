import { test } from "node:test";
import assert from "node:assert/strict";
import type { Lang } from "../src/config.js";
import { Concierge } from "../src/support/concierge.js";
import type { ThreadTranslator } from "../src/support/relay.js";

const translator = (calls: { from: Lang; to: Lang[] }[]): ThreadTranslator => ({
  async translate(segments, _e, from, targets) {
    calls.push({ from, to: targets });
    return { translated: true, translations: Object.fromEntries(targets.map((t) => [t, segments.map((s) => `[${t}] ${s}`)])) as Record<Lang, string[]> };
  },
});
const guildWith = (lang: Lang | null) => ({ members: { fetch: async () => ({ lang }) } }) as any;
const rolesFor = { langOf: (m: any) => m.lang } as any;
const msg = (authorId: string, content: string) => {
  const replies: any[] = [];
  return { replies, m: { author: { id: authorId }, content, channelId: "t", reply: async (r: any) => { replies.push(r); } } as any };
};

test("a VIP's message is translated into English for the host", async () => {
  const calls: any[] = [];
  const c = new Concierge(guildWith("ko"), {} as any, "bot", null, rolesFor, translator(calls));
  const { m, replies } = msg("vip", "지갑 보안 상담을 받고 싶어요");
  await (c as any).relay(m, "vip");
  assert.deepEqual(calls, [{ from: "ko", to: ["en"] }]);
  assert.match(replies[0].embeds[0].footer.text, /🇬🇧/);
});

test("the host's English reply is translated into the VIP's language", async () => {
  const calls: any[] = [];
  const c = new Concierge(guildWith("ja"), {} as any, "bot", null, rolesFor, translator(calls));
  const { m, replies } = msg("host", "Happy to help, does Tuesday work?");
  await (c as any).relay(m, "vip");
  assert.deepEqual(calls, [{ from: "en", to: ["ja"] }]);
  assert.equal(replies[0].embeds[0].description, "[ja] Happy to help, does Tuesday work?");
});

test("English VIPs get no translations", async () => {
  const calls: any[] = [];
  const c = new Concierge(guildWith("en"), {} as any, "bot", null, rolesFor, translator(calls));
  const { m, replies } = msg("vip", "hello");
  await (c as any).relay(m, "vip");
  assert.equal(calls.length + replies.length, 0);
});
