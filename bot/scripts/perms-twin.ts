import { ChannelType, PermissionFlagsBits, type TextChannel } from "discord.js";
import { connect } from "../src/lib/client.js";
async function main() {
  const { client, guild } = await connect();
  try {
    const me = guild.members.me ?? (await guild.members.fetchMe());
    const ch = guild.channels.cache.find((c): c is TextChannel => c.type === ChannelType.GuildText && c.name === "💬・general-zh")!;
    const p = ch.permissionsFor(me);
    const names = ["ViewChannel","ReadMessageHistory","SendMessages","ManageMessages","ManageWebhooks","EmbedLinks","AttachFiles","PinMessages"] as const;
    for (const n of names) { const bit = (PermissionFlagsBits as Record<string, bigint>)[n]; console.log(`${n.padEnd(20)} ${bit === undefined ? "(no such flag)" : p.has(bit) ? "✓" : "✗"}`); }
    console.log("overwrites:", [...ch.permissionOverwrites.cache.values()].map((o) => `${o.type === 1 ? "member" : "role"}:${guild.roles.cache.get(o.id)?.name ?? o.id} allow=${o.allow.toArray().join("|")} deny=${o.deny.toArray().join("|")}`).join("\n            "));
    console.log("synced with category:", ch.permissionsLocked);
  } finally { await client.destroy(); }
}
main();
