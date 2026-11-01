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
  type Message,
  type TextChannel,
  type ThreadChannel,
} from "discord.js";
import type { Db } from "../db/index.js";
import { log, errInfo } from "../log.js";
import { busyTimes } from "../calendar/google.js";
import { findSlots, parseHours } from "../calendar/slots.js";
import type { LanguageRoles } from "../roles.js";
import { HOSTS, hostIds, type Butler, type ButlerTurn, type HostKey } from "./butler.js";
import { relayTranslation, type ThreadTranslator } from "./relay.js";

export const CONCIERGE_OPEN = "concierge:open";
export const CONCIERGE_CLOSE = "concierge:close";
/** concierge:accept:<thread id>:<host key>, on the request card in the bookings channel. */
export const CONCIERGE_ACCEPT = "concierge:accept:";
/** concierge:slot:<host key>:<unix seconds>, or concierge:slot:<host key>:none, under the open times the concierge offers. */
export const CONCIERGE_SLOT = "concierge:slot:";
export const CONCIERGE_PREFIX = "concierge:";
export const CONCIERGE_CHANNEL = "🛎️・concierge";
export const BOOKINGS_CHANNEL = "📅・vip-bookings";

/** The legacy VIPs role and the commission tiers; any one of them opens the concierge. */
export const VIP_ROLES = ["VIPs", "VIP 1", "VIP 2", "VIP 3", "VIP 4"];
/** Thread names carry the state, so it survives a restart: the e-butler looks after 🛎️ threads, a person owns 🤝 ones. */
const BUTLER = "🛎️";
const PERSON = "🤝";

/** The team members brought in when something is urgent: everyone holding one of these roles. */
export function teamRoleNames() {
  return (process.env.CONCIERGE_TEAM_ROLES ?? "Team - Will Not DM,Moderators").split(",").map((s) => s.trim()).filter(Boolean);
}

const HOST_LINE: Record<HostKey, string> = {
  jt: `🔐 **${HOSTS.jt.name}**: wallets, self-custody and security`,
  matt: `📈 **${HOSTS.matt.name}**: trades and the AlphanumetriX indicator`,
};
const hostLines = () => (Object.keys(HOSTS) as HostKey[]).map((k) => HOST_LINE[k]);

/** The pinned message in the concierge channel that opens a private thread. */
export function conciergePanel() {
  return {
    content: [
      "## 🛎️ The BLKBöX Concierge",
      "*Reserved for our VIPs.*",
      "",
      "Your private e-butler is at your service around the clock. Tell it what you need: it takes care of the small things on the spot, and when something deserves a proper sit-down, it arranges a private 1-on-1 session for you.",
      "",
      ...hostLines(),
      "",
      "Sessions are by appointment, so the time you get is yours alone.",
      "",
      "-# Nobody from the team will ever DM you first or ask for a password, seed phrase or API key.",
    ].join("\n"),
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(CONCIERGE_OPEN).setStyle(ButtonStyle.Primary).setLabel("Open my concierge").setEmoji("🛎️"),
      ),
    ],
  };
}

const closeRow = () =>
  new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(CONCIERGE_CLOSE).setStyle(ButtonStyle.Secondary).setLabel("Close"));

const goTo = (url: string) =>
  new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(url).setLabel("Go to your concierge").setEmoji("🛎️"));

/** When each host takes sessions, from CONCIERGE_HOURS_<HOST> ("Mon-Fri 10:00-18:00 Asia/Bangkok"). */
const DEFAULT_HOURS: Record<HostKey, string> = { jt: "Mon-Fri 10:00-18:00 Asia/Bangkok", matt: "Mon-Fri 10:00-18:00 Asia/Bangkok" };
const hoursOf = (host: HostKey) => parseHours(process.env[`CONCIERGE_HOURS_${host.toUpperCase()}`]?.trim() || DEFAULT_HOURS[host]);
const SESSION_MIN = () => Number(process.env.CONCIERGE_SESSION_MIN ?? 30);
const BOOK_DAYS = () => Number(process.env.CONCIERGE_BOOK_DAYS ?? 7);
/** Sessions are booked, not on demand: nothing sooner than this. */
const LEAD_HOURS = () => Number(process.env.CONCIERGE_LEAD_HOURS ?? 48);
const TOPIC = "-# Topic: ";
const when = (unix: number) => `<t:${unix}:F> (<t:${unix}:R>)`;

