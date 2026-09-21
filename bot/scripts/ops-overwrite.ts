/** Removes or restores the ops-user view overwrite on one category (and its synced channels). */
import { ChannelType, OverwriteType, PermissionFlagsBits, type CategoryChannel } from "discord.js";
import { connect } from "../src/lib/client.js";
import { opsUserIds } from "../src/lib/layout.js";
async function main() {
  const [mode, catName] = process.argv.slice(2);
  const { client, guild } = await connect();
  try {
    const cat = guild.channels.cache.find((c): c is CategoryChannel => c.type === ChannelType.GuildCategory && c.name === catName);
    if (!cat) throw new Error(`category ${catName} not found`);
    for (const id of opsUserIds()) {
      if (mode === "remove") await cat.permissionOverwrites.delete(id, "visibility test");
      else await cat.permissionOverwrites.edit(id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true }, { type: OverwriteType.Member, reason: "restore ops access" });
    }
    for (const ch of guild.channels.cache.filter((c) => c.parentId === cat.id).values()) {
      if ("lockPermissions" in ch) await ch.lockPermissions().catch(() => {});
    }
    console.log(`${mode}d ops overwrite on ${cat.name} (${guild.channels.cache.filter((c) => c.parentId === cat.id).size} channels synced)`);
  } finally { await client.destroy(); }
}
main().catch((e) => { console.error(e.message); process.exit(1); });
