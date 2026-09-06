import {
  ChannelType,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type Guild,
  type TextChannel,
} from "discord.js";
import { isLang, LANG_NAMES, LANGS, type Lang } from "../config.js";
import type { Db } from "../db/index.js";
import { buildOverwrites } from "../lib/layout.js";
import { log, errInfo } from "../log.js";
import type { GroupIndex } from "../mirror/groups.js";
import type { Mirror } from "../mirror/mirror.js";

const langChoices = LANGS.map((l) => ({ name: `${LANG_NAMES[l]} (${l})`, value: l }));

export const commandDefinitions = [
  new SlashCommandBuilder()
    .setName("mirror")
    .setDescription("Manage mirrored language channels")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addSubcommand((s) =>
      s
        .setName("create")
        .setDescription("Create language twins for a channel and start mirroring")
        .addChannelOption((o) => o.setName("source").setDescription("Existing English channel").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true))
        .addStringOption((o) => o.setName("name").setDescription("Base name for the twins, e.g. general → general-zh").setRequired(true))
        .addBooleanOption((o) => o.setName("readonly").setDescription("Twins are read-only (alerts, announcements)")),
    )
    .addSubcommand((s) =>
      s
        .setName("link")
        .setDescription("Add an existing channel to a group")
        .addChannelOption((o) => o.setName("channel").setDescription("Channel").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true))
        .addStringOption((o) => o.setName("lang").setDescription("Language of this channel").addChoices(...langChoices).setRequired(true))
        .addStringOption((o) => o.setName("group").setDescription("Group name (created if new)").setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName("unlink")
        .setDescription("Stop mirroring a channel (channel stays)")
        .addChannelOption((o) => o.setName("channel").setDescription("Channel").setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName("category")
        .setDescription("Set the category where twins for a language are created")
        .addStringOption((o) => o.setName("lang").setDescription("Language").addChoices(...langChoices).setRequired(true))
        .addChannelOption((o) => o.setName("category").setDescription("Category").addChannelTypes(ChannelType.GuildCategory).setRequired(true))
        .addRoleOption((o) => o.setName("role").setDescription("Role that may view this language's channels")),
    )
    .addSubcommand((s) => s.setName("status").setDescription("Groups, queue, usage"))
    .addSubcommand((s) => s.setName("pause").setDescription("Pause all mirroring"))
    .addSubcommand((s) => s.setName("resume").setDescription("Resume mirroring")),
  new SlashCommandBuilder()
    .setName("glossary")
    .setDescription("Terms the translator must never translate")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addSubcommand((s) =>
      s
        .setName("add")
        .setDescription("Add a term")
        .addStringOption((o) => o.setName("term").setDescription("Term, e.g. AMX").setRequired(true))
        .addStringOption((o) => o.setName("note").setDescription("Hint for the translator, e.g. product name")),
    )
    .addSubcommand((s) => s.setName("remove").setDescription("Remove a term").addStringOption((o) => o.setName("term").setDescription("Term").setRequired(true)))
    .addSubcommand((s) => s.setName("list").setDescription("List terms")),
].map((c) => c.toJSON());

export interface CommandDeps {
  guild: Guild;
  db: Db;
  groups: GroupIndex;
  mirror: Mirror;
  providerId: string;
}

