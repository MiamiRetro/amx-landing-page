import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  MessageFlags,
  ThreadAutoArchiveDuration,
  type ButtonInteraction,
  type Guild,
  type GuildMember,
  type TextChannel,
} from "discord.js";
import { log, errInfo } from "../log.js";

export const CONCIERGE_OPEN = "concierge:open";
export const CONCIERGE_CLOSE = "concierge:close";
export const CONCIERGE_PREFIX = "concierge:";
export const CONCIERGE_CHANNEL = "🛎️・concierge";

/** The legacy VIPs role and the commission tiers; any one of them opens the concierge. */
export const VIP_ROLES = ["VIPs", "VIP 1", "VIP 2", "VIP 3", "VIP 4"];
/** Thread names start with this, so an open request is found again after a restart. */
const OPEN = "🛎️";

/** The team members a VIP gets: everyone holding one of these roles is added to the thread. */
export function teamRoleNames() {
  return (process.env.CONCIERGE_TEAM_ROLES ?? "Team - Will Not DM,Moderators").split(",").map((s) => s.trim()).filter(Boolean);
}

/** The pinned message in the concierge channel that opens a 1-on-1 thread. */
export function conciergePanel() {
  return {
    content: [
      "## 🛎️ VIP Concierge",
      "Your direct line to the BLKBöX team.",
      "",
      "Press the button and a private thread opens for you and the team only. Ask about your setup, a trade, your account or anything else, and a team member answers you one on one.",
      "",
      "-# Nobody from the team will ever DM you first or ask for a password, seed phrase or API key.",
    ].join("\n"),
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(CONCIERGE_OPEN).setStyle(ButtonStyle.Primary).setLabel("Talk to the team").setEmoji("🛎️"),
      ),
    ],
  };
}

const closeRow = () =>
  new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(CONCIERGE_CLOSE).setStyle(ButtonStyle.Secondary).setLabel("Close this request"));

/**
 * VIP concierge: like help-desk, a private thread per member, but no assistant.
 * The team is added straight away and answers the VIP one on one.
 */
export class Concierge {
  private membersFetchedAt = 0;

  constructor(private guild: Guild, private botUserId: string) {}

  private roleIds(names: string[]) {
    const wanted = names.map((n) => n.toLowerCase());
    return this.guild.roles.cache.filter((r) => wanted.includes(r.name.toLowerCase())).map((r) => r.id);
  }

  isVip(m: GuildMember) {
    const ids = new Set(this.roleIds(VIP_ROLES));
    return m.roles.cache.some((r) => ids.has(r.id));
  }

  isTeam(m: GuildMember) {
    const ids = new Set(this.roleIds(teamRoleNames()));
    return m.roles.cache.some((r) => ids.has(r.id));
  }

  async onButton(i: ButtonInteraction<"cached">) {
    if (i.customId === CONCIERGE_OPEN) return this.open(i);
    if (i.customId === CONCIERGE_CLOSE) return this.close(i);
  }

  private async open(i: ButtonInteraction<"cached">) {
    if (!this.isVip(i.member) && !this.isTeam(i.member)) {
      return void i.reply({ content: "The concierge is for VIP members. For anything else, press Get help in help-desk.", flags: MessageFlags.Ephemeral });
    }
    const channel = i.channel?.type === ChannelType.GuildText ? (i.channel as TextChannel) : null;
    if (!channel) return void i.reply({ content: "The concierge isn't set up here yet. Please ask the team.", flags: MessageFlags.Ephemeral });
    await i.deferReply({ flags: MessageFlags.Ephemeral });

    // One open request per member: send them back to it.
    const existing = await this.findOpen(channel, i.user.id);
    if (existing) return void i.editReply({ content: `You already have a request open: <#${existing.id}>`, components: [goTo(existing.url)] });

    const thread = await channel.threads.create({
      name: `${OPEN} ${i.member.displayName}`.slice(0, 90),
      type: ChannelType.PrivateThread,
      invitable: false,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
      reason: `VIP concierge for ${i.user.id}`,
    });
    await thread.members.add(i.user.id);
    // A private thread only shows to the people in it, so the team is added, not just pinged.
    const teamRoles = this.roleIds(teamRoleNames());
    if (Date.now() - this.membersFetchedAt > 10 * 60_000) {
      await this.guild.members.fetch().catch((e) => log.warn("member fetch failed", errInfo(e)));
      this.membersFetchedAt = Date.now();
    }
    const team = new Set(teamRoles.flatMap((id) => [...(this.guild.roles.cache.get(id)?.members.filter((m) => !m.user.bot).keys() ?? [])]));
    team.delete(i.user.id);
    for (const id of [...team].slice(0, 25)) await thread.members.add(id).catch(() => {});
    const mention = teamRoles.map((id) => `<@&${id}>`).join(" ");
    await thread.send({
      content: [
        `Welcome <@${i.user.id}> 👑`,
        "",
        `This is your private line to the team${mention ? ` (${mention})` : ""}. Tell us what you need, and add screenshots if they help. A team member will answer you here.`,
        "",
        "-# Only you and the team can see this thread.",
      ].join("\n"),
      components: [closeRow()],
      allowedMentions: { users: [i.user.id], roles: teamRoles },
    });
    log.info("concierge thread opened", { thread: thread.id, user: i.user.id, team: team.size });
    await this.alert(`🛎️ VIP concierge request from <@${i.user.id}>: ${thread.url}`);
    await i.editReply({ content: `Your private thread with the team is open: <#${thread.id}>`, components: [goTo(thread.url)] });
  }

  /** Asks Discord, not a cache, so it holds after a restart. */
  private async findOpen(channel: TextChannel, userId: string) {
    const active = await channel.threads.fetchActive().catch(() => null);
    for (const t of active?.threads.values() ?? []) {
      if (t.ownerId !== this.botUserId || !t.name.startsWith(OPEN) || t.locked) continue;
      if (await t.members.fetch({ member: userId }).then(() => true, () => false)) return t;
    }
    return null;
  }

  private async close(i: ButtonInteraction<"cached">) {
    const thread = i.channel?.isThread() ? i.channel : null;
    if (!thread || thread.ownerId !== this.botUserId) return void i.reply({ content: "This button only works in a concierge thread.", flags: MessageFlags.Ephemeral });
    await i.reply({ content: `Closed by <@${i.user.id}>. Press **Talk to the team** in the concierge channel any time to open a new request.`, allowedMentions: { parse: [] } });
    log.info("concierge thread closed", { thread: thread.id, by: i.user.id });
    await thread.setLocked(true, "concierge: closed").catch((e) => log.warn("concierge lock failed", errInfo(e)));
    await thread.setArchived(true, "concierge: closed").catch((e) => log.warn("concierge archive failed", errInfo(e)));
  }

  private async alert(content: string) {
    const alertId = (process.env.SUPPORT_ALERT_CHANNEL_ID ?? process.env.VERIFY_ALERT_CHANNEL_ID)?.trim();
    if (!alertId) return;
    const ch = await this.guild.channels.fetch(alertId).catch(() => null);
    if (ch?.isTextBased() && "send" in ch) await ch.send({ content, allowedMentions: { parse: [] } }).catch((e) => log.warn("concierge alert send failed", errInfo(e)));
  }
}

const goTo = (url: string) =>
  new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(url).setLabel("Go to your thread").setEmoji("🛎️"));
