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
import { isLang, LANG_NAMES, type Lang } from "../config.js";
import type { Db } from "../db/index.js";
import { log, errInfo } from "../log.js";
import type { LanguageRoles } from "../roles.js";
import type { SupportAssistant, Turn } from "./assistant.js";
import { guideFile } from "./guides.js";
import { confirmButtons, langName, scriptMismatch, SWITCH_CANCEL, SWITCH_CONFIRM, SWITCH_PICK, SWITCH_TEXT, switchButtons, switchKey } from "./switch.js";
import { relayTranslation, type ThreadTranslator } from "./relay.js";
import { SUPPORT_TEXT } from "./text.js";

export type { ThreadTranslator } from "./relay.js";

export const SUPPORT_OPEN = "support:open";
export const SUPPORT_HUMAN = "support:human";
export const SUPPORT_CLOSE = "support:close";
export const SUPPORT_PREFIX = "support:";

/** Thread names carry the state, so it survives a restart: the assistant answers 🤖 threads, moderators own 🙋 ones. */
const OPEN = "🤖";
/** The team's English twin of a non-English help thread, in the English help-desk. */
const BRIDGE = "🌐";
const HANDED = "🙋";
/** Unanswered questions, or assistant replies, before the moderator button shows anyway. */
const OFFER_AFTER_MISSES = 2;
const OFFER_AFTER_ANSWERS = 3;
/** Assistant replies per thread; past this a person is better value. */
const MAX_ANSWERS = 8;

interface ThreadState {
  userId: string;
  lang: Lang;
  misses: number;
  answers: number;
  /** The moderator button is showing: the assistant guides first and only offers a person when it's needed. */
  offered: boolean;
  handedOff: boolean;
  busy: boolean;
  /** The language buttons were shown in this thread; once is enough. */
  langOffered: boolean;
}

const shots = (x: Message) => [...x.attachments.values()].filter((a) => a.contentType?.startsWith("image/")).map((a) => a.url);

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

function threadButtons(lang: Lang, human = false) {
  const t = SUPPORT_TEXT[lang];
  const row = new ActionRowBuilder<ButtonBuilder>();
  if (human) row.addComponents(new ButtonBuilder().setCustomId(SUPPORT_HUMAN).setStyle(ButtonStyle.Primary).setLabel(t.humanButton).setEmoji("🙋"));
  row.addComponents(new ButtonBuilder().setCustomId(SUPPORT_CLOSE).setStyle(ButtonStyle.Primary).setLabel(t.closeButton));
  return [row];
}

/**
 * Help-desk support threads: a private thread per member, answered by the
 * assistant from the FAQ, handed to the moderators when it can't help.
 */
export class SupportDesk {
  private threads = new Map<string, ThreadState>();
  /** Members whose language switch is under way, so a double tap can't run it twice. */
  private switching = new Set<string>();
  private membersFetchedAt = 0;
  /** Member thread → its team twin, and back (kept in settings too, so restarts keep the link). */
  private bridges = new Map<string, string>();
  private bridgeBack = new Map<string, { memberThread: string; userId: string; lang: Lang }>();

