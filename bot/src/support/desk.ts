import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  ThreadAutoArchiveDuration,
  type ButtonInteraction,
  type Guild,
  type GuildMember,
  type Message,
  type TextChannel,
  type ThreadChannel,
} from "discord.js";
import { isLang, type Lang } from "../config.js";
import type { Db } from "../db/index.js";
import { log, errInfo } from "../log.js";
import type { LanguageRoles } from "../roles.js";
import type { SupportAssistant, Turn } from "./assistant.js";
import { guideFile } from "./guides.js";
import { SUPPORT_TEXT } from "./text.js";

export const SUPPORT_OPEN = "support:open";
export const SUPPORT_HUMAN = "support:human";
export const SUPPORT_CLOSE = "support:close";
export const SUPPORT_PREFIX = "support:";

/** Thread names carry the state, so it survives a restart: the assistant answers 🤖 threads, moderators own 🙋 ones. */
const OPEN = "🤖";
const HANDED = "🙋";
/** Unanswered questions before a moderator is called in anyway. */
const MAX_MISSES = 2;
/** Assistant replies per thread; past this a person is better value. */
const MAX_ANSWERS = 8;

interface ThreadState {
  userId: string;
  lang: Lang;
  misses: number;
  answers: number;
  handedOff: boolean;
  busy: boolean;
}

const fill = (s: string, vars: Record<string, string>) => s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");

/** The pinned message in help-desk that opens a thread. */
export function supportPanel(lang: Lang = "en") {
  const t = SUPPORT_TEXT[lang];
  return {
    content: [`## 🛟 ${t.panelTitle}`, t.panelBody].join("\n"),
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(SUPPORT_OPEN).setStyle(ButtonStyle.Primary).setLabel(t.openButton).setEmoji("🛟"),
      ),
    ],
  };
}

/** A link button to the thread: easier to find than a mention for someone new to Discord. */
function goTo(lang: Lang, thread: ThreadChannel) {
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(thread.url).setLabel(SUPPORT_TEXT[lang].goButton).setEmoji("🛟"))];
}

function threadButtons(lang: Lang, human = true) {
  const t = SUPPORT_TEXT[lang];
  const row = new ActionRowBuilder<ButtonBuilder>();
  if (human) row.addComponents(new ButtonBuilder().setCustomId(SUPPORT_HUMAN).setStyle(ButtonStyle.Secondary).setLabel(t.humanButton).setEmoji("🙋"));
  row.addComponents(new ButtonBuilder().setCustomId(SUPPORT_CLOSE).setStyle(ButtonStyle.Danger).setLabel(t.closeButton));
  return [row];
}

/**
 * Help-desk support threads: a private thread per member, answered by the
 * assistant from the FAQ, handed to the moderators when it can't help.
 */
export class SupportDesk {
  private threads = new Map<string, ThreadState>();
  private membersFetchedAt = 0;

  constructor(
    private guild: Guild,
    private db: Db,
    private roles: LanguageRoles,
    private botUserId: string,
    private assistant: SupportAssistant | null,
  ) {}

  private modRoleIds() {
    const names = (process.env.SUPPORT_MOD_ROLES ?? "Moderators").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    return this.guild.roles.cache.filter((r) => names.includes(r.name.toLowerCase())).map((r) => r.id);
  }

  isMod(member: GuildMember) {
    const mods = new Set(this.modRoleIds());
    return member.permissions.has(PermissionFlagsBits.ManageThreads) || member.roles.cache.some((r) => mods.has(r.id));
  }

  /** The help-desk a member's thread goes in: their language's, else the channel the button was in. */
  private async helpChannel(lang: Lang, fallback: string | null): Promise<TextChannel | null> {
    const id = (await this.db.getSetting(this.guild.id, `support_channel:${lang}`)) ?? fallback;
    const ch = id ? await this.guild.channels.fetch(id).catch(() => null) : null;
    return ch?.type === ChannelType.GuildText ? ch : null;
  }

