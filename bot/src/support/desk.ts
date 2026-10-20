import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionFlagsBits as P,
  ThreadAutoArchiveDuration,
  type ButtonInteraction,
  type Guild,
  type GuildMember,
  type Message,
  type ThreadChannel,
} from "discord.js";
import { LANG_NAMES, type Lang } from "../config.js";
import type { Db } from "../db/index.js";
import { errInfo, log } from "../log.js";
import type { LanguageRoles } from "../roles.js";
import { SUPPORT_TEXT } from "./text.js";

export const SUPPORT_OPEN = "support:open";
export const SUPPORT_HUMAN = "support:human";
export const SUPPORT_CLOSE = "support:close";
export const SUPPORT_PREFIX = "support:";

const FAQ_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", "support", "faq.md");
/** AI replies before the thread goes to a moderator on its own: past this, the FAQ is not getting them there. */
const MAX_AI_REPLIES = 3;
/** Messages of thread history sent with each question. */
const HISTORY = 20;

interface ThreadState {
  userId: string;
  lang: Lang;
  handedOff: boolean;
  replies: number;
}

const fill = (s: string, vars: Record<string, string>) => s.replace(/\{(\w+)\}/g, (m, k) => vars[k] ?? m);

/** The help-desk panel: one button that opens a private support thread. */
export function supportPanel(lang: Lang) {
  const t = SUPPORT_TEXT[lang];
  return {
    content: `## ☎️ ${t.panelTitle}\n${t.panelBody}`,
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(SUPPORT_OPEN).setStyle(ButtonStyle.Success).setLabel(t.openButton).setEmoji("🎟️"),
      ),
    ],
  };
}

function threadButtons(lang: Lang, handedOff: boolean) {
  const t = SUPPORT_TEXT[lang];
  const row = new ActionRowBuilder<ButtonBuilder>();
  if (!handedOff) row.addComponents(new ButtonBuilder().setCustomId(SUPPORT_HUMAN).setStyle(ButtonStyle.Primary).setLabel(t.humanButton).setEmoji("🧑‍💼"));
  row.addComponents(new ButtonBuilder().setCustomId(SUPPORT_CLOSE).setStyle(ButtonStyle.Secondary).setLabel(t.closeButton).setEmoji("✅"));
  return [row];
}

const SYSTEM = `You are the BLKBöX help-desk assistant inside the BLKBöX Discord server, answering one member in a private support thread.

Rules:
- Answer only from the FAQ below. Do not guess, and do not use outside knowledge about BLKBöX, exchanges or the server.
- If the FAQ does not answer the question, or the member asks for a person, wants to report a user, or raises a bug, a payment, an account problem or anything only staff can check, set handoff to true. Then the reply is one or two sentences saying a moderator will take over here, with no other facts and no questions.
- When the FAQ answers it, set handoff to false. If staff might still be needed, end by pointing to the "Talk to a moderator" button below instead of asking whether they want one.
- Never state something the FAQ does not say, even to correct the member.
- Never give financial or trading advice, price predictions or opinions on what to buy or sell. Say it is not something you can help with.
- Never ask for passwords, seed phrases, API keys or personal documents. A UID is fine.
- Write in {LANG}, whatever language the member writes in. Keep it short and friendly: a few sentences or a short list. Use Discord markdown. Keep links exactly as the FAQ gives them.
- Small talk ("thanks", "ok") gets a short friendly reply with handoff false.

FAQ:
`;

const Reply = z.object({
  reply: z.string().describe("The message to post in the thread, in the member's language."),
  handoff: z.boolean().describe("True when a moderator should take over."),
});

/** One assistant turn: the reply to post and whether a moderator should take over. Null when the model refused. */
export async function askAssistant(client: Anthropic, model: string, lang: Lang, turns: { role: "user" | "assistant"; content: string }[]) {
  const faq = readFileSync(FAQ_PATH, "utf8");
  const response = await client.messages.parse({
    model,
    max_tokens: 1024,
    system: [{ type: "text", text: SYSTEM.replace("{LANG}", LANG_NAMES[lang]) + faq, cache_control: { type: "ephemeral" } }],
    messages: turns,
    output_config: { format: zodOutputFormat(Reply) },
  });
  return response.stop_reason === "refusal" ? null : response.parsed_output ?? null;
}

/**
 * Private support threads in help-desk. A member presses the panel button, gets
 * a thread only they and staff can see, and an assistant answers from
 * assets/support/faq.md. It hands the thread to a moderator when the FAQ falls
 * short, when asked to, or after a few replies that did not settle it.
 *
 * Thread state lives in the settings table, so a restart picks up where it was.
 */
