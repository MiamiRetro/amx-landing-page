import { ChannelType, type TextChannel } from "discord.js";
import { connect } from "../src/lib/client.js";
async function main() {
  const { client, guild } = await connect();
  try {
    const ch = guild.channels.cache.find((c): c is TextChannel => c.type === ChannelType.GuildText && c.name === process.argv[2]);
    if (!ch) { console.log("channel not found"); return; }
    console.log(`#${ch.name} exists, id ${ch.id}`);
    for (const o of ch.permissionOverwrites.cache.values()) console.log(`  ${o.type === 1 ? "member" : "role"} ${guild.roles.cache.get(o.id)?.name ?? o.id}: allow=${o.allow.toArray().join("|") || "-"} deny=${o.deny.toArray().join("|") || "-"}`);
  } finally { await client.destroy(); }
}
main();
