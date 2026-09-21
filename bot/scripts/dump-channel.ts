import { ChannelType, type TextChannel } from "discord.js";
import { connect } from "../src/lib/client.js";
async function main() {
  const { client, guild } = await connect();
  try {
    const ch = guild.channels.cache.find((c): c is TextChannel => (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement) && c.name === process.argv[2]);
    if (!ch) throw new Error("channel not found");
    console.log(`#${ch.name} (${ch.id}) topic=${ch.topic ?? ""}`);
    const msgs = [...(await ch.messages.fetch({ limit: 100 })).values()].sort((a, b) => Number(BigInt(a.id) - BigInt(b.id)));
    for (const m of msgs) {
      console.log(`\n=== ${m.createdAt.toISOString().slice(0, 10)} ${m.author.username}${m.webhookId ? " [webhook]" : m.author.bot ? " [bot]" : ""}${m.pinned ? " [pinned]" : ""} id=${m.id}`);
      if (m.content) console.log(m.content);
      for (const e of m.embeds) console.log("  EMBED:", JSON.stringify({ title: e.title, description: e.description, url: e.url, fields: e.fields, image: e.image?.url, thumbnail: e.thumbnail?.url, footer: e.footer?.text, color: e.color, author: e.author?.name }, null, 1));
      for (const a of m.attachments.values()) console.log("  ATTACHMENT:", a.name, a.url);
      for (const row of m.components) console.log("  COMPONENTS:", JSON.stringify(row.toJSON()));
    }
  } finally { await client.destroy(); }
}
main().catch((e) => { console.error(e.message); process.exit(1); });
