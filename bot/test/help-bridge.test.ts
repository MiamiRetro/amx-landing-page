import { test } from "node:test";
import assert from "node:assert/strict";
import type { Lang } from "../src/config.js";
import { SupportDesk } from "../src/support/desk.js";
import type { ThreadTranslator } from "../src/support/relay.js";

const translator: ThreadTranslator = {
  async translate(segments, _e, _from, targets) {
    return { translated: true, translations: Object.fromEntries(targets.map((t) => [t, segments.map((s) => `[${t}] ${s}`)])) as Record<Lang, string[]> };
  },
};
function fakeThread(id: string) {
  const sent: any[] = [];
  return { sent, t: { id, archived: false, isThread: () => true, send: async (x: any) => { sent.push(typeof x === "string" ? { content: x } : x); }, setArchived: async () => {} } as any };
}
const guildWith = (threads: Record<string, any>) => ({ id: "g", channels: { fetch: async (id: string) => threads[id] ?? null } }) as any;
const db = { getSetting: async () => null, setSetting: async () => {} } as any;
const msg = (name: string, content: string) => ({ content, author: { id: "x", username: name }, member: { displayName: name }, attachments: new Map() }) as any;

test("the member's message reaches the team's English twin, translated", async () => {
  const twin = fakeThread("twin");
  const desk = new SupportDesk(guildWith({ twin: twin.t }), db, {} as any, "bot", null, translator);
  await (desk as any).toTeam(msg("Li", "我的UID验证不了"), { userId: "x", lang: "zh" }, "twin");
  assert.match(twin.sent[0].content, /^\*\*Li:\*\* \[en\] 我的UID验证不了/);
  assert.match(twin.sent[0].content, /-# 我的UID验证不了/);
});

test("the team's English reply reaches the member, translated, with the team member's name", async () => {
  const member = fakeThread("m1");
  const desk = new SupportDesk(guildWith({ m1: member.t }), db, {} as any, "bot", null, translator);
  (desk as any).bridgeBack.set("twin", { memberThread: "m1", userId: "u", lang: "ko" });
  await (desk as any).fromTeam(msg("JT", "Send me your UID please"), { id: "twin" });
  assert.equal(member.sent[0].content, "**JT** (BLKBöX team): [ko] Send me your UID please");
});
