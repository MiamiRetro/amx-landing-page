/**
 * Posts the UID verification panel.
 *   npx tsx scripts/post-verify.ts --preview            # hidden #verify-preview, ops only
 *   npx tsx scripts/post-verify.ts --channel "✅・verify"
 * Re-running replaces the bot's earlier messages in that channel.
 */
import { ChannelType, OverwriteType, PermissionFlagsBits, type TextChannel } from "discord.js";
import { connect } from "../src/lib/client.js";
import { opsUserIds } from "../src/lib/layout.js";
import { verifyPanel } from "../src/verify/panel.js";

async function main() {
  const args = process.argv.slice(2);
  const preview = args.includes("--preview");
  const name = preview ? "verify-preview" : args[args.indexOf("--channel") + 1];
  if (!name) throw new Error("use --preview or --channel <name>");
  const { client, guild } = await connect();
  try {
    const me = guild.members.me ?? (await guild.members.fetchMe());
    const find = (n: string) => guild.channels.cache.find((c): c is TextChannel => c.type === ChannelType.GuildText && c.name === n);
    let ch = find(name);
    if (!ch && preview) {
      ch = await guild.channels.create({
        name,
        type: ChannelType.GuildText,
        topic: "Testing the UID verification panel. Ops only.",
        permissionOverwrites: [
          { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
          { id: me.id, type: OverwriteType.Member, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles] },
          ...opsUserIds().map((id) => ({ id, type: OverwriteType.Member, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] })),
        ],
        reason: "verification panel preview",
      });
      console.log("created #" + name);
    }
    if (!ch) throw new Error(`channel ${name} not found`);
    const old = (await ch.messages.fetch({ limit: 50 })).filter((m) => m.author.id === me.id);
    for (const m of old.values()) await m.delete().catch(() => {});
    await ch.send(verifyPanel());
    console.log(`posted in #${ch.name}: https://discord.com/channels/${guild.id}/${ch.id}`);
  } finally {
    await client.destroy();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });
