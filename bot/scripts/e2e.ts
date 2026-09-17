/**
 * End-to-end check against the running bot and the sandbox group.
 * Posts through a temporary webhook (so the bot treats it as a foreign message),
 * then verifies mirrors, edit propagation and delete propagation.
 *
 *   npx tsx scripts/e2e.ts
 */
import { ChannelType, type Message, type TextChannel } from "discord.js";
import { Db } from "../src/db/index.js";
import { connect } from "../src/lib/client.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
}

async function latest(ch: TextChannel, n = 3): Promise<Message[]> {
  const msgs = await ch.messages.fetch({ limit: n });
  return [...msgs.values()].sort((a, b) => Number(BigInt(b.id) - BigInt(a.id)));
}

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs = 25_000): Promise<T | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await sleep(1500);
  }
  return null;
}

async function main() {
  const { client, guild } = await connect();
  const db = new Db();
  try {
    const groups = await db.loadGroups(guild.id);
    const group = groups.find((g) => g.name === "mirror-test");
    if (!group) throw new Error("sandbox group missing; run scripts/sandbox.ts first");
    const chan = async (lang: string) => (await guild.channels.fetch(group.members.find((m) => m.lang === lang)!.channel_id)) as TextChannel;
    const en = await chan("en"), zh = await chan("zh"), ko = await chan("ko"), id = await chan("id");
    const twins = { zh, ko, id };

    const ops = (process.env.OPS_USER_IDS ?? "").split(",")[0]?.trim();
    const poster = await en.createWebhook({ name: "e2e poster", reason: "mirror e2e" });
    const posterKo = await ko.createWebhook({ name: "e2e poster", reason: "mirror e2e" });
    try {
      // 1. create
      const text = `e2e ${Date.now()}: BTC reclaimed 100k 🔥 ${ops ? `<@${ops}>` : ""} see <#${zh.id}> and $BTC https://tradingview.com/x/aB3k9Q **bold** \`code\``;
      const src = await poster.send({ content: text, username: "E2E Tester", avatarURL: "https://cdn.discordapp.com/embed/avatars/3.png" });
      console.log("posted source", src.id);

      const mirrors: Record<string, Message | null> = {};
      for (const [lang, ch] of Object.entries(twins)) {
        mirrors[lang] = await waitFor(async () => (await latest(ch)).find((m) => m.webhookId && m.content.includes(`e2e ${text.slice(4, 17)}`)) ?? null);
        const m = mirrors[lang];
        check(`mirror appeared in ${lang}`, !!m, m ? m.id : "not found in 25s");
        if (!m) continue;
        check(`${lang}: author name carried`, m.author.username === "E2E Tester", m.author.username);
        check(`${lang}: avatar carried`, !!m.author.avatar, m.author.avatar ?? "none");
        check(`${lang}: url intact`, m.content.includes("https://tradingview.com/x/aB3k9Q"));
        check(`${lang}: ticker intact`, m.content.includes("$BTC"));
        check(`${lang}: markdown intact`, m.content.includes("**bold**") && m.content.includes("`code`"));
        if (ops) check(`${lang}: user mention intact`, m.content.includes(`<@${ops}>`));
        const expectedChan = group.members.find((mm) => mm.lang === lang)!.channel_id;
        check(`${lang}: channel mention remapped to own twin`, m.content.includes(`<#${expectedChan}>`), m.content.match(/<#\d+>/)?.[0] ?? "none");
      }
      const rows = await db.mirrorsOf(src.id);
      check("message_map has 3 rows", rows.length === 3, String(rows.length));

      // 2. edit
      await poster.editMessage(src.id, { content: text + " EDITED" });
      const edited = await waitFor(async () => {
        const m = await zh.messages.fetch({ message: mirrors.zh!.id, force: true }).catch(() => null);
        return m && m.content.endsWith("EDITED") ? m : null;
      });
      check("edit propagated to zh", !!edited);

      // 3. reverse direction: post in ko, expect en/zh/id
      const rev = await posterKo.send({ content: `e2e-rev ${Date.now()} 안녕 from ko`, username: "KO Tester" });
      const revEn = await waitFor(async () => (await latest(en)).find((m) => m.webhookId && m.content.includes("e2e-rev")) ?? null);
      check("reverse mirror ko → en", !!revEn, revEn?.author.username ?? "");
      const revId = await waitFor(async () => (await latest(id)).find((m) => m.webhookId && m.content.includes("e2e-rev")) ?? null);
      check("reverse mirror ko → id", !!revId);

      // 4. reply header
      const reply = await poster.send({ content: `e2e-reply ${Date.now()} replying`, username: "E2E Tester" });
      // webhooks cannot reply natively; instead test delete propagation on this one
      await sleep(4000);

      // 5. delete original → mirrors gone
      await poster.deleteMessage(src.id);
      const gone = await waitFor(async () => {
        const m = await zh.messages.fetch({ message: mirrors.zh!.id, force: true }).catch(() => null);
        return m ? null : true;
      });
      check("delete propagated to zh", !!gone);

      // 6. delete a mirror → original gone
      const replyMirror = await waitFor(async () => (await latest(ko)).find((m) => m.webhookId && m.content.includes("e2e-reply")) ?? null);
      if (replyMirror) {
        await replyMirror.delete();
        const origGone = await waitFor(async () => ((await en.messages.fetch({ message: reply.id, force: true }).catch(() => null)) ? null : true));
        check("deleting a mirror deletes the original", !!origGone);
      } else check("reply message mirrored to ko", false);

      // cleanup rev
      await posterKo.deleteMessage(rev.id).catch(() => {});
      await sleep(3000);
    } finally {
      await poster.delete("e2e cleanup").catch(() => {});
      await posterKo.delete("e2e cleanup").catch(() => {});
    }
    console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
  } finally {
    await client.destroy();
  }
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });
