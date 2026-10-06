import { ChannelType } from "discord.js";
import { connect } from "../src/lib/client.js";
import { opsUserIds } from "../src/lib/layout.js";
async function main() {
  const { client, guild } = await connect();
  try {
    const hits: string[] = [];
    for (const c of guild.channels.cache.values()) {
      if (!("permissionOverwrites" in c)) continue;
      for (const id of opsUserIds()) if (c.permissionOverwrites.cache.has(id)) hits.push(`${c.type === ChannelType.GuildCategory ? "category" : "channel"} ${c.name}`);
    }
    console.log(hits.length ? hits.join("\n") : "none");
  } finally { await client.destroy(); }
}
main();
