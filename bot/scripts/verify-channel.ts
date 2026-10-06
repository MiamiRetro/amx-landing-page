/**
 * Makes a channel visible only to people who are not verified yet.
 *
 *   npx tsx scripts/verify-channel.ts --channel "✅・verify"
 *
 * Discord resolves role overwrites by applying every deny, then every allow, so
 * an allow on @everyone plus a deny on the membership role means: everyone sees
 * it until they hold the role, and nobody sees it afterwards. No per-member
 * overwrites, and nothing for the bot to clean up when someone verifies.
 */
import { ChannelType, OverwriteType, PermissionFlagsBits, type OverwriteResolvable, type TextChannel } from "discord.js";
import { connect } from "../src/lib/client.js";
import { Db } from "../src/db/index.js";

async function main() {
  const args = process.argv.slice(2);
  const name = args[args.indexOf("--channel") + 1];
  if (!name || name.startsWith("--")) throw new Error('usage: verify-channel.ts --channel "<name>"');
  const { client, guild } = await connect();
  try {
    const ch = guild.channels.cache.find(
      (c): c is TextChannel => (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement) && c.name === name,
    );
    if (!ch) throw new Error(`channel "${name}" not found`);
    const me = guild.members.me ?? (await guild.members.fetchMe());

    const configured = ((await new Db().getSetting(guild.id, "member_roles")) ?? "Member,Members").split(",").map((s) => s.trim().toLowerCase());
    const memberRoles = guild.roles.cache.filter((r) => configured.includes(r.name.toLowerCase()));
    if (memberRoles.size === 0) throw new Error(`no membership role found (looked for: ${configured.join(", ")})`);

    const ows: OverwriteResolvable[] = [
      // Unverified arrivals hold only @everyone, so this is what they see by.
      { id: guild.roles.everyone.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages] },
      // Verified members lose sight of it. No other role may allow ViewChannel
      // here, because a role allow would override this deny.
      ...memberRoles.map((r) => ({ id: r.id, deny: [PermissionFlagsBits.ViewChannel] })),
      // Member overwrites are applied last, so the bot keeps access regardless.
      { id: me.id, type: OverwriteType.Member, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles] },
    ];
    await ch.permissionOverwrites.set(ows, "verify channel: unverified only");

    const fresh = (await guild.channels.fetch(ch.id)) as TextChannel;
    console.log(`#${fresh.name} updated`);
    console.log("  @everyone only (not verified):", fresh.permissionsFor(guild.roles.everyone).has(PermissionFlagsBits.ViewChannel));
    for (const r of memberRoles.values()) console.log(`  holds ${r.name} (verified):`, fresh.permissionsFor(r).has(PermissionFlagsBits.ViewChannel));
  } finally {
    await client.destroy();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });
