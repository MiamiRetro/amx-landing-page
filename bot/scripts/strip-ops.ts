/** Removes personal ops overwrites from every channel inside the language categories and re-syncs them to the category. */
import { ChannelType } from "discord.js";
import { connect } from "../src/lib/client.js";
import { opsUserIds } from "../src/lib/layout.js";
async function main() {
  const { client, guild } = await connect();
  try {
    const cats = guild.channels.cache.filter((c) => c.type === ChannelType.GuildCategory && /中文|한국어|Bahasa Indonesia/.test(c.name));
    for (const cat of cats.values()) {
      for (const ch of guild.channels.cache.filter((c) => c.parentId === cat.id).values()) {
        if (!("permissionOverwrites" in ch) || !("lockPermissions" in ch)) continue;
        for (const id of opsUserIds()) if (ch.permissionOverwrites.cache.has(id)) await ch.permissionOverwrites.delete(id, "remove personal ops access");
        await ch.lockPermissions();
        console.log(`synced #${ch.name}`);
      }
    }
  } finally { await client.destroy(); }
}
main().catch((e) => { console.error(e.message); process.exit(1); });