  /** State for one of our threads, rebuilt from its name and opening message after a restart. */
  private async stateOf(thread: ThreadChannel): Promise<ThreadState | null> {
    const known = this.threads.get(thread.id);
    if (known) return known;
    if (thread.ownerId !== this.botUserId || thread.type !== ChannelType.PrivateThread) return null;
    const handedOff = thread.name.startsWith(HANDED);
    if (!handedOff && !thread.name.startsWith(OPEN)) return null;
    // The intro is the bot's first message that mentions someone; "user added" system messages come before it.
    const opening = await thread.messages.fetch({ after: "0", limit: 5 }).catch(() => null);
    const intro = opening && [...opening.values()].reverse().find((x) => x.author.id === this.botUserId && x.mentions.users.size > 0);
    const userId = intro?.mentions.users.first()?.id;
    if (!userId) return null;
    const member = await this.guild.members.fetch(userId).catch(() => null);
    const state: ThreadState = { userId, lang: (member && this.roles.langOf(member)) || "en", misses: 0, answers: 0, handedOff, busy: false };
    this.threads.set(thread.id, state);
    return state;
  }

  async onButton(i: ButtonInteraction<"cached">) {
    if (i.customId === SUPPORT_OPEN) return this.open(i);
    const thread = i.channel?.isThread() ? i.channel : null;
    const state = thread && (await this.stateOf(thread));
    if (!thread || !state) return void i.reply({ content: "This button only works in a help thread.", flags: MessageFlags.Ephemeral });
    if (i.user.id !== state.userId && !this.isMod(i.member)) {
      return void i.reply({ content: "Only the member who opened this thread or a moderator can do that.", flags: MessageFlags.Ephemeral });
    }
    if (i.customId === SUPPORT_HUMAN) {
      if (state.handedOff) return void i.deferUpdate();
      await i.deferUpdate();
      return this.handoff(thread, state, "member pressed Talk to a mod");
    }
    if (i.customId === SUPPORT_CLOSE) {
      await i.reply({ content: SUPPORT_TEXT[state.lang].closed, components: [] });
      this.threads.delete(thread.id);
      log.info("support thread closed", { thread: thread.id, by: i.user.id, answers: state.answers, handedOff: state.handedOff });
      await thread.setLocked(true, "support: closed").catch((e) => log.warn("support lock failed", errInfo(e)));
      await thread.setArchived(true, "support: closed").catch((e) => log.warn("support archive failed", errInfo(e)));
    }
  }

  private async open(i: ButtonInteraction<"cached">) {
    const lang = this.roles.langOf(i.member) ?? (isLang(i.locale.slice(0, 2)) ? (i.locale.slice(0, 2) as Lang) : "en");
    const t = SUPPORT_TEXT[lang];
    for (const [id, s] of this.threads) {
      if (s.userId !== i.user.id) continue;
      const existing = await this.guild.channels.fetch(id).catch(() => null);
      if (existing?.isThread() && !existing.archived) {
        return void i.reply({ content: fill(t.already, { link: `<#${existing.id}>` }), components: goTo(lang, existing), flags: MessageFlags.Ephemeral });
      }
      this.threads.delete(id);
    }
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const channel = await this.helpChannel(lang, i.channelId);
    if (!channel) return void i.editReply("Help-desk isn't set up here yet. Please ask a moderator.");
    const thread = await channel.threads.create({
      name: `${OPEN} ${i.member.displayName}`.slice(0, 90),
      type: ChannelType.PrivateThread,
      invitable: false,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
      reason: `support thread for ${i.user.id}`,
    });
    await thread.members.add(i.user.id);
    await thread.send({ content: fill(t.intro, { user: `<@${i.user.id}>` }), components: threadButtons(lang), allowedMentions: { users: [i.user.id] } });
    this.threads.set(thread.id, { userId: i.user.id, lang, misses: 0, answers: 0, handedOff: false, busy: false });
    log.info("support thread opened", { thread: thread.id, user: i.user.id, lang });
    await i.editReply({ content: fill(t.opened, { link: `<#${thread.id}>` }), components: goTo(lang, thread) });
  }

