import type { TextChannel } from "discord.js";
import { Db } from "../src/db/index.js";
import { connect } from "../src/lib/client.js";
async function main() {
  const { client, guild } = await connect();
  const db = new Db();
  try {
    const { data } = await db.sb.from("message_map").select("*").eq("source_channel_id", process.env.SRC ?? "").order("created_at", { ascending: false }).limit(3);
    for (const r of data ?? []) {
      const src = (await guild.channels.fetch(r.source_channel_id)) as TextChannel;
      const tgt = (await guild.channels.fetch(r.target_channel_id)) as TextChannel;
      const s = await src.messages.fetch(r.source_message_id).catch(() => null);
      const t = await tgt.messages.fetch(r.mirror_message_id).catch(() => null);
      console.log(`${r.created_at.slice(11, 19)} #${src.name} "${s?.content}" -> #${tgt.name} "${t?.content}"`);
    }
  } finally { await client.destroy(); }
}
main();
