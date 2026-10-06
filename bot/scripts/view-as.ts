/** Simulates what a member holding only the given roles can see, using Discord's permission algorithm. */
import { ChannelType, PermissionFlagsBits, type Role } from "discord.js";
import { connect } from "../src/lib/client.js";
async function main() {
  const names = process.argv.slice(2);
  const { client, guild } = await connect();
  try {
    const roles: Role[] = [guild.roles.everyone, ...names.map((n) => guild.roles.cache.find((r) => r.name === n)).filter((r): r is Role => !!r)];
    const base = roles.reduce((acc, r) => acc | r.permissions.bitfield, 0n);
    for (const cat of guild.channels.cache.filter((c) => c.type === ChannelType.GuildCategory && c.name.includes("───")).values()) {
      let perms = base;
      const ev = cat.permissionOverwrites.cache.get(guild.id);
      if (ev) perms = (perms & ~ev.deny.bitfield) | ev.allow.bitfield;
      let allow = 0n, deny = 0n;
      for (const r of roles) { if (r.id === guild.id) continue; const ow = cat.permissionOverwrites.cache.get(r.id); if (ow) { deny |= ow.deny.bitfield; allow |= ow.allow.bitfield; } }
      perms = (perms & ~deny) | allow;
      const visible = (base & PermissionFlagsBits.Administrator) !== 0n || (perms & PermissionFlagsBits.ViewChannel) !== 0n;
      console.log(`${visible ? "VISIBLE" : "hidden "}  ${cat.name}`);
    }
  } finally { await client.destroy(); }
}
main();
