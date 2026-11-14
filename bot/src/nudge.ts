import { PermissionFlagsBits, type Guild, type GuildMember, type Message } from "discord.js";
import type { Lang } from "./config.js";
import type { Db } from "./db/index.js";
import type { Funnel } from "./funnel.js";
import { log } from "./log.js";
import type { GroupIndex } from "./mirror/groups.js";
import type { LanguageRoles } from "./roles.js";
import { keywordChannel, type ChannelKey } from "./telegram/classify.js";
import { verifyButtonRow } from "./verify/panel.js";

/**
 * Nudges for members who picked a language but haven't verified a UID (JT, 5 Nov).
 * General stays open to them; the bot steers them towards verifying at the two
 * moments they care most:
 *
 *  1. A host (Tone, Matt, JT) answers them, from Telegram or right here on Discord.
 *     In bitcoin, stocks or crypto (which they can't see) the note says where; in
 *     general (JT, 14 Nov) it teases the rest of the floor. Either way it lands in
 *     their own general, with the Verify button.
 *  2. They post in general: once a day, a short Verify card that removes itself.
 *     If they're talking bitcoin, crypto or stocks it names that channel.
 */

/** The once-a-day card in general removes itself after this. */
export const TALK_TTL_MS = 60_000;
/** One card per member per this long. */
export const TALK_EVERY_MS = 24 * 3_600_000;
/** The "host answered you" note stays this long, so the notification still leads somewhere. */
export const REPLY_TTL_MS = 30 * 60_000;
/** At most one "host answered you" note per member in this window, however many replies. */
export const REPLY_EVERY_MS = 10 * 60_000;
/** A general reply waits this long so the note lands under the reply's translated copy, not above it. */
export const HERE_DELAY_MS = 8_000;

/** Discord usernames of the hosts who answer on Discord itself (JT, Matt). VERIFY_NUDGE_HOSTS (comma list) replaces this. */
export const DEFAULT_HOSTS = ["baloo.btc", "alphanumetrix"];

export function parseHosts(raw: string | undefined): Set<string> {
  const list = raw?.trim() ? raw.split(",") : DEFAULT_HOSTS;
  return new Set(list.map((h) => h.trim().replace(/^@/, "").toLowerCase()).filter(Boolean));
}

const CHANNEL_KEYS: readonly ChannelKey[] = ["general", "bitcoin", "stocks", "crypto"];

/**
 * `reply`: the host answered in a channel the member can't see (bitcoin, stocks, crypto).
 * `here`: the host answered in general, which they can see: the tease is the rest of the floor.
 */
type Text = { talk: string; topic: string; reply: string; here: string };

