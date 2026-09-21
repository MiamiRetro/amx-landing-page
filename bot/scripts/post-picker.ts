/**
 * Posts the language picker.
 *   npx tsx scripts/post-picker.ts --test                 # hidden #language-test channel (ops + bot only), created if missing
 *   npx tsx scripts/post-picker.ts --channel "📍・start-here"
 * Re-running replaces the previous picker posted by the bot in that channel.
 */
import { ChannelType, OverwriteType, PermissionFlagsBits, type TextChannel } from "discord.js";
import { connect } from "../src/lib/client.js";
import { opsUserIds } from "../src/lib/layout.js";
import { postPicker } from "../src/picker.js";

async function main() {
  const args = process.argv.slice(2);
  const test = args.includes("--test");
  const name = test ? "language-test" : args[args.indexOf("--channel") + 1];
  if (!name) throw new Error("use --test or --channel <name>");
  const { client, guild } = await connect();
  try {
    const me = guild.members.me ?? (await guild.members.fetchMe());
    let ch = guild.channels.cache.find((c): c is TextChannel => c.type === ChannelType.GuildText && c.name === name);
    if (!ch && test) {
      ch = await guild.channels.create({
        name,
        type: ChannelType.GuildText,
        topic: "Test area for the language picker. Visible to ops only.",
        permissionOverwrites: [
          { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
          { id: me.id, type: OverwriteType.Member, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.EmbedLinks] },
          ...opsUserIds().map((id) => ({ id, type: OverwriteType.Member, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] })),
        ],
        reason: "language picker test",
      });
      console.log("created #" + name);
    }
    if (!ch) throw new Error(`channel ${name} not found`);
    const old = (await ch.messages.fetch({ limit: 50 })).filter((m) => m.author.id === me.id && m.components.length > 0);
    for (const m of old.values()) await m.delete().catch(() => {});
    const msg = await postPicker(ch);
    console.log(`posted picker in #${ch.name}: https://discord.com/channels/${guild.id}/${ch.id}/${msg.id}`);
  } finally { await client.destroy(); }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