export class SupportDesk {
  private client: Anthropic;
  private model = process.env.SUPPORT_MODEL?.trim() || "claude-haiku-4-5";
  private staffRoleNames = (process.env.SUPPORT_STAFF_ROLES ?? "Moderators").split(",").map((s) => s.trim()).filter(Boolean);
  private alertChannelId = process.env.SUPPORT_ALERT_CHANNEL_ID?.trim();
  /** One question at a time per thread, in order. */
  private chains = new Map<string, Promise<void>>();

  constructor(private guild: Guild, private db: Db, private roles: LanguageRoles) {
    this.client = new Anthropic();
  }

  private key = (threadId: string) => `support:thread:${threadId}`;
  private async state(threadId: string): Promise<ThreadState | null> {
    const raw = await this.db.getSetting(this.guild.id, this.key(threadId));
    return raw ? (JSON.parse(raw) as ThreadState) : null;
  }
  private save(threadId: string, s: ThreadState) {
    return this.db.setSetting(this.guild.id, this.key(threadId), JSON.stringify(s));
  }

  private staffRoleIds() {
    return this.guild.roles.cache.filter((r) => this.staffRoleNames.includes(r.name)).map((r) => r.id);
  }
  private isStaff(member: GuildMember) {
    return member.permissions.has(P.ManageThreads) || this.staffRoleIds().some((id) => member.roles.cache.has(id));
  }

  handleButton(i: ButtonInteraction) {
    const run = i.customId === SUPPORT_OPEN ? this.open(i) : i.customId === SUPPORT_HUMAN ? this.human(i) : i.customId === SUPPORT_CLOSE ? this.close(i) : null;
    void run?.catch(async (e) => {
      log.error("support button failed", { id: i.customId, ...errInfo(e) });
      const msg = SUPPORT_TEXT.en.unavailable;
      await (i.deferred || i.replied ? i.editReply(msg) : i.reply({ content: msg, ephemeral: true })).catch(() => {});
    });
  }

  private async open(i: ButtonInteraction) {
    if (!i.inCachedGuild()) return;
    await i.deferReply({ ephemeral: true });
    const member = await i.guild.members.fetch(i.user.id);
    const lang = this.roles.langOf(member) ?? "en";
    const t = SUPPORT_TEXT[lang];

    // One open thread per member.
    const userKey = `support:user:${member.id}`;
    const existingId = await this.db.getSetting(this.guild.id, userKey);
    if (existingId) {
      const existing = await this.guild.channels.fetch(existingId).catch(() => null);
      if (existing?.isThread() && !existing.archived && !existing.locked) {
        await i.editReply(fill(t.alreadyOpen, { thread: `<#${existing.id}>` }));
        return;
      }
    }

    // The member's own help-desk; the button may sit elsewhere (the server guide).
    const channelId = (await this.db.getSetting(this.guild.id, `support:channel:${lang}`)) ?? i.channelId;
    const parent = await this.guild.channels.fetch(channelId).catch(() => null);
    if (!parent || parent.type !== ChannelType.GuildText) {
      await i.editReply(t.unavailable);
      return;
    }
    const thread = await parent.threads.create({
      name: `🎟️ ${member.displayName}`.slice(0, 100),
      type: ChannelType.PrivateThread,
      invitable: false,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
      reason: `support thread for ${member.user.tag}`,
    });
    await thread.members.add(member.id);
    const state: ThreadState = { userId: member.id, lang, handedOff: false, replies: 0 };
    await this.save(thread.id, state);
    await this.db.setSetting(this.guild.id, userKey, thread.id);
    await thread.send({ content: fill(t.greeting, { user: `<@${member.id}>` }), components: threadButtons(lang, false), allowedMentions: { users: [member.id] } });
    log.info("support thread opened", { user: member.id, lang, thread: thread.id });
    await i.editReply(fill(t.opened, { thread: `<#${thread.id}>` }));
  }

  private async human(i: ButtonInteraction) {
    if (!i.inCachedGuild() || !i.channel?.isThread()) return;
    const state = await this.state(i.channel.id);
    if (!state) return;
    const member = await i.guild.members.fetch(i.user.id);
    if (member.id !== state.userId && !this.isStaff(member)) {
      await i.reply({ content: SUPPORT_TEXT[state.lang].notYours, ephemeral: true });
      return;
    }
    await i.deferUpdate();
    await this.handoff(i.channel, state, "asked for a moderator");
  }

