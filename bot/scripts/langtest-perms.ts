import { ChannelType, OverwriteType, PermissionFlagsBits, type TextChannel } from "discord.js";
import { connect } from "../src/lib/client.js";
import { opsUserIds } from "../src/lib/layout.js";
async function main() {
  const { client, guild } = await connect();
  try {
    const ch = guild.channels.cache.find((c): c is TextChannel => c.type === ChannelType.GuildText && c.name === "language-test");
    if (!ch) { console.log("no #language-test"); return; }
    const mods = guild.roles.cache.find((r) => r.name === "Moderators")!;
    for (const id of opsUserIds()) if (ch.permissionOverwrites.cache.has(id)) await ch.permissionOverwrites.delete(id, "no personal overwrites");
    await ch.permissionOverwrites.edit(mods.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true }, { type: OverwriteType.Role, reason: "moderators may test the picker" });
    console.log("language-test: personal access removed, Moderators granted");
    console.log("sandbox channels present:", guild.channels.cache.filter((c) => c.name.startsWith("mirror-test")).size);
  } finally { await client.destroy(); }
}
main();