export async function handleCommand(i: ChatInputCommandInteraction, d: CommandDeps) {
  if (!i.inGuild() || i.guildId !== d.guild.id) return;
  await i.deferReply({ ephemeral: true });
  try {
    const text = i.commandName === "mirror" ? await mirrorCommand(i, d) : await glossaryCommand(i, d);
    await i.editReply(text.slice(0, 1900));
  } catch (e) {
    log.error("command failed", { command: i.commandName, sub: i.options.getSubcommand(false), ...errInfo(e) });
    await i.editReply(`Failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function mirrorCommand(i: ChatInputCommandInteraction, d: CommandDeps): Promise<string> {
  const sub = i.options.getSubcommand();
  const guildId = d.guild.id;

  if (sub === "status") {
    await d.groups.reload();
    const usage = await d.db.usageToday();
    const lines = [`Provider: \`${d.providerId}\` · ${d.mirror.paused ? "**PAUSED**" : "running"} · queue: ${d.mirror.queue.pending}`];
    lines.push(`Last 24h: ${usage.requests} translation calls · ${usage.input} in (${usage.cached} cached) · ${usage.output} out tokens`);
    if (d.groups.groups.length === 0) lines.push("No groups yet. Use `/mirror create` or `/mirror link`.");
    for (const g of d.groups.groups) {
      const members = g.members.map((m) => `${m.lang}: <#${m.channel_id}>${m.webhook_id ? "" : " (no webhook yet)"}`).join(" · ");
      lines.push(`• **${g.name}**${g.paused ? " (paused)" : ""} — ${members}`);
    }
    return lines.join("\n");
  }
  if (sub === "pause" || sub === "resume") {
    await d.db.setPaused(null, guildId, sub === "pause");
    d.mirror.paused = sub === "pause";
    await d.groups.reload();
    return sub === "pause" ? "Mirroring paused." : "Mirroring resumed.";
  }
  if (sub === "category") {
    const lang = i.options.getString("lang", true);
    const cat = i.options.getChannel("category", true);
    const role = i.options.getRole("role");
    await d.db.setSetting(guildId, `category:${lang}`, cat.id);
    if (role) await d.db.setSetting(guildId, `role:${lang}`, role.id);
    return `Twins for ${LANG_NAMES[lang as Lang]} will be created in **${cat.name}**${role ? `, visible to @${role.name}` : ""}.`;
  }
  if (sub === "link") {
    const channel = i.options.getChannel("channel", true);
    const lang = i.options.getString("lang", true);
    const name = i.options.getString("group", true).toLowerCase();
    if (!isLang(lang)) throw new Error("unknown language");
    const existing = d.groups.lookup(channel.id);
    if (existing) throw new Error(`<#${channel.id}> is already in group "${existing.group.name}"`);
    const groupId = (await d.db.findGroupByName(guildId, name)) ?? (await d.db.createGroup(guildId, name));
    await d.db.upsertMember({ channel_id: channel.id, group_id: groupId, lang, webhook_id: null, webhook_token: null });
    await d.groups.reload();
    return `Linked <#${channel.id}> as **${lang}** in group **${name}**.`;
  }
  if (sub === "unlink") {
    const channel = i.options.getChannel("channel", true);
    const hit = d.groups.lookup(channel.id);
    if (!hit) return `<#${channel.id}> is not mirrored.`;
    await d.db.removeMember(channel.id);
    await d.groups.reload();
    return `Unlinked <#${channel.id}> from **${hit.group.name}**. The channel and its messages are untouched.`;
  }
  if (sub === "create") {
    const source = i.options.getChannel("source", true) as TextChannel;
    const name = i.options.getString("name", true).toLowerCase().replace(/[^a-z0-9-]+/g, "-");
    const readOnly = i.options.getBoolean("readonly") ?? false;
    if (d.groups.lookup(source.id)) throw new Error(`<#${source.id}> is already mirrored`);
    const groupId = (await d.db.findGroupByName(guildId, name)) ?? (await d.db.createGroup(guildId, name));
    await d.db.upsertMember({ channel_id: source.id, group_id: groupId, lang: "en", webhook_id: null, webhook_token: null });

    const created: string[] = [];
    const skipped: string[] = [];
    for (const lang of LANGS) {
      if (lang === "en") continue;
      const categoryId = await d.db.getSetting(guildId, `category:${lang}`);
      if (!categoryId) {
        skipped.push(`${lang} (run \`/mirror category lang:${lang}\` first)`);
        continue;
      }
      const roleId = await d.db.getSetting(guildId, `role:${lang}`);
      const roleName = roleId ? d.guild.roles.cache.get(roleId)?.name : undefined;
      const twinName = `${name}-${lang}`;
      const existing = d.guild.channels.cache.find((c) => c.type === ChannelType.GuildText && c.name === twinName && c.parentId === categoryId);
      const channel =
        (existing as TextChannel | undefined) ??
        (await d.guild.channels.create({
          name: twinName,
          type: ChannelType.GuildText,
          parent: categoryId,
          topic: source.topic ?? undefined,
          permissionOverwrites: roleName ? buildOverwrites(d.guild, [roleName], readOnly) : undefined,
          reason: `mirror twin of #${source.name}`,
        }));
      await d.db.upsertMember({ channel_id: channel.id, group_id: groupId, lang, webhook_id: null, webhook_token: null });
      created.push(`${lang}: <#${channel.id}>`);
    }
    await d.groups.reload();
    const out = [`Group **${name}** created from <#${source.id}>.`];
    if (created.length) out.push(`Twins: ${created.join(" · ")}`);
    if (skipped.length) out.push(`Skipped: ${skipped.join(", ")}`);
    return out.join("\n");
  }
  throw new Error(`unknown subcommand ${sub}`);
}

async function glossaryCommand(i: ChatInputCommandInteraction, d: CommandDeps): Promise<string> {
  const sub = i.options.getSubcommand();
  if (sub === "add") {
    const term = i.options.getString("term", true).trim();
    await d.db.glossaryAdd(d.guild.id, term, i.options.getString("note"));
    d.mirror.invalidateGlossary();
    return `Added **${term}** to the glossary.`;
  }
  if (sub === "remove") {
    const term = i.options.getString("term", true).trim();
    await d.db.glossaryRemove(d.guild.id, term);
    d.mirror.invalidateGlossary();
    return `Removed **${term}**.`;
  }
  const rows = await d.db.glossary(d.guild.id);
  if (rows.length === 0) return "Glossary is empty.";
  return rows.map((r) => `• **${r.term}**${r.note ? ` — ${r.note}` : ""}`).join("\n");
}