/** `{user}` the member's mention, `{channel}` a channel name, `{host}` the host's name. */
export const NUDGE: Record<Lang, Text> = {
  en: {
    talk: "👋 {user}, welcome! Verify your exchange UID to unlock the full Trading Floor: bitcoin, crypto and stocks chat, the signals, and replies from Tone and Matt.",
    topic: "👋 {user}, the **{channel}** channel is where that conversation lives, and Tone and Matt answer there. Verify your exchange UID to join it.",
    reply: "🔔 {user}, **{host}** answered you in **{channel}**. Verify your exchange UID to read the reply and join the chat.",
    here: "🔔 {user}, **{host}** just answered you! Verify your exchange UID to keep the conversation going on the full Trading Floor: bitcoin, crypto and stocks chat with Tone and Matt, plus the signals.",
  },
  zh: {
    talk: "👋 {user}，欢迎！验证你的交易所 UID 即可解锁完整的交易大厅：比特币、加密货币和股票聊天、交易信号，还有 Tone 和 Matt 的回复。",
    topic: "👋 {user}，这个话题在 **{channel}** 频道里讨论，Tone 和 Matt 也会在那里回复。验证你的交易所 UID 即可加入。",
    reply: "🔔 {user}，**{host}** 在 **{channel}** 回复了你。验证你的交易所 UID，就能看到回复并加入聊天。",
    here: "🔔 {user}，**{host}** 刚刚回复了你！验证你的交易所 UID，就能在完整的交易大厅继续聊：和 Tone、Matt 一起聊比特币、加密货币和股票，还有交易信号。",
  },
  ko: {
    talk: "👋 {user}님, 환영합니다! 거래소 UID를 인증하면 트레이딩 플로어 전체가 열려요: 비트코인·코인·주식 채팅, 시그널, 그리고 Tone과 Matt의 답변까지.",
    topic: "👋 {user}님, 그 이야기는 **{channel}** 채널에서 하고 있어요. Tone과 Matt도 거기서 답해요. 거래소 UID를 인증하고 참여하세요.",
    reply: "🔔 {user}님, **{host}**님이 **{channel}**에서 답변했어요. 거래소 UID를 인증하면 답변을 보고 대화에 참여할 수 있어요.",
    here: "🔔 {user}님, **{host}**님이 방금 답변했어요! 거래소 UID를 인증하고 트레이딩 플로어 전체에서 대화를 이어가세요: Tone, Matt와 함께하는 비트코인·코인·주식 채팅과 시그널까지.",
  },
  id: {
    talk: "👋 {user}, selamat datang! Verifikasi UID exchange kamu untuk membuka seluruh Trading Floor: obrolan bitcoin, kripto dan saham, sinyal, dan balasan dari Tone dan Matt.",
    topic: "👋 {user}, obrolan itu ada di kanal **{channel}**, dan Tone serta Matt menjawab di sana. Verifikasi UID exchange kamu untuk bergabung.",
    reply: "🔔 {user}, **{host}** membalasmu di **{channel}**. Verifikasi UID exchange kamu untuk membaca balasannya dan ikut ngobrol.",
    here: "🔔 {user}, **{host}** baru saja membalasmu! Verifikasi UID exchange kamu untuk lanjut ngobrol di seluruh Trading Floor: obrolan bitcoin, kripto dan saham bersama Tone dan Matt, plus sinyalnya.",
  },
  vi: {
    talk: "👋 {user}, chào mừng bạn! Xác minh UID sàn để mở toàn bộ Trading Floor: kênh bitcoin, crypto và cổ phiếu, tín hiệu, và phản hồi từ Tone và Matt.",
    topic: "👋 {user}, chủ đề đó được bàn ở kênh **{channel}**, và Tone cùng Matt trả lời ở đó. Xác minh UID sàn để tham gia.",
    reply: "🔔 {user}, **{host}** đã trả lời bạn trong **{channel}**. Xác minh UID sàn để đọc phản hồi và tham gia trò chuyện.",
    here: "🔔 {user}, **{host}** vừa trả lời bạn! Xác minh UID sàn để tiếp tục trò chuyện trên toàn bộ Trading Floor: kênh bitcoin, crypto và cổ phiếu cùng Tone và Matt, cùng các tín hiệu.",
  },
  es: {
    talk: "👋 {user}, ¡bienvenido! Verifica tu UID del exchange para desbloquear todo el Trading Floor: chats de bitcoin, cripto y acciones, las señales y las respuestas de Tone y Matt.",
    topic: "👋 {user}, esa conversación vive en el canal **{channel}**, y Tone y Matt responden allí. Verifica tu UID del exchange para entrar.",
    reply: "🔔 {user}, **{host}** te respondió en **{channel}**. Verifica tu UID del exchange para leer la respuesta y unirte al chat.",
    here: "🔔 {user}, ¡**{host}** acaba de responderte! Verifica tu UID del exchange para seguir la conversación en todo el Trading Floor: chats de bitcoin, cripto y acciones con Tone y Matt, y las señales.",
  },
  pt: {
    talk: "👋 {user}, bem-vindo! Verifique seu UID da corretora para liberar todo o Trading Floor: chats de bitcoin, cripto e ações, os sinais e as respostas do Tone e do Matt.",
    topic: "👋 {user}, essa conversa acontece no canal **{channel}**, e o Tone e o Matt respondem lá. Verifique seu UID da corretora para entrar.",
    reply: "🔔 {user}, **{host}** respondeu você em **{channel}**. Verifique seu UID da corretora para ler a resposta e entrar no chat.",
    here: "🔔 {user}, **{host}** acabou de te responder! Verifique seu UID da corretora para continuar a conversa em todo o Trading Floor: chats de bitcoin, cripto e ações com o Tone e o Matt, e os sinais.",
  },
  tr: {
    talk: "👋 {user}, hoş geldin! Borsa UID'ni doğrula, tüm Trading Floor açılsın: bitcoin, kripto ve hisse sohbetleri, sinyaller ve Tone ile Matt'in yanıtları.",
    topic: "👋 {user}, bu konu **{channel}** kanalında konuşuluyor ve Tone ile Matt orada yanıtlıyor. Katılmak için borsa UID'ni doğrula.",
    reply: "🔔 {user}, **{host}** sana **{channel}** kanalında yanıt verdi. Yanıtı okumak ve sohbete katılmak için borsa UID'ni doğrula.",
    here: "🔔 {user}, **{host}** sana az önce yanıt verdi! Sohbeti tüm Trading Floor'da sürdürmek için borsa UID'ni doğrula: Tone ve Matt ile bitcoin, kripto ve hisse sohbetleri, artı sinyaller.",
  },
  ru: {
    talk: "👋 {user}, добро пожаловать! Подтвердите UID биржи, и откроется весь Trading Floor: чаты о биткоине, крипте и акциях, сигналы и ответы Tone и Matt.",
    topic: "👋 {user}, эту тему обсуждают в канале **{channel}**, и Tone с Matt отвечают там. Подтвердите UID биржи, чтобы присоединиться.",
    reply: "🔔 {user}, **{host}** ответил вам в **{channel}**. Подтвердите UID биржи, чтобы прочитать ответ и присоединиться к чату.",
    here: "🔔 {user}, **{host}** только что вам ответил! Подтвердите UID биржи, чтобы продолжить разговор на всём Trading Floor: чаты о биткоине, крипте и акциях с Tone и Matt, плюс сигналы.",
  },
  ja: {
    talk: "👋 {user}さん、ようこそ！取引所のUIDを認証すると、Trading Floor がぜんぶ開くよ：ビットコイン・暗号資産・株のチャット、シグナル、それに Tone と Matt からの返信も。",
    topic: "👋 {user}さん、その話は **{channel}** チャンネルでやってるよ。Tone と Matt もそこで返信してる。取引所のUIDを認証して参加してね。",
    reply: "🔔 {user}さん、**{host}** が **{channel}** で返信したよ。取引所のUIDを認証すると、返信が読めてチャットにも参加できるよ。",
    here: "🔔 {user}さん、**{host}** が返信したよ！取引所のUIDを認証すると、Trading Floor ぜんぶで会話を続けられるよ：Tone と Matt とのビットコイン・暗号資産・株のチャット、それにシグナルも。",
  },
};