const strip = (name: string) => name.replace(BUTLER, "").replace(PERSON, "").trim();

/**
 * VIP concierge: a private thread per VIP. The e-butler (an AI) answers first,
 * filters what needs a person and turns that into a session request for JT or
 * Matt; the host accepts it from the bookings channel and joins the thread.
 * Anything urgent (funds or an account at risk) brings the team in at once.
 * Without an Anthropic key the team is brought in straight away.
 */
export class Concierge {
  private membersFetchedAt = 0;
  private owners = new Map<string, string>();
  private busy = new Set<string>();

  constructor(
    private guild: Guild,
    private db: Db,
    private botUserId: string,
    private butler: Butler | null,
    private roles: LanguageRoles | null = null,
    private translator: ThreadTranslator | null = null,
  ) {}

  /** VIPs come from every language: once a person from the team is in the thread, each side reads the other in its own language. */
  private async relay(m: Message, owner: string) {
    const member = await this.guild.members.fetch(owner).catch(() => null);
    return relayTranslation(this.translator, m, owner, member && this.roles ? this.roles.langOf(member) : null);
  }

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
    return m.permissions.has("ManageThreads") || m.roles.cache.some((r) => ids.has(r.id)) || Object.values(hostIds()).includes(m.id);
  }

  async onButton(i: ButtonInteraction<"cached">) {
    if (i.customId === CONCIERGE_OPEN) return this.open(i);
    if (i.customId === CONCIERGE_CLOSE) return this.close(i);
    if (i.customId.startsWith(CONCIERGE_ACCEPT)) return this.accept(i);
    if (i.customId.startsWith(CONCIERGE_SLOT)) return this.pickSlot(i);
  }

  private async open(i: ButtonInteraction<"cached">) {
    if (!this.isVip(i.member) && !this.isTeam(i.member)) {
      return void i.reply({ content: "The concierge is reserved for VIP members. For anything else, press Get help in help-desk.", flags: MessageFlags.Ephemeral });
    }
    const channel = i.channel?.type === ChannelType.GuildText ? (i.channel as TextChannel) : null;
    if (!channel) return void i.reply({ content: "The concierge isn't set up here yet. Please ask the team.", flags: MessageFlags.Ephemeral });
    await i.deferReply({ flags: MessageFlags.Ephemeral });

    // One open concierge per member: send them back to it.
    const existing = await this.findOpen(channel, i.user.id);
    if (existing) return void i.editReply({ content: `Your concierge is already open: <#${existing.id}>`, components: [goTo(existing.url)] });

    const thread = await channel.threads.create({
      name: `${BUTLER} ${i.member.displayName}`.slice(0, 90),
      type: ChannelType.PrivateThread,
      invitable: false,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
      reason: `VIP concierge for ${i.user.id}`,
    });
    this.owners.set(thread.id, i.user.id);
    await thread.members.add(i.user.id);
    if (!this.butler) {
      await thread.send({ content: `Welcome <@${i.user.id}> 👑\n\nThis is your private line to the team. Tell us what you need and a team member will answer you here.`, components: [closeRow()], allowedMentions: { users: [i.user.id] } });
      await this.bringTeam(thread, i.user.id, "concierge opened (no e-butler configured)");
    } else {
      await thread.send({
        content: [
          `Good to see you, <@${i.user.id}> 👑`,
          "",
          "I'm your e-butler. How may I help? I can answer most questions right here, and if you'd like a private session, I'll arrange one with:",
          ...hostLines(),
          "",
          "-# Only you can see this thread. Never share a seed phrase, password or API key, here or anywhere.",
        ].join("\n"),
        components: [closeRow()],
        allowedMentions: { users: [i.user.id] },
      });
    }
    log.info("concierge thread opened", { thread: thread.id, user: i.user.id, butler: !!this.butler });
    await i.editReply({ content: `Your concierge is ready: <#${thread.id}>`, components: [goTo(thread.url)] });
  }

  /** Asks Discord, not a cache, so it holds after a restart. */
  private async findOpen(channel: TextChannel, userId: string) {
    const active = await channel.threads.fetchActive().catch(() => null);
    for (const t of active?.threads.values() ?? []) {
      if (t.ownerId !== this.botUserId || t.locked || !(t.name.startsWith(BUTLER) || t.name.startsWith(PERSON))) continue;
      if ((await this.ownerOf(t)) === userId) return t;
    }
    return null;
  }

  /** The VIP a thread belongs to: the one the bot's opening message greets. */
  private async ownerOf(thread: ThreadChannel): Promise<string | null> {
    const known = this.owners.get(thread.id);
    if (known) return known;
    const first = await thread.messages.fetch({ after: "0", limit: 5 }).catch(() => null);
    const intro = first && [...first.values()].reverse().find((x) => x.author.id === this.botUserId && x.mentions.users.size > 0);
    const id = intro?.mentions.users.first()?.id ?? null;
    if (id) this.owners.set(thread.id, id);
    return id;
  }

  async onMessage(m: Message) {
    if (!m.inGuild() || m.guildId !== this.guild.id || m.author.bot || !m.channel.isThread()) return;
    const thread = m.channel;
    if (thread.ownerId !== this.botUserId || !thread.parent?.name.includes(CONCIERGE_CHANNEL)) return;
    if (!thread.name.startsWith(BUTLER) && !thread.name.startsWith(PERSON)) return;
    const owner = await this.ownerOf(thread);
    if (!owner) return;
    // A person is in the thread: the e-butler stays quiet and messages are translated both ways.
    if (thread.name.startsWith(PERSON)) return this.relay(m, owner);
    if (m.author.id !== owner) {
      // A person from the team speaking up takes the thread over; the e-butler steps back.
      await thread.setName(`${PERSON} ${strip(thread.name)}`.slice(0, 90)).catch(() => {});
      return this.relay(m, owner);
    }
    if (!this.butler) return;
    if (this.busy.has(thread.id) || !m.content.trim()) return;
    this.busy.add(thread.id);
    try {
      await thread.sendTyping().catch(() => {});
      const history = [...(await thread.messages.fetch({ limit: 20 })).values()].reverse();
      const turns: ButlerTurn[] = history
        .filter((x) => x.content.trim())
        .map((x) => ({ from: x.author.id === this.botUserId ? "butler" : x.author.id === owner ? "vip" : "team", text: x.content }));
      const a = await this.butler.answer(turns);
      if (a.reply.trim()) await thread.send({ content: a.reply, allowedMentions: { parse: [] } });
      if (a.action === "urgent") await this.bringTeam(thread, owner, `urgent: ${m.content.slice(0, 200)}`);
      else if (a.action === "booking" && a.host) await this.book(thread, owner, a.host, a.topic, a.times);
      log.info("concierge answer", { thread: thread.id, action: a.action, host: a.host, model: this.butler.model });
    } catch (e) {
      log.error("concierge answer failed", { thread: thread.id, ...errInfo(e) });
      await thread.send("My apologies, I can't answer just now. I've let the team know and someone will be with you shortly.").catch(() => {});
      await this.bringTeam(thread, owner, `e-butler unavailable; VIP wrote: ${m.content.slice(0, 200)}`);
    } finally {
      this.busy.delete(thread.id);
    }
  }

  /** Where session requests go: the bookings channel, else the staff alert channel. */
  private async bookingsChannel(): Promise<TextChannel | null> {
    const id = (await this.db.getSetting(this.guild.id, "concierge_bookings_channel").catch(() => null))
      ?? (process.env.SUPPORT_ALERT_CHANNEL_ID ?? process.env.VERIFY_ALERT_CHANNEL_ID)?.trim();
    const ch = id ? await this.guild.channels.fetch(id).catch(() => null) : null;
    return ch?.type === ChannelType.GuildText ? ch : null;
  }

  /** The host's next open times as buttons; falls back to asking the VIP for times when the calendar can't be read. */
  private async offerSlots(thread: ThreadChannel, owner: string, host: HostKey, topic: string) {
    const name = HOSTS[host].name;
    let slots: Date[] = [];
    try {
      const now = new Date();
      const busy = await busyTimes(this.db, this.guild.id, host, now, new Date(+now + (BOOK_DAYS() + 1) * 86_400_000));
      if (busy) slots = findSlots({ hours: hoursOf(host), busy, now, lengthMin: SESSION_MIN(), days: BOOK_DAYS(), leadMin: LEAD_HOURS() * 60, count: 3 });
    } catch (e) {
      log.warn("concierge calendar read failed", { host, ...errInfo(e) });
    }
    if (slots.length === 0) {
      await thread.send(`I couldn't see ${name}'s diary just now. Which two or three days and times would suit you, and in which time zone? I'll pass them on.`);
      return;
    }
    const nums = ["1️⃣", "2️⃣", "3️⃣"];
    const unix = slots.map((d) => Math.floor(+d / 1000));
    await thread.send({
      content: [
        `${name}'s next open times for a ${SESSION_MIN()}-minute session, shown in your own time zone:`,
        ...unix.map((u, k) => `${nums[k]} ${when(u)}`),
        "",
        "Choose one and I'll send the request. If none suit you, tell me what would.",
        `${TOPIC}${topic.slice(0, 300)}`,
      ].join("\n"),
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          ...unix.map((u, k) => new ButtonBuilder().setCustomId(`${CONCIERGE_SLOT}${host}:${u}`).setStyle(ButtonStyle.Primary).setEmoji(nums[k]).setLabel("Book")),
          new ButtonBuilder().setCustomId(`${CONCIERGE_SLOT}${host}:none`).setStyle(ButtonStyle.Secondary).setLabel("None of these"),
        ),
      ],
      allowedMentions: { parse: [] },
    });
    log.info("concierge slots offered", { thread: thread.id, user: owner, host, slots: unix.length });
  }

  /** The VIP picks one of the offered times: the request goes to the host with that exact time. */
  private async pickSlot(i: ButtonInteraction<"cached">) {
    const thread = i.channel?.isThread() ? i.channel : null;
    const owner = thread && (await this.ownerOf(thread));
    if (!thread || !owner) return void i.reply({ content: "This button only works in a concierge thread.", flags: MessageFlags.Ephemeral });
    if (i.user.id !== owner) return void i.reply({ content: "Only the VIP this concierge belongs to can choose a time.", flags: MessageFlags.Ephemeral });
    const [host, pick] = i.customId.slice(CONCIERGE_SLOT.length).split(":") as [HostKey, string];
    const topic = i.message.content.split("\n").find((l) => l.startsWith(TOPIC))?.slice(TOPIC.length) ?? "";
    const offered = i.message.content.split("\n").filter((l) => !l.startsWith(TOPIC)).join("\n");
    if (pick === "none") {
      await i.update({ content: offered, components: [] });
      await thread.send(`Of course. Which two or three days and times would suit you better, and in which time zone? I'll pass them to ${HOSTS[host]?.name ?? "the host"}.`);
      return;
    }
    const unix = Number(pick);
    await i.update({ content: `${offered}\n\n✅ You chose ${when(unix)}.`, components: [] });
    await thread.send({ content: `Lovely. I've sent your request to ${HOSTS[host].name} for ${when(unix)}. They'll confirm with you here personally.`, allowedMentions: { parse: [] } });
    await this.sendRequest(thread, owner, host, topic, `<t:${unix}:F> (${new Date(unix * 1000).toUTCString()})`);
  }

  private async book(thread: ThreadChannel, owner: string, host: HostKey, topic: string, times: string) {
    // No times from the VIP yet: show the host's open slots first.
    if (!times.trim()) return this.offerSlots(thread, owner, host, topic);
    return this.sendRequest(thread, owner, host, topic, times);
  }

  private async sendRequest(thread: ThreadChannel, owner: string, host: HostKey, topic: string, times: string) {
    const hostId = hostIds()[host];
    const ch = await this.bookingsChannel();
    if (!ch) {
      log.warn("concierge booking has nowhere to go", { thread: thread.id, host });
      return this.bringTeam(thread, owner, `session request for ${HOSTS[host].name} (no bookings channel): ${topic} / ${times}`);
    }
    await ch.send({
      content: [
        `## 📅 Session request for ${hostId ? `<@${hostId}>` : HOSTS[host].name}`,
        `**VIP:** <@${owner}>`,
        `**Topic:** ${topic || "(not given)"}`,
        `**Time:** ${times || "(not given)"}`,
        `**Thread:** ${thread.url}`,
        "",
        "-# Accept to join the VIP's private thread and confirm the time there.",
      ].join("\n"),
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`${CONCIERGE_ACCEPT}${thread.id}:${host}`).setStyle(ButtonStyle.Success).setLabel("Accept").setEmoji("✅"),
          new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(thread.url).setLabel("Open thread"),
        ),
      ],
      allowedMentions: { users: hostId ? [hostId] : [] },
    });
    log.info("concierge session requested", { thread: thread.id, user: owner, host });
  }

  /** The host (or the team) takes a session request: they join the thread and the VIP is told. */
  private async accept(i: ButtonInteraction<"cached">) {
    const [threadId, host] = i.customId.slice(CONCIERGE_ACCEPT.length).split(":") as [string, HostKey];
    if (!this.isTeam(i.member)) return void i.reply({ content: "Only the team can accept a session.", flags: MessageFlags.Ephemeral });
    const thread = await this.guild.channels.fetch(threadId).catch(() => null);
    if (!thread?.isThread()) return void i.reply({ content: "That concierge thread is gone.", flags: MessageFlags.Ephemeral });
    await i.deferUpdate();
    if (thread.archived) await thread.setArchived(false).catch(() => {});
    await thread.members.add(i.user.id).catch(() => {});
    await thread.setName(`${PERSON} ${strip(thread.name)}`.slice(0, 90)).catch(() => {});
    const name = HOSTS[host]?.name;
    const onBehalf = name && hostIds()[host] && hostIds()[host] !== i.user.id ? ` (for ${name})` : "";
    await thread.send({ content: `<@${i.user.id}>${onBehalf} has accepted your session request and will confirm the time with you here. 🤝`, allowedMentions: { users: [i.user.id] } });
    await i.message.edit({ content: `${i.message.content}\n\n✅ Accepted by <@${i.user.id}>`, components: [], allowedMentions: { parse: [] } }).catch(() => {});
    log.info("concierge session accepted", { thread: thread.id, by: i.user.id, host });
  }

  /** Adds the team to the thread for something that can't wait. */
  private async bringTeam(thread: ThreadChannel, owner: string, why: string) {
    const teamRoles = this.roleIds(teamRoleNames());
    if (Date.now() - this.membersFetchedAt > 10 * 60_000) {
      await this.guild.members.fetch().catch((e) => log.warn("member fetch failed", errInfo(e)));
      this.membersFetchedAt = Date.now();
    }
    const team = new Set(teamRoles.flatMap((id) => [...(this.guild.roles.cache.get(id)?.members.filter((m) => !m.user.bot).keys() ?? [])]));
    team.delete(owner);
    for (const id of [...team].slice(0, 25)) await thread.members.add(id).catch(() => {});
    await thread.setName(`${PERSON} ${strip(thread.name)}`.slice(0, 90)).catch(() => {});
    const mention = teamRoles.map((id) => `<@&${id}>`).join(" ");
    if (mention) await thread.send({ content: `${mention}, a VIP needs you here.`, allowedMentions: { roles: teamRoles } });
    const ch = await this.bookingsChannel();
    await ch?.send({ content: `🚨 VIP concierge needs the team now, <@${owner}>: ${thread.url}\n> ${why.slice(0, 300)}`, allowedMentions: { parse: [] } }).catch(() => {});
    log.info("concierge team brought in", { thread: thread.id, user: owner, why });
  }

  private async close(i: ButtonInteraction<"cached">) {
    const thread = i.channel?.isThread() ? i.channel : null;
    if (!thread || thread.ownerId !== this.botUserId) return void i.reply({ content: "This button only works in a concierge thread.", flags: MessageFlags.Ephemeral });
    const owner = await this.ownerOf(thread);
    if (i.user.id !== owner && !this.isTeam(i.member)) return void i.reply({ content: "Only the VIP or the team can close this.", flags: MessageFlags.Ephemeral });
    await i.reply({ content: `Closed by <@${i.user.id}>. Press **Open my concierge** in the concierge channel whenever you need us again.`, allowedMentions: { parse: [] } });
    log.info("concierge thread closed", { thread: thread.id, by: i.user.id });
    this.owners.delete(thread.id);
    await thread.setLocked(true, "concierge: closed").catch((e) => log.warn("concierge lock failed", errInfo(e)));
    await thread.setArchived(true, "concierge: closed").catch((e) => log.warn("concierge archive failed", errInfo(e)));
  }
}