  constructor(
    private guild: Guild,
    private db: Db,
    private roles: LanguageRoles,
    private botUserId: string,
    private assistant: SupportAssistant | null,
    private translator: ThreadTranslator | null = null,
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
    const state: ThreadState = { userId, lang: (member && this.roles.langOf(member)) || "en", misses: 0, answers: 0, offered: false, handedOff, busy: false, langOffered: false };
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
    if (i.customId.startsWith(SWITCH_PICK) || i.customId.startsWith(SWITCH_CONFIRM) || i.customId.startsWith(SWITCH_CANCEL)) {
      return this.onSwitch(i, thread, state);
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
      // Its English twin closes with it.
      const twinId = await this.twinOf(thread.id);
      const twin = twinId ? await this.guild.channels.fetch(twinId).catch(() => null) : null;
      if (twin?.isThread()) {
        await twin.send("✅ The member closed this request.").catch(() => {});
        await twin.setLocked(true, "support: member closed it").catch(() => {});
        await twin.setArchived(true, "support: member closed it").catch(() => {});
      }
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
    this.threads.set(thread.id, { userId: i.user.id, lang, misses: 0, answers: 0, offered: false, handedOff: false, busy: false, langOffered: false });
    log.info("support thread opened", { thread: thread.id, user: i.user.id, lang });
    await i.editReply({ content: fill(t.opened, { link: `<#${thread.id}>` }), components: goTo(lang, thread) });
  }

  async onMessage(m: Message) {
    if (!m.inGuild() || m.guildId !== this.guild.id || m.author.bot || !m.channel.isThread()) return;
    const thread = m.channel;
    if (thread.name.startsWith(BRIDGE)) return this.fromTeam(m, thread);
    const state = await this.stateOf(thread);
    if (!state) return;
    if (state.handedOff) {
      const twin = await this.twinOf(thread.id);
      return twin && m.author.id === state.userId ? this.toTeam(m, state, twin) : this.relay(m, state);
    }
    if (m.author.id !== state.userId) {
      // Someone else speaking up (a moderator stepping in) takes the thread over.
      state.handedOff = true;
      await thread.setName(`${HANDED} ${thread.name.slice(OPEN.length).trim()}`.slice(0, 90)).catch(() => {});
      return this.relay(m, state);
    }
    if (state.busy || (!m.content.trim() && shots(m).length === 0)) return;
    // With the assistant unreachable, the "offline, a moderator is coming" line still goes in the language they wrote in when the script shows it.
    const offline = SUPPORT_TEXT[scriptMismatch(m.content, state.lang) ?? state.lang].unavailable;
    if (!this.assistant) return this.handoff(thread, state, "assistant not configured", offline);
    state.busy = true;
    try {
      await this.reply(thread, state, await this.turnsOf(thread, state));
    } catch (e) {
      log.error("support answer failed", { thread: thread.id, ...errInfo(e) });
      await this.handoff(thread, state, `assistant unreachable (${e instanceof Error ? e.message.slice(0, 80) : "error"}); member asked: ${m.content.slice(0, 200)}`, offline);
    } finally {
      state.busy = false;
    }
  }

  /**
   * Once the team is in a thread (the team works in English), each message gets a translation under it:
   * the member's into English for the team, the team's into the member's language. Nothing for English members.
   */
  private async relay(m: Message, state: ThreadState) {
    return relayTranslation(this.translator, m, state.userId, state.lang);
  }

  private async twinOf(memberThread: string): Promise<string | null> {
    const known = this.bridges.get(memberThread);
    if (known) return known;
    const id = await this.db.getSetting(this.guild.id, `support_bridge:${memberThread}`).catch(() => null);
    if (id) this.bridges.set(memberThread, id);
    return id;
  }

  private async backOf(teamThread: string) {
    const known = this.bridgeBack.get(teamThread);
    if (known) return known;
    const v = await this.db.getSetting(this.guild.id, `support_bridge_back:${teamThread}`).catch(() => null);
    if (!v) return null;
    const [memberThread, userId, lang] = v.split("|");
    const back = { memberThread, userId, lang: lang as Lang };
    this.bridgeBack.set(teamThread, back);
    return back;
  }

  /** Opens the English twin of a non-English help thread with the team in it, and posts the request so far in English. */
  private async openBridge(thread: ThreadChannel, state: ThreadState, mods: string[], summary: string): Promise<boolean> {
    const en = await this.helpChannel("en", null);
    if (!en) return false;
    const member = await this.guild.members.fetch(state.userId).catch(() => null);
    const name = member?.displayName ?? "member";
    const twin = await en.threads.create({
      name: `${BRIDGE} ${LANG_NAMES[state.lang]} · ${name}`.slice(0, 90),
      type: ChannelType.PrivateThread,
      invitable: false,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
      reason: `support: English twin of ${thread.id}`,
    });
    for (const id of mods.slice(0, 25)) await twin.members.add(id).catch(() => {});
    await this.db.setSetting(this.guild.id, `support_bridge:${thread.id}`, twin.id);
    await this.db.setSetting(this.guild.id, `support_bridge_back:${twin.id}`, `${thread.id}|${state.userId}|${state.lang}`);
    this.bridges.set(thread.id, twin.id);
    this.bridgeBack.set(twin.id, { memberThread: thread.id, userId: state.userId, lang: state.lang });
    // What they wrote so far, in English, so the team doesn't start blind.
    const earlier = [...(await thread.messages.fetch({ limit: 15 })).values()].reverse().filter((x) => x.author.id === state.userId && x.content.trim());
    let context = "";
    if (earlier.length && this.translator) {
      const r = await this.translator.translate(earlier.map((x) => x.content), earlier.map(() => []), state.lang, ["en"], []).catch(() => null);
      context = (r?.translations.en ?? earlier.map((x) => x.content)).map((x) => `> ${x.replace(/\n/g, "\n> ")}`).join("\n").slice(0, 1500);
    }
    const roles = this.modRoleIds();
    await twin.send({
      content: [
        `${roles.map((id) => `<@&${id}>`).join(" ")} 🌐 **Help request from <@${state.userId}> in ${LANG_NAMES[state.lang]}.**`,
        "Write here in English: each message is translated and passed to them, and their replies come back here in English.",
        summary ? `-# ${summary.slice(0, 200)}` : "",
        context ? `**So far:**\n${context}` : "",
      ].filter(Boolean).join("\n"),
      allowedMentions: { roles },
    });
    await this.alert(`🛟 ${LANG_NAMES[state.lang]} help request from <@${state.userId}>, answer in English here: ${twin.url}`);
    return true;
  }

  /** The member wrote in their thread: pass it to the team's twin, in English. */
  private async toTeam(m: Message, state: ThreadState, twinId: string) {
    const twin = await this.guild.channels.fetch(twinId).catch(() => null);
    if (!twin?.isThread()) return;
    const text = m.content.trim() ? await this.say(m.content, state.lang, "en") : "";
    const files = [...m.attachments.values()].map((a) => a.url);
    await twin.send({ content: [`**${m.member?.displayName ?? m.author.username}:** ${text}`, text && text !== m.content.trim() ? `-# ${m.content.slice(0, 300)}` : "", ...files].filter(Boolean).join("\n").slice(0, 2000), allowedMentions: { parse: [] } });
  }

  /** The team wrote in the twin: pass it to the member, in their language. */
  private async fromTeam(m: Message, twin: ThreadChannel) {
    const back = await this.backOf(twin.id);
    if (!back) return;
    const thread = await this.guild.channels.fetch(back.memberThread).catch(() => null);
    if (!thread?.isThread()) return;
    if (thread.archived) await thread.setArchived(false).catch(() => {});
    const text = m.content.trim() ? await this.say(m.content, "en", back.lang) : "";
    const files = [...m.attachments.values()].map((a) => a.url);
    await thread.send({ content: [`**${m.member?.displayName ?? m.author.username}** (BLKBöX team): ${text}`, ...files].filter(Boolean).join("\n").slice(0, 2000), allowedMentions: { parse: [] } });
  }

  /** One message translated; the original when translation isn't possible. */
  private async say(text: string, from: Lang, to: Lang): Promise<string> {
    if (!this.translator || from === to) return text;
    const r = await this.translator.translate([text], [[]], from, [to], []).catch(() => null);
    return r?.translated ? r.translations[to]?.[0] ?? text : text;
  }

  /** The thread so far, oldest first, as the assistant reads it. */
  private async turnsOf(thread: ThreadChannel, state: ThreadState): Promise<Turn[]> {
    const history = [...(await thread.messages.fetch({ limit: 20 })).values()].reverse();
    return history
      .filter((x) => x.content.trim() || shots(x).length)
      .map((x) => ({
        from: x.author.id === this.botUserId ? "assistant" : x.author.id === state.userId ? "member" : "moderator",
        text: x.content,
        images: x.author.id === state.userId ? shots(x) : undefined,
        // Guides go out named guide-<key>.png, so the thread itself records which ones were sent.
        guides: x.author.id === this.botUserId ? [...x.attachments.values()].map((f) => /^guide-(.+)\.png$/.exec(f.name)?.[1]).filter((g): g is string => !!g) : undefined,
      }));
  }

  /** One assistant answer posted in the thread, plus the moderator or language buttons when they're due. */
  private async reply(thread: ThreadChannel, state: ThreadState, turns: Turn[]) {
    if (!this.assistant) return;
    await thread.sendTyping().catch(() => {});
    const a = await this.assistant.answer(state.lang, turns);
    state.answers++;
    if (!a.answered) state.misses++;
    // Wrong language: the language buttons, once per thread and once per member; after that a moderator.
    // The script check backs up the model, which can miss it (English in a Japanese thread).
    const latest = [...turns].reverse().find((t) => t.from === "member")?.text ?? "";
    const byScript = scriptMismatch(latest, state.lang);
    const suggested = a.switchTo ?? byScript;
    const wrongLang = (a.wrongLanguage || !!byScript) && !state.langOffered && !a.handoff;
    const switchUsed = wrongLang && !!(await this.db.getSetting(this.guild.id, switchKey(state.userId)));
    if (wrongLang) state.langOffered = true;
    // Only a safety report brings the moderators in straight away; otherwise the member gets the button when it's needed.
    const handoff = a.handoff || state.answers >= MAX_ANSWERS;
    const nudge = !state.offered && !a.offerHuman && !switchUsed && (state.misses >= OFFER_AFTER_MISSES || state.answers >= OFFER_AFTER_ANSWERS);
    state.offered ||= a.offerHuman || nudge || switchUsed;
    // The bot's own copy (buttons, hints, guides) goes in the language the member writes in, like the answer.
    const offerLang = suggested ?? state.lang;
    const files = a.guides.map((g) => ({ attachment: guideFile(g, offerLang), name: `guide-${g}.png` }));
    const content = [a.reply.trim(), nudge ? SUPPORT_TEXT[offerLang].offerHint : "", switchUsed ? SWITCH_TEXT[offerLang].used : ""].filter(Boolean).join("\n\n");
    if (content) await thread.send({ content: content.slice(0, 1900), files, components: threadButtons(offerLang, state.offered && !handoff), allowedMentions: { parse: [] } });
    if (wrongLang && !switchUsed) {
      await thread.send({ content: `🌐 ${SWITCH_TEXT[offerLang].offer}`, components: switchButtons(state.lang, suggested), allowedMentions: { parse: [] } });
    }
    log.info("support answer", { thread: thread.id, answered: a.answered, offered: state.offered, handoff, guides: a.guides, wrongLanguage: a.wrongLanguage, byScript, switchTo: suggested, model: this.assistant.model });
    if (handoff) await this.handoff(thread, state, a.summary || [...turns].reverse().find((t) => t.from === "member")?.text.slice(0, 200) || "");
  }

  /**
   * The language buttons under a wrong-language answer. Unverified members
   * switch on the tap; verified ones confirm first, since more moves with them.
   * Either way the help thread moves to the new language's help-desk (the old
   * one closes, as the member can no longer see it) and the answer follows.
   */
  private async onSwitch(i: ButtonInteraction<"cached">, thread: ThreadChannel, state: ThreadState) {
    if (i.user.id !== state.userId) {
      return void i.reply({ content: "Only the member who opened this thread can change their language. Moderators: use /language member.", flags: MessageFlags.Ephemeral });
    }
    const id = i.customId;
    const lang = id.slice((id.startsWith(SWITCH_CONFIRM) ? SWITCH_CONFIRM : id.startsWith(SWITCH_PICK) ? SWITCH_PICK : SWITCH_CANCEL).length);
    if (!isLang(lang)) return void i.deferUpdate();
    const t = SWITCH_TEXT[lang];
    if (id.startsWith(SWITCH_CANCEL)) return void i.update({ content: t.cancelled, components: [] });
    const confirmed = id.startsWith(SWITCH_CONFIRM);
    const member = await this.guild.members.fetch({ user: i.user.id, force: true });
    const current = this.roles.langOf(member);
    if (current === lang) return void (confirmed ? i.update({ content: t.cancelled, components: [] }) : i.deferUpdate());
    if (await this.db.getSetting(this.guild.id, switchKey(member.id))) {
      state.offered = true;
      const used = { content: t.used, components: threadButtons(lang, true) };
      return void (confirmed ? i.update(used) : i.reply({ ...used, flags: MessageFlags.Ephemeral }));
    }
    if (!confirmed && this.roles.isVerified(member)) {
      return void i.reply({ content: fill(t.confirm, { lang: langName(lang) }), components: confirmButtons(lang), flags: MessageFlags.Ephemeral });
    }
    if (this.switching.has(member.id)) return void i.deferUpdate();
    this.switching.add(member.id);
    try {
      if (confirmed) await i.update({ content: "⏳", components: [] });
      else await i.deferReply({ flags: MessageFlags.Ephemeral });
      // Recorded first, so a failure halfway can't be retried into a second free switch.
      await this.db.setSetting(this.guild.id, switchKey(member.id), JSON.stringify({ from: current, to: lang, at: new Date().toISOString() }));
      const moved = await this.roles.switchSelf(member, lang);
      if (!moved) return void (await i.editReply({ content: "This language is not available yet.", components: [] }));
      const target = await this.moveThread(thread, state, lang);
      const lines = [fill(t.switched, { link: `<#${target.id}>` }), moved.verified ? t.keptVerified : t.verifyHint];
      await i.editReply({ content: lines.join("\n"), components: target.id === thread.id ? [] : goTo(lang, target) });
      if (moved.verified) await this.alert(`🌐 <@${member.id}> switched their language ${current ?? "?"} → ${lang} from help-desk (verified, still verified): ${target.url}`);
    } catch (e) {
      log.error("support language switch failed", { user: member.id, lang, ...errInfo(e) });
      await i.editReply({ content: SUPPORT_TEXT[lang].unavailable, components: [] }).catch(() => {});
      await this.handoff(thread, state, `language switch to ${lang} failed`);
    } finally {
      this.switching.delete(member.id);
    }
  }

  /**
   * After a switch: a new thread in the new language's help-desk, answered
   * there from the old thread's conversation. When that language has no
   * help-desk of its own the old thread carries on in the new language.
   */
  private async moveThread(old: ThreadChannel, state: ThreadState, lang: Lang): Promise<ThreadChannel> {
    const turns = await this.turnsOf(old, state);
    const channel = await this.helpChannel(lang, null);
    let thread = old;
    let next = state;
    if (channel && channel.id !== old.parentId) {
      thread = await channel.threads.create({
        name: `${OPEN} ${old.name.replace(HANDED, "").replace(OPEN, "").trim()}`.slice(0, 90),
        type: ChannelType.PrivateThread,
        invitable: false,
        autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
        reason: `support thread for ${state.userId}, moved to ${lang}`,
      });
      await thread.members.add(state.userId);
      next = { ...state, lang, busy: false, langOffered: true };
      this.threads.set(thread.id, next);
      await old.send({ content: fill(SWITCH_TEXT[lang].moved, { link: `<#${thread.id}>` }), allowedMentions: { parse: [] } }).catch(() => {});
      this.threads.delete(old.id);
      await old.setLocked(true, "support: member switched language").catch((e) => log.warn("support lock failed", errInfo(e)));
      await old.setArchived(true, "support: member switched language").catch((e) => log.warn("support archive failed", errInfo(e)));
    } else {
      state.lang = lang;
      state.langOffered = true;
    }
    log.info("support thread moved", { from: old.id, to: thread.id, user: state.userId, lang });
    const asked = turns.some((x) => x.from === "member");
    const intro = asked && this.assistant && !next.handedOff ? SWITCH_TEXT[lang].intro : SUPPORT_TEXT[lang].intro;
    await thread.send({ content: fill(intro, { user: `<@${state.userId}>`, lang: langName(lang) }), components: threadButtons(lang, next.offered), allowedMentions: { users: [state.userId] } });
    if (next.handedOff) {
      // Moderators were already on it: they follow the member to the new thread.
      if (thread.id !== old.id) {
        next.handedOff = false;
        await this.handoff(thread, next, "member switched language; thread moved");
      }
    } else if (asked && this.assistant) {
      next.busy = true;
      await this.reply(thread, next, turns)
        .catch((e) => (log.error("support answer failed", { thread: thread.id, ...errInfo(e) }), this.handoff(thread, next, "assistant error after a language switch", SUPPORT_TEXT[lang].unavailable)))
        .finally(() => (next.busy = false));
    }
    return thread;
  }

  /** A line in #mod-chat, when one is set. */
  private async alert(content: string) {
    const alertId = (process.env.SUPPORT_ALERT_CHANNEL_ID ?? process.env.VERIFY_ALERT_CHANNEL_ID)?.trim();
    if (!alertId) return;
    const ch = await this.guild.channels.fetch(alertId).catch(() => null);
    if (ch?.isTextBased() && "send" in ch) await ch.send({ content, allowedMentions: { parse: [] } }).catch((e) => log.warn("support alert send failed", errInfo(e)));
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
    const t = SUPPORT_TEXT[state.lang];
    // The team works in English: a non-English request gets a twin thread in the English help-desk instead,
    // and the bot carries messages both ways, translated (JT, 1 Nov).
    if (state.lang !== "en" && this.translator && (await this.openBridge(thread, state, [...mods], summary))) {
      await thread.send({ content: [lead, fill(t.handedOff, { mods: "" }).trim()].filter(Boolean).join("\n"), allowedMentions: { parse: [] } });
      log.info("support handed off", { thread: thread.id, user: state.userId, lang: state.lang, summary, bridged: true });
      return;
    }
    for (const id of [...mods].slice(0, 25)) await thread.members.add(id).catch(() => {});
    const mention = modRoles.map((id) => `<@&${id}>`).join(" ") || "Moderators,";
    await thread.send({ content: [lead, fill(t.handedOff, { mods: mention })].filter(Boolean).join("\n"), allowedMentions: { roles: modRoles } });
    log.info("support handed off", { thread: thread.id, user: state.userId, lang: state.lang, summary });

    await this.alert(`🛟 Help thread needs a moderator (${state.lang}) from <@${state.userId}>: ${thread.url}\n> ${summary.slice(0, 300)}`);
  }
}