export function nudgeText(lang: Lang, kind: keyof Text, vars: { user: string; channel?: string; host?: string }): string {
  return NUDGE[lang][kind].replace("{user}", vars.user).replace("{channel}", vars.channel ?? "").replace("{host}", vars.host ?? "");
}

/** The channel name without its emoji prefix, e.g. "🟠・比特币" → "比特币". */
export function bareName(name: string): string {
  return name.split("・").pop() ?? name;
}

export interface NudgeOptions {
  guild: Guild;
  db: Db;
  groups: GroupIndex;
  roles: LanguageRoles;
  funnel?: Funnel;
  /** Discord usernames whose replies count as a host's (lower case). */
  hosts?: Set<string>;
}

export class VerifyNudge {
  /** Last "host answered you" note per member, in memory: a restart only means one extra note at most. */
  private lastReply = new Map<string, number>();
  /** Members already carded today, so most messages never touch the database. */
  private talked = new Map<string, number>();

  private hosts: Set<string>;

  constructor(private o: NudgeOptions) {
    this.hosts = o.hosts ?? parseHosts(undefined);
  }

  private generalGroup() {
    return this.o.groups.groups.find((g) => g.name.toLowerCase() === "general") ?? null;
  }

  /** A member who picked a language, hasn't verified, and isn't staff. */
  private unverifiedLang(member: GuildMember): Lang | null {
    if (member.user.bot || this.o.roles.isVerified(member)) return null;
    if (member.permissions.has(PermissionFlagsBits.ManageMessages)) return null;
    return this.o.roles.langOf(member);
  }

  private channelName(key: ChannelKey, lang: Lang): string {
    const group = this.o.groups.groups.find((g) => g.name.toLowerCase() === key);
    const id = group?.members.find((m) => m.lang === lang)?.channel_id ?? group?.members.find((m) => m.lang === "en")?.channel_id;
    const ch = id ? this.o.guild.channels.cache.get(id) : null;
    return ch ? bareName(ch.name) : key;
  }

  private async post(channelId: string, content: string, lang: Lang, userId: string, ttl: number) {
    const ch = await this.o.guild.channels.fetch(channelId).catch(() => null);
    if (!ch?.isTextBased() || !("send" in ch)) return null;
    const sent = await ch.send({ content, components: [verifyButtonRow(lang)], allowedMentions: { users: [userId] } });
    setTimeout(() => void sent.delete().catch(() => {}), ttl).unref();
    return sent;
  }

