/**
 * Moves the recent history of the archived 📈・trader-chat into the topic channels of the new layout
 * (stocks talk to 📊・stocks, altcoin charts to 🪙・crypto, and so on), so the archive can go (JT, 1 Nov).
 *
 *   npx tsx scripts/trader-sort.ts export [--days 14] [--out backups/trader-chat-export.json]
 *       Read-only. Writes every message of the last N days from the English 📈・trader-chat in 🗄️ ARCHIVE
 *       (the zh/ko/id posts are in it too, as the mirror's English copies), with reply links, plus the
 *       candidate target channels with their ids.
 *
 *   npx tsx scripts/trader-sort.ts copy --plan backups/trader-sort-plan.json [--apply]
 *       Copies the planned messages, oldest first, through a "BLKBöX Archive" webhook in each target channel,
 *       under each author's name and avatar, with attachments. Dry run without --apply.
 *       Plan: { "targets": { "<channel key>": "<channel id>" }, "messages": { "<message id>": "<channel key>" | "skip" } }
 *       A reply carries a one-line quote of its parent, since webhooks can't reply. Each target channel gets a
 *       note first saying where the messages came from, and a date line whenever the day changes.
 *       The mirror then translates the copies into the other languages like any post.
 *
 * Progress is kept per message (settings trader_sort:<message id>), so a rerun only copies what is left.
 * Nothing in the archive is changed or deleted.
 */
import { writeFileSync, readFileSync } from "node:fs";
import { ChannelType, type Message, type TextChannel, type Webhook } from "discord.js";
import { connect } from "../src/lib/client.js";
import { Db } from "../src/db/index.js";

const mode = process.argv[2];
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : undefined;
}
const apply = process.argv.includes("--apply");
const SOURCE = "📈・trader-chat";
const ARCHIVE = "🗄️ ARCHIVE";
const HOOK = "BLKBöX Archive";
/** English channel names of the layout that trader-chat history can land in. */
const CANDIDATES = ["🟠・bitcoin", "🪙・crypto", "📊・stocks", "🛢️・commodities", "💬・general", "😂・memes", "📗・trading-strategies"];

const name = (m: Message) => (m.member?.displayName ?? m.author.displayName ?? m.author.username).slice(0, 80);
const day = (d: Date) => d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchSince(ch: TextChannel, since: number): Promise<Message[]> {
  const out: Message[] = [];
  let before: string | undefined;
  for (;;) {
    const page = await ch.messages.fetch({ limit: 100, before });
    if (!page.size) break;
    for (const m of page.values()) if (m.createdTimestamp >= since) out.push(m);
    before = page.last()!.id;
    if (page.last()!.createdTimestamp < since) break;
  }
  return out.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
}

