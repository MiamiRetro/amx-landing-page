import { ChannelType, type TextChannel } from "discord.js";
import { Db } from "../src/db/index.js";
import { connect } from "../src/lib/client.js";
async function main() {
  const { client, guild } = await connect();
  const db = new Db();
  try {
    const { data } = await db.sb.from("message_map").select("source_channel_id");
    const counts: Record<string, number> = {};
    for (const r of data ?? []) counts[r.source_channel_id] = (counts[r.source_channel_id] ?? 0) + 1;
    console.log("map rows by source:", Object.entries(counts).map(([id, n]) => `${guild.channels.cache.get(id)?.name ?? id}=${n}`).join(", ") || "none");
    for (const name of ["💬・general", "💬・general-zh", "💬・general-ko", "💬・general-id"]) {
      const ch = guild.channels.cache.find((c): c is TextChannel => c.type === ChannelType.GuildText && c.name === name)!;
      const msgs = await ch.messages.fetch({ limit: 2 });
      console.log(`#${name}:`);
      for (const m of [...msgs.values()].reverse()) console.log(`   ${m.createdAt.toISOString().slice(11, 19)} ${m.webhookId ? "[webhook]" : m.author.bot ? "[bot]" : "[user]"} ${m.author.username}: ${m.content.slice(0, 70)}`);
    }
  } finally { await client.destroy(); }
}
main();
