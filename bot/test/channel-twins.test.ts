import { test } from "node:test";
import assert from "node:assert/strict";
import type { Lang } from "../src/config.js";
import type { MapRow } from "../src/db/index.js";
import { remapForTarget } from "../src/mirror/render.js";
import { translateForReader } from "../src/support/relay.js";

const GUILD = "900";
// Two mirror groups: alphanumetrix (en 100 / ja 101 / ko 102) and academy forums (en 200 / ja 201).
const members: Record<string, { group: string; lang: Lang }> = {
  "100": { group: "alpha", lang: "en" }, "101": { group: "alpha", lang: "ja" }, "102": { group: "alpha", lang: "ko" },
  "200": { group: "academy", lang: "en" }, "201": { group: "academy", lang: "ja" },
};
const groups = {
  lookup: (id: string) => (members[id] ? ({ member: { channel_id: id, lang: members[id].lang } } as never) : null),
  twin: (id: string, lang: Lang) => {
    const g = members[id]?.group;
    return Object.entries(members).find(([, m]) => m.group === g && m.lang === lang)?.[0] ?? null;
  },
};
// Forum post 300 (en academy) mirrored as post 301 in ja academy; reply 310 in it mirrored as 311.
const rows: MapRow[] = [
  { source_message_id: "300", source_channel_id: "200", target_channel_id: "201", mirror_message_id: "301", lang: "ja", source_thread_id: "300", target_thread_id: "301" },
  { source_message_id: "310", source_channel_id: "200", target_channel_id: "201", mirror_message_id: "311", lang: "ja", source_thread_id: "300", target_thread_id: "301" },
  { source_message_id: "400", source_channel_id: "100", target_channel_id: "101", mirror_message_id: "401", lang: "ja" },
];
const db = {
  mirrorsOf: async (id: string) => rows.filter((r) => r.source_message_id === id),
  sourceOf: async (id: string) => rows.find((r) => r.mirror_message_id === id) ?? null,
};
const remap = (t: string, lang: Lang, target: string | null = null) => remapForTarget(t, db as never, groups as never, GUILD, lang, target);

test("an English channel tag becomes the reader's language twin", async () => {
  assert.equal(await remap("signals live in <#100> now", "ja"), "signals live in <#101> now");
  assert.equal(await remap("見て <#101>", "en"), "見て <#100>");
  assert.equal(await remap("<#100> and <#100>", "ko"), "<#102> and <#102>");
});

test("a channel with no language twin stays as it is", async () => {
  assert.equal(await remap("rules: <#999>", "ja"), "rules: <#999>");
  // a group with no channel in the reader's language
  assert.equal(await remap("<#100>", "vi"), "<#100>");
});

test("a mirrored forum post tag points at the same post in the reader's forum", async () => {
  assert.equal(await remap("read <#300>", "ja"), "read <#301>");
  assert.equal(await remap("read <#301>", "en"), "read <#300>");
});

test("channel, post and message links follow the reader's language", async () => {
  assert.equal(await remap(`https://discord.com/channels/${GUILD}/100`, "ja"), `https://discord.com/channels/${GUILD}/101`);
  assert.equal(await remap(`see https://discord.com/channels/${GUILD}/100/400 ok`, "ja"), `see https://discord.com/channels/${GUILD}/101/401 ok`);
  assert.equal(await remap(`https://discord.com/channels/${GUILD}/300/310`, "ja"), `https://discord.com/channels/${GUILD}/301/311`);
  assert.equal(await remap(`https://discord.com/channels/1/100/400`, "ja"), `https://discord.com/channels/1/100/400`, "other servers untouched");
});

test("help-thread translations keep channel tags intact and re-point them", async () => {
  let seen: { text: string; entities: string[] } | null = null;
  const translator = {
    translate: async (segs: string[], ents: string[][], _f: Lang, to: Lang[]) => {
      seen = { text: segs[0], entities: ents[0] };
      return { translations: { [to[0]]: [segs[0].replace("check", "確認して")] } as Record<Lang, string[]>, translated: true };
    },
  };
  const localize = (t: string, lang: Lang) => remap(t, lang);
  const r = await translateForReader(translator, "check <#100>", "en", "ja", localize);
  assert.equal(r.text, "確認して <#101>");
  assert.ok(r.translated);
  assert.deepEqual(seen!.entities, ["<#100>"], "the tag is protected from the translator");
  // translation down: original words, tag still re-pointed
  const down = { translate: async () => { throw new Error("down"); } };
  assert.deepEqual(await translateForReader(down, "check <#100>", "en", "ja", localize), { text: "check <#101>", translated: false });
});
