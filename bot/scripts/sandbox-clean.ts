/** Deletes every message in the sandbox channels and clears their message_map rows. */
import type { TextChannel } from "discord.js";
import { Db } from "../src/db/index.js";
import { connect } from "../src/lib/client.js";
async function main() {
  const { client, guild } = await connect();
  const db = new Db();
  try {
    const group = (await db.loadGroups(guild.id)).find((g) => g.name === "mirror-test");
    if (!group) throw new Error("no sandbox group");
    for (const m of group.members) {
      const ch = (await guild.channels.fetch(m.channel_id)) as TextChannel;
      let total = 0;
      for (;;) {
        const batch = await ch.messages.fetch({ limit: 100 });
        if (batch.size === 0) break;
        const deleted = await ch.bulkDelete(batch, true);
        total += deleted.size;
        if (deleted.size === 0) break;
      }
      await db.sb.from("message_map").delete().eq("source_channel_id", m.channel_id);
      await db.setLastSeen(m.channel_id, "0").catch(() => {});
      console.log(`${m.lang}: deleted ${total}`);
    }
  } finally { await client.destroy(); }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