const { client, guild } = await connect();
try {
  const archive = guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name === ARCHIVE);
  if (!archive) throw new Error(`no ${ARCHIVE} category`);
  const source = guild.channels.cache.find((c): c is TextChannel => c.type === ChannelType.GuildText && c.name === SOURCE && c.parentId === archive.id);
  if (!source) throw new Error(`no #${SOURCE} in ${ARCHIVE}`);

  if (mode === "export") {
    const days = Number(arg("days") ?? 14);
    const since = Date.now() - days * 86_400_000;
    const msgs = await fetchSince(source, since);
    const candidates = guild.channels.cache
      .filter((c) => c.type === ChannelType.GuildText && CANDIDATES.includes(c.name.replace(/^[┏┣┗━\s]+/, "")) && c.parentId !== archive.id)
      .map((c) => ({ id: c.id, name: c.name, category: c.parent?.name ?? null }));
    const out = {
      source: { id: source.id, name: source.name },
      since: new Date(since).toISOString(),
      exported: new Date().toISOString(),
      candidates,
      messages: msgs
        .filter((m) => !m.system)
        .map((m) => ({
          id: m.id,
          at: m.createdAt.toISOString(),
          author: name(m),
          authorId: m.author.id,
          bot: m.author.bot,
          webhook: m.webhookId ? true : undefined,
          replyTo: m.reference?.messageId,
          content: m.content,
          attachments: m.attachments.size ? [...m.attachments.values()].map((a) => ({ name: a.name, type: a.contentType })) : undefined,
          embeds: m.embeds.length ? m.embeds.map((e) => ({ type: e.data.type, title: e.title, url: e.url, description: e.description?.slice(0, 300) })) : undefined,
          stickers: m.stickers.size ? [...m.stickers.values()].map((s) => s.name) : undefined,
          thread: m.hasThread ? m.thread?.name : undefined,
        })),
    };
    const file = arg("out") ?? "backups/trader-chat-export.json";
    writeFileSync(file, JSON.stringify(out, null, 1));
    console.log(`${out.messages.length} messages since ${out.since} from #${source.name} → ${file}`);
    console.log("candidate targets:", candidates.map((c) => `${c.name} (${c.category}) ${c.id}`).join("; "));
  } else if (mode === "copy") {
    const planFile = arg("plan");
    if (!planFile) throw new Error("--plan <file> is required");
    const plan = JSON.parse(readFileSync(planFile, "utf8")) as { targets: Record<string, string>; messages: Record<string, string> };
    const db = new Db();
    const ids = Object.keys(plan.messages).filter((id) => plan.messages[id] !== "skip");
    const msgs = new Map<string, Message>();
    for (const id of ids) {
      const m = await source.messages.fetch(id).catch(() => null);
      if (m) msgs.set(id, m);
      else console.log(`  ${id}: gone from the archive, skipped`);
    }
    const ordered = [...msgs.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    const byTarget = new Map<string, Message[]>();
    for (const m of ordered) {
      const key = plan.messages[m.id]!;
      if (!plan.targets[key]) throw new Error(`message ${m.id}: no channel id for target "${key}"`);
      byTarget.set(key, [...(byTarget.get(key) ?? []), m]);
    }
    for (const [key, list] of byTarget) {
      const ch = (await guild.channels.fetch(plan.targets[key]!)) as TextChannel;
      console.log(`#${ch.name}: ${list.length} messages, ${day(list[0]!.createdAt)} to ${day(list.at(-1)!.createdAt)}`);
    }
    if (!apply) {
      console.log(`dry run: ${ordered.length} messages to copy, ${Object.values(plan.messages).filter((t) => t === "skip").length} skipped`);
    } else {
      let posted = 0;
      for (const [key, list] of byTarget) {
        const ch = (await guild.channels.fetch(plan.targets[key]!)) as TextChannel;
        const hook: Webhook = (await ch.fetchWebhooks()).find((h) => h.name === HOOK && h.token) ?? (await ch.createWebhook({ name: HOOK, reason: "trader-chat history move (JT, 1 Nov)" }));
        const send = (content: string) => hook.send({ content, username: HOOK, allowedMentions: { parse: [] } });
        if (!(await db.getSetting(guild.id, `trader_sort_note:${ch.id}`))) {
          await send(`📜 *Moved here from the old trader chat: ${list.length} messages from ${day(list[0]!.createdAt)} to ${day(list.at(-1)!.createdAt)}. They were posted on the dates shown.*`);
          await db.setSetting(guild.id, `trader_sort_note:${ch.id}`, "1");
        }
        let lastDay = "";
        for (const m of list) {
          const d = day(m.createdAt);
          if (await db.getSetting(guild.id, `trader_sort:${m.id}`)) { lastDay = d; continue; }
          if (d !== lastDay) { await send(`── ${d} ──`); lastDay = d; await sleep(1500); }
          const parent = m.reference?.messageId ? msgs.get(m.reference.messageId) : undefined;
          let quote = "";
          if (parent) {
            const snippet = (parent.content || (parent.attachments.size ? "📎 image" : "")).replace(/\s+/g, " ").slice(0, 80);
            quote = `> ↪ **${name(parent)}**: ${snippet}${parent.content.length > 80 ? "…" : ""}\n`;
          }
          const content = (quote.length + m.content.length <= 2000 ? quote : "") + m.content;
          const sent = await hook.send({
            content: content || "​",
            files: [...m.attachments.values()].map((a) => ({ attachment: a.url, name: a.name })),
            embeds: m.embeds.filter((e) => !e.data.type || e.data.type === "rich").map((e) => e.toJSON()),
            username: name(m),
            avatarURL: m.author.displayAvatarURL(),
            allowedMentions: { parse: [] },
          });
          await db.setSetting(guild.id, `trader_sort:${m.id}`, sent.id);
          posted++;
          // One at a time, so the mirror translates each before the next lands.
          await sleep(2500);
        }
      }
      console.log(`${posted} copied now`);
    }
  } else {
    console.log("usage: trader-sort.ts export [--days 14] [--out file] | copy --plan file [--apply]");
  }
} finally {
  await client.destroy();
}
