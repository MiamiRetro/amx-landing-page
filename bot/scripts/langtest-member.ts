import { ChannelType, OverwriteType, type TextChannel } from "discord.js";
import { connect } from "../src/lib/client.js";
async function main() {
  const { client, guild } = await connect();
  try {
    const ch = guild.channels.cache.find((c): c is TextChannel => c.type === ChannelType.GuildText && c.name === "language-test")!;
    const member = guild.roles.cache.find((r) => r.name === "Member")!;
    await ch.permissionOverwrites.edit(member.id, { ViewChannel: true, ReadMessageHistory: true, SendMessages: false }, { type: OverwriteType.Role, reason: "owner: Member may see the picker test" });
    console.log(`#language-test now visible to role "${member.name}"`);
  } finally { await client.destroy(); }
}
main();