  /** Nudge 2: an unverified member posted in general. */
  async onMessage(m: Message) {
    if (!m.inGuild() || m.guildId !== this.o.guild.id || m.author.bot || m.webhookId || m.channel.isThread()) return;
    if (this.hosts.has(m.author.username.toLowerCase())) return this.onDiscordHostMessage(m);
    const group = this.generalGroup();
    if (!group?.members.some((x) => x.channel_id === m.channelId)) return;
    const seen = this.talked.get(m.author.id);
    if (seen && Date.now() - seen < TALK_EVERY_MS) return;
    const member = m.member ?? (await this.o.guild.members.fetch(m.author.id).catch(() => null));
    const lang = member ? this.unverifiedLang(member) : null;
    if (!lang) return;
    const key = `verify_nudge:talk:${m.author.id}`;
    const last = Number((await this.o.db.getSetting(this.o.guild.id, key)) ?? 0);
    if (Date.now() - last < TALK_EVERY_MS) return void this.talked.set(m.author.id, last);
    this.talked.set(m.author.id, Date.now());
    await this.o.db.setSetting(this.o.guild.id, key, String(Date.now()));
    const topic = keywordChannel(m.content);
    const user = `<@${m.author.id}>`;
    const content = topic ? nudgeText(lang, "topic", { user, channel: this.channelName(topic, lang) }) : nudgeText(lang, "talk", { user });
    await this.post(m.channelId, content, lang, m.author.id, TALK_TTL_MS);
    log.info("verify nudge", { kind: "talk", user: m.author.id, lang, topic });
    this.o.funnel?.record(m.author.id, "verify_nudge", { lang, detail: { kind: "talk", topic } });
  }

  /**
   * A host wrote on Discord: if it answers a member (a native reply, or failing
   * that an @mention) in general, bitcoin, stocks or crypto of any language, nudge them.
   */
  private async onDiscordHostMessage(m: Message<true>) {
    const key = this.o.groups.lookup(m.channelId)?.group.name.toLowerCase();
    if (!key || !(CHANNEL_KEYS as readonly string[]).includes(key)) return;
    let memberId: string | null = null;
    if (m.reference?.messageId) {
      const target = await m.fetchReference().catch(() => null);
      if (target?.webhookId) {
        // A translated copy (or a bridged post): the member is the original's author.
        const row = await this.o.db.sourceOf(target.id).catch(() => null);
        const ch = row ? await this.o.guild.channels.fetch(row.source_channel_id).catch(() => null) : null;
        const src = row && ch?.isTextBased() ? await ch.messages.fetch(row.source_message_id).catch(() => null) : null;
        if (src && !src.webhookId && !src.author.bot) memberId = src.author.id;
      } else if (target && !target.author.bot) {
        memberId = target.author.id;
      }
    }
    memberId ??= m.mentions.users.find((u) => !u.bot && u.id !== m.author.id)?.id ?? null;
    if (!memberId || memberId === m.author.id) return;
    await this.onHostReply(memberId, m.member?.displayName ?? m.author.displayName, key as ChannelKey);
  }

  /** Nudge 1: a host answered this member, from Telegram or Discord. */
  async onHostReply(memberId: string, host: string, key: ChannelKey) {
    const last = this.lastReply.get(memberId);
    if (last && Date.now() - last < REPLY_EVERY_MS) return;
    const member = await this.o.guild.members.fetch(memberId).catch(() => null);
    const lang = member ? this.unverifiedLang(member) : null;
    if (!lang) return;
    const general = this.generalGroup()?.members.find((x) => x.lang === lang)?.channel_id;
    if (!general) return;
    this.lastReply.set(memberId, Date.now());
    const here = key === "general";
    const content = nudgeText(lang, here ? "here" : "reply", { user: `<@${memberId}>`, host, channel: this.channelName(key, lang) });
    if (here) await new Promise((r) => setTimeout(r, HERE_DELAY_MS).unref());
    await this.post(general, content, lang, memberId, REPLY_TTL_MS);
    log.info("verify nudge", { kind: "host_reply", user: memberId, lang, host, channel: key });
    this.o.funnel?.record(memberId, "verify_nudge", { lang, detail: { kind: "host_reply", host, channel: key } });
  }
}
