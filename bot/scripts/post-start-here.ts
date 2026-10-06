/**
 * Posts the rebuilt start-here page.
 *   npx tsx scripts/post-start-here.ts --preview     # hidden #start-here-preview (ops account + bot), created if missing
 *   npx tsx scripts/post-start-here.ts --channel "📍・start-here"
 * Re-running replaces the bot's previous messages in that channel.
 */
import { ChannelType, OverwriteType, PermissionFlagsBits, type TextChannel } from "discord.js";
import { connect } from "../src/lib/client.js";
import { opsUserIds } from "../src/lib/layout.js";
import { startHereMessages } from "../src/startHere.js";

async function main() {
  const args = process.argv.slice(2);
  const preview = args.includes("--preview");
  const name = preview ? "start-here-preview" : args[args.indexOf("--channel") + 1];
  if (!name) throw new Error("use --preview or --channel <name>");
  const { client, guild } = await connect();
  try {
    const me = guild.members.me ?? (await guild.members.fetchMe());
    const text = (n: string) => guild.channels.cache.find((c): c is TextChannel => (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement) && c.name === n);
    let ch = text(name);
    if (!ch && preview) {
      ch = await guild.channels.create({
        name, type: ChannelType.GuildText, topic: "Preview of the new start-here page. Visible to ops only.",
        permissionOverwrites: [
          { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
          { id: me.id, type: OverwriteType.Member, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles] },
          ...opsUserIds().map((id) => ({ id, type: OverwriteType.Member, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] })),
        ],
        reason: "start-here preview",
      });
      console.log("created #" + name);
    }
    if (!ch) throw new Error(`channel ${name} not found`);

    const helpDesk = text("☎️・help-desk");
    const helpDeskUrl = helpDesk ? `https://discord.com/channels/${guild.id}/${helpDesk.id}` : `https://discord.com/channels/${guild.id}`;

    const old = (await ch.messages.fetch({ limit: 50 })).filter((m) => m.author.id === me.id);
    for (const m of old.values()) await m.delete().catch(() => {});
    for (const payload of startHereMessages({ helpDeskUrl })) await ch.send(payload);
    console.log(`posted ${startHereMessages({ helpDeskUrl }).length} messages in #${ch.name}: https://discord.com/channels/${guild.id}/${ch.id}`);
  } finally { await client.destroy(); }
}
main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });
