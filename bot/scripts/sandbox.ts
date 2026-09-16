/**
 * Creates (or reuses) a hidden sandbox: category "mirror-test" visible only to
 * OPS_USER_IDS and the bot, with one channel per language, and registers them
 * as a group. Prints the channel IDs. Safe to re-run.
 *
 *   npx tsx scripts/sandbox.ts            # create
 *   npx tsx scripts/sandbox.ts --teardown # delete the sandbox channels + group
 */
import { ChannelType, OverwriteType, PermissionFlagsBits, type TextChannel } from "discord.js";
import { LANGS } from "../src/config.js";
import { Db } from "../src/db/index.js";
import { connect } from "../src/lib/client.js";
import { opsUserIds } from "../src/lib/layout.js";

const CATEGORY = "mirror-test";
const GROUP = "mirror-test";

async function main() {
  const teardown = process.argv.includes("--teardown");
  const { client, guild } = await connect();
  const db = new Db();
  try {
    const me = guild.members.me ?? (await guild.members.fetchMe());
    const need = [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles, PermissionFlagsBits.ManageWebhooks, PermissionFlagsBits.ManageMessages];
    const missing = need.filter((p) => !me.permissions.has(p));
    const names = (bits: bigint[]) => bits.map((b) => Object.entries(PermissionFlagsBits).find(([, v]) => v === b)?.[0] ?? String(b));
    console.log("bot permissions:", me.permissions.has(PermissionFlagsBits.Administrator) ? "Administrator" : missing.length ? `MISSING ${names(missing).join(", ")}` : "sufficient");

    let category = guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name === CATEGORY);
    if (teardown) {
      const gid = await db.findGroupByName(guild.id, GROUP);
      for (const c of guild.channels.cache.filter((c) => c.parentId === category?.id).values()) {
        await db.removeMember(c.id).catch(() => {});
        await c.delete("sandbox teardown");
        console.log("deleted", c.name);
      }
      if (category) await category.delete("sandbox teardown");
      if (gid) await db.sb.from("channel_groups").delete().eq("id", gid);
      console.log("sandbox removed");
      return;
    }

    const overwrites = [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: me.id, type: OverwriteType.Member, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageWebhooks, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks] },
      ...opsUserIds().map((id) => ({ id, type: OverwriteType.Member, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.ManageMessages] })),
    ];
    if (!category) {
      category = await guild.channels.create({ name: CATEGORY, type: ChannelType.GuildCategory, permissionOverwrites: overwrites, reason: "mirror sandbox" });
      console.log("created category", category.id);
    }
    const groupId = (await db.findGroupByName(guild.id, GROUP)) ?? (await db.createGroup(guild.id, GROUP));
    for (const lang of LANGS) {
      const name = lang === "en" ? "mirror-test" : `mirror-test-${lang}`;
      let ch = guild.channels.cache.find((c): c is TextChannel => c.type === ChannelType.GuildText && c.name === name && c.parentId === category!.id);
      if (!ch) {
        ch = await guild.channels.create({ name, type: ChannelType.GuildText, parent: category.id, permissionOverwrites: overwrites, topic: `Sandbox for the mirror bot (${lang})`, reason: "mirror sandbox" });
        console.log("created channel", name, ch.id);
      }
      await db.upsertMember({ channel_id: ch.id, group_id: groupId, lang, webhook_id: null, webhook_token: null });
      console.log(`${lang}=${ch.id}`);
    }
    console.log("group registered:", GROUP);
  } finally {
    await client.destroy();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