  async onMessage(m: Message) {
    if (!m.inGuild() || m.guildId !== this.guild.id || m.author.bot || !m.channel.isThread()) return;
    const thread = m.channel;
    const state = await this.stateOf(thread);
    if (!state || state.handedOff) return;
    if (m.author.id !== state.userId) {
      // Someone else speaking up (a moderator stepping in) takes the thread over.
      state.handedOff = true;
      await thread.setName(`${HANDED} ${thread.name.slice(OPEN.length).trim()}`.slice(0, 90)).catch(() => {});
      return;
    }
    const shots = (x: Message) => [...x.attachments.values()].filter((a) => a.contentType?.startsWith("image/")).map((a) => a.url);
    if (state.busy || (!m.content.trim() && shots(m).length === 0)) return;
    if (!this.assistant) return this.handoff(thread, state, "assistant not configured", SUPPORT_TEXT[state.lang].unavailable);
    state.busy = true;
    try {
      await thread.sendTyping().catch(() => {});
      const history = [...(await thread.messages.fetch({ limit: 20 })).values()].reverse();
      const turns: Turn[] = history
        .filter((x) => x.content.trim() || shots(x).length)
        .map((x) => ({
          from: x.author.id === this.botUserId ? "assistant" : x.author.id === state.userId ? "member" : "moderator",
          text: x.content,
          images: x.author.id === state.userId ? shots(x) : undefined,
          // Guides go out named guide-<key>.png, so the thread itself records which ones were sent.
          guides: x.author.id === this.botUserId ? [...x.attachments.values()].map((f) => /^guide-(.+)\.png$/.exec(f.name)?.[1]).filter((g): g is string => !!g) : undefined,
        }));
      const a = await this.assistant.answer(state.lang, turns);
      state.answers++;
      if (!a.answered) state.misses++;
      const handoff = a.handoff || state.misses >= MAX_MISSES || state.answers >= MAX_ANSWERS;
      const files = a.guides.map((g) => ({ attachment: guideFile(g, state.lang), name: `guide-${g}.png` }));
      if (a.reply.trim()) await thread.send({ content: a.reply.slice(0, 1900), files, components: threadButtons(state.lang, !handoff), allowedMentions: { parse: [] } });
      log.info("support answer", { thread: thread.id, answered: a.answered, handoff, guides: a.guides, model: this.assistant.model });
      if (handoff) await this.handoff(thread, state, a.summary || m.content.slice(0, 200));
    } catch (e) {
      log.error("support answer failed", { thread: thread.id, ...errInfo(e) });
      await this.handoff(thread, state, `assistant error; member asked: ${m.content.slice(0, 200)}`, SUPPORT_TEXT[state.lang].unavailable);
    } finally {
      state.busy = false;
    }
  }

  /** Brings the moderators into the thread and tells #mod-chat. The assistant stays quiet from here on. */
  private async handoff(thread: ThreadChannel, state: ThreadState, summary: string, lead?: string) {
    if (state.handedOff) return;
    state.handedOff = true;
    const modRoles = this.modRoleIds();
    await thread.setName(`${HANDED} ${thread.name.replace(OPEN, "").trim()}`.slice(0, 90), "support: handed to moderators").catch((e) => log.warn("support rename failed", errInfo(e)));
    // A private thread only shows to the people in it, so the moderators are added, not just pinged.
    if (Date.now() - this.membersFetchedAt > 10 * 60_000) {
      await this.guild.members.fetch().catch((e) => log.warn("member fetch failed", errInfo(e)));
      this.membersFetchedAt = Date.now();
    }
    const mods = new Set(modRoles.flatMap((id) => [...(this.guild.roles.cache.get(id)?.members.keys() ?? [])]));
    for (const id of [...mods].slice(0, 25)) await thread.members.add(id).catch(() => {});
    const t = SUPPORT_TEXT[state.lang];
    const mention = modRoles.map((id) => `<@&${id}>`).join(" ") || "Moderators,";
    await thread.send({ content: [lead, fill(t.handedOff, { mods: mention })].filter(Boolean).join("\n"), allowedMentions: { roles: modRoles } });
    log.info("support handed off", { thread: thread.id, user: state.userId, lang: state.lang, summary });

    const alertId = (process.env.SUPPORT_ALERT_CHANNEL_ID ?? process.env.VERIFY_ALERT_CHANNEL_ID)?.trim();
    if (!alertId) return;
    const alert = await this.guild.channels.fetch(alertId).catch(() => null);
    if (alert?.isTextBased() && "send" in alert) {
      await alert.send({ content: `🛟 Help thread needs a moderator (${state.lang}) from <@${state.userId}>: ${thread.url}\n> ${summary.slice(0, 300)}`, allowedMentions: { parse: [] } })
        .catch((e) => log.warn("support alert send failed", errInfo(e)));
    }
  }
}
