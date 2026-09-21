import type { TextChannel } from "discord.js";
import { Db } from "../src/db/index.js";
import { connect } from "../src/lib/client.js";
async function main() {
  const { client, guild } = await connect();
  const db = new Db();
  try {
    const group = (await db.loadGroups(guild.id)).find((g) => g.name === "mirror-test")!;
    for (const m of group.members) {
      const ch = (await guild.channels.fetch(m.channel_id)) as TextChannel;
      const msgs = await ch.messages.fetch({ limit: 3 });
      console.log(`#${ch.name}:`);
      for (const x of [...msgs.values()].reverse()) console.log(`   ${x.createdAt.toISOString().slice(0, 16)} ${x.webhookId ? "[webhook]" : "[user]"} ${x.author.username}: ${x.content.slice(0, 80)}`);
    }
  } finally { await client.destroy(); }
}
main();
