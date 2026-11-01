/**
 * Copies the replies of the old forum posts into the academy threads the onboarding academy step made for
 * them, oldest first, under each author's name and avatar, with attachments, through the academy webhook
 * (the mirror then translates them like any post). Guides and strategies get every reply; the old 🧵 forums
 * discussions get their latest 50, after a note that older discussion is archived (JT, 1 Nov).
 *
 *   npx tsx scripts/academy-replies.ts            # dry run: counts per post
 *   npx tsx scripts/academy-replies.ts --apply
 *
 * Progress is kept per post (settings academy_replies:<old thread id>), so a rerun only copies what is left.
 */
import { ChannelType, type ForumChannel, type Message } from "discord.js";
import { connect } from "../src/lib/client.js";
import { Db } from "../src/db/index.js";
const apply = process.argv.includes("--apply");
const { client, guild } = await connect();
const db = new Db();
try {
  const archive = guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name === "🗄️ ARCHIVE")!;
  // Guides and strategies: every reply. The old 🧵 forums discussions: a note, then their latest 50 (JT, 05:11 UTC).
  const olds = guild.channels.cache.filter((c): c is ForumChannel => c.type === ChannelType.GuildForum && c.parentId === archive.id);
  const LATEST = 50;
  const academy = guild.channels.cache.find((c): c is ForumChannel => c.type === ChannelType.GuildForum && c.name === "┗🎓・academy")!;
  const hook = (await academy.fetchWebhooks()).find((h) => h.name === "BLKBöX Academy" && h.token);
  let total = 0, posted = 0;
  for (const forum of olds.values()) {
    const threads = [...(await forum.threads.fetchActive()).threads.filter((t) => t.parentId === forum.id).values(), ...(await forum.threads.fetchArchived({ fetchAll: true })).threads.values()];
    for (const t of threads) {
      const target = await db.getSetting(guild.id, `academy_moved:${t.id}`);
      if (!target || target.startsWith("skipped")) continue;
      const all: Message[] = []; let before: string | undefined;
      for (;;) { const p = await t.messages.fetch({ limit: 100, before }); if (!p.size) break; all.push(...p.values()); before = p.last()!.id; }
      const discussion = /forums/.test(forum.name);
      const every = all.filter((m) => m.id !== t.id && !m.system && (m.content.trim() || m.attachments.size || m.embeds.length)).reverse();
      const replies = discussion ? every.slice(-LATEST) : every;
      const done = Number((await db.getSetting(guild.id, `academy_replies:${t.id}`)) ?? 0);
      total += replies.length;
      console.log(`  "${t.name}" (#${forum.name}): ${replies.length}${discussion ? ` latest of ${every.length}` : ""} replies${done ? `, ${done} already copied` : ""}`);
      if (!apply || !hook) continue;
      if (discussion && every.length > replies.length && !(await db.getSetting(guild.id, `academy_note:${t.id}`))) {
        await hook.send({ threadId: target, content: `📜 *Older discussion from this thread is archived. Here are the latest ${replies.length} of ${every.length} messages.*`, username: "BLKBöX Academy", allowedMentions: { parse: [] } });
        await db.setSetting(guild.id, `academy_note:${t.id}`, "1");
      }
      for (const [i, m] of replies.entries()) {
        if (i < done) continue;
        await hook.send({
          threadId: target,
          content: m.content || "​",
          files: [...m.attachments.values()].map((a) => ({ attachment: a.url, name: a.name })),
          embeds: m.embeds.filter((e) => !e.data.type || e.data.type === "rich").map((e) => e.toJSON()),
          username: (m.member?.displayName ?? m.author.displayName ?? m.author.username).slice(0, 80),
          avatarURL: m.author.displayAvatarURL(),
          allowedMentions: { parse: [] },
        });
        await db.setSetting(guild.id, `academy_replies:${t.id}`, String(i + 1));
        posted++;
        await new Promise((r) => setTimeout(r, 2500));
      }
    }
  }
  console.log(`${total} replies in moved posts; ${apply ? `${posted} copied now` : "dry run"}; academy webhook ${hook ? "found" : "MISSING"}`);
} finally { await client.destroy(); }
