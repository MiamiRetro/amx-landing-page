import { ChannelType, PermissionFlagsBits, type TextChannel } from "discord.js";
import { connect } from "../src/lib/client.js";
async function main() {
  const { client, guild } = await connect();
  try {
    for (const name of ["Member", "Members", "New Member", "中文", "한국어", "Bahasa Indonesia", "@everyone"]) {
      const r = guild.roles.cache.find((x) => x.name === name);
      if (!r) { console.log(`${name}: (missing)`); continue; }
      const admin = r.permissions.has(PermissionFlagsBits.Administrator);
      const view = r.permissions.has(PermissionFlagsBits.ViewChannel);
      console.log(`${name.padEnd(18)} admin=${admin ? "YES" : "no"} viewChannels=${view ? "yes" : "no"} members=${r.members.size} position=${r.position}`);
    }
    const ch = guild.channels.cache.find((c): c is TextChannel => c.type === ChannelType.GuildText && c.name === "💬・闲聊")!;
    const member = guild.roles.cache.find((x) => x.name === "Member")!;
    const everyone = guild.roles.everyone;
    // effective for a hypothetical member holding only @everyone + Member
    const base = everyone.permissions.add(member.permissions);
    let allow = 0n, deny = 0n;
    for (const id of [everyone.id, member.id]) { const ow = ch.permissionOverwrites.cache.get(id); if (ow) { deny |= ow.deny.bitfield; allow |= ow.allow.bitfield; } }
    const eff = base.has(PermissionFlagsBits.Administrator) ? "admin" : (((base.bitfield & ~deny) | allow) & PermissionFlagsBits.ViewChannel) ? "can view" : "cannot view";
    console.log(`Member-only viewer on #${ch.name}: ${eff}`);
  } finally { await client.destroy(); }
}
main();