  private async close(i: ButtonInteraction) {
    if (!i.inCachedGuild() || !i.channel?.isThread()) return;
    const thread = i.channel;
    const state = await this.state(thread.id);
    if (!state) return;
    const member = await i.guild.members.fetch(i.user.id);
    if (member.id !== state.userId && !this.isStaff(member)) {
      await i.reply({ content: SUPPORT_TEXT[state.lang].notYours, ephemeral: true });
      return;
    }
    await i.reply(SUPPORT_TEXT[state.lang].closed);
    log.info("support thread closed", { thread: thread.id, by: member.id, handedOff: state.handedOff, replies: state.replies });
    await this.db.setSetting(this.guild.id, `support:user:${state.userId}`, "");
    await thread.setLocked(true, "support thread closed").catch(() => {});
    await thread.setArchived(true, "support thread closed");
  }

  /** Bring staff into the thread and stop answering in it. */
  private async handoff(thread: ThreadChannel, state: ThreadState, reason: string, summary?: string) {
    if (state.handedOff) return;
    state.handedOff = true;
    await this.save(thread.id, state);
    const roleIds = this.staffRoleIds();
    // Mentioning a role in a private thread only pulls in members it can see, so add staff outright.
    await this.guild.members.fetch().catch(() => {});
    const staff = this.guild.members.cache.filter((m) => !m.user.bot && roleIds.some((id) => m.roles.cache.has(id))).first(25);
    for (const m of staff) await thread.members.add(m.id).catch(() => {});
    await thread.send({
      content: `${SUPPORT_TEXT[state.lang].handoff}\n-# ${roleIds.map((id) => `<@&${id}>`).join(" ")} · ${reason}${summary ? `: ${summary}` : ""}`,
      components: threadButtons(state.lang, true),
      allowedMentions: { roles: roleIds },
    });
    log.info("support handed off", { thread: thread.id, user: state.userId, reason });
    if (this.alertChannelId) {
      const ch = await this.guild.channels.fetch(this.alertChannelId).catch(() => null);
      if (ch?.isTextBased() && "send" in ch) {
        await ch.send(`🎟️ <@${state.userId}> (${state.lang}) needs a moderator in <#${thread.id}>: ${reason}${summary ? `\n> ${summary.slice(0, 300)}` : ""}`).catch((e) => log.warn("support alert failed", errInfo(e)));
      }
    }
  }

  onMessage(m: Message) {
    if (!m.inGuild() || m.guildId !== this.guild.id || m.author.bot || !m.channel.isThread() || m.channel.type !== ChannelType.PrivateThread) return;
    const thread = m.channel;
    const prev = this.chains.get(thread.id) ?? Promise.resolve();
    const next = prev.then(() => this.answer(thread, m)).catch((e) => log.error("support answer failed", { thread: thread.id, ...errInfo(e) }));
    this.chains.set(thread.id, next);
    void next.finally(() => { if (this.chains.get(thread.id) === next) this.chains.delete(thread.id); });
  }

  private async answer(thread: ThreadChannel, m: Message) {
    const state = await this.state(thread.id);
    if (!state || state.handedOff) return;
    // A moderator talking means a person has it now.
    if (m.author.id !== state.userId) {
      const member = await this.guild.members.fetch(m.author.id).catch(() => null);
      if (member && this.isStaff(member)) {
        state.handedOff = true;
        await this.save(thread.id, state);
      }
      return;
    }
    if (state.replies >= MAX_AI_REPLIES) {
      await this.handoff(thread, state, "the assistant could not settle it", m.content.slice(0, 200));
      return;
    }
    await thread.sendTyping().catch(() => {});

    const history = [...(await thread.messages.fetch({ limit: HISTORY })).values()].reverse();
    const turns: { role: "user" | "assistant"; content: string }[] = [];
    for (const h of history) {
      const role = h.author.id === state.userId ? "user" : h.author.id === this.guild.members.me?.id ? "assistant" : null;
      const text = h.content.trim();
      if (!role || !text) continue;
      const last = turns.at(-1);
      if (last?.role === role) last.content += `\n${text}`;
      else turns.push({ role, content: text });
    }
    // The API wants the conversation to open with the member; the greeting is ours.
    while (turns[0]?.role === "assistant") turns.shift();
    if (!turns.length) return;

    const out = await askAssistant(this.client, this.model, state.lang, turns);
    if (!out) {
      await this.handoff(thread, state, "the assistant could not answer", m.content.slice(0, 200));
      return;
    }
    state.replies += 1;
    await this.save(thread.id, state);
    log.info("support answered", { thread: thread.id, lang: state.lang, handoff: out.handoff, replies: state.replies });
    if (out.handoff) {
      await thread.send({ content: out.reply.slice(0, 2000), allowedMentions: { parse: [] } });
      await this.handoff(thread, state, "not covered by the FAQ", m.content.slice(0, 200));
      return;
    }
    await thread.send({ content: out.reply.slice(0, 2000), components: threadButtons(state.lang, false), allowedMentions: { parse: [] } });
  }
}
