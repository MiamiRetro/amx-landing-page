import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import {
  MessageType,
  WebhookClient,
  type Guild,
  type Message,
  type NewsChannel,
  type PartialMessage,
  type TextChannel,
} from "discord.js";
import type { Lang } from "../config.js";
import type { Db } from "../db/index.js";
import { log, errInfo } from "../log.js";
import type { GroupIndex } from "../mirror/groups.js";
import { sanitizeUsername } from "../mirror/webhooks.js";
import { TelegramApi, TelegramError, type InlineButton, type TgCallbackQuery, type TgMessage, type TgUser } from "./api.js";
import { CHANNELS, classify, explicitTag, isChannelKey, MODEL_PROMPT, parseModelPick, type ChannelKey, type ModelPick, type Route } from "./classify.js";
import {
  CHANNEL_LABEL,
  discordReplyHeader,
  discordToTelegram,
  fitDiscord,
  fitTelegram,
  splitReplyHeader,
  telegramPost,
  telegramToDiscord,
  type DiscordNames,
} from "./format.js";

export const BRIDGE_WEBHOOK_NAME = "AMX Telegram";
/** assets/ sits two levels above both src/telegram and dist/telegram. */
const AVATAR_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", "telegram");

/**
 * A host's picture shipped with the bot: assets/telegram/<telegram username, lower case>.png.
 * Webhook posts can only take an avatar by URL, so a host with a file gets a
 * webhook of their own whose avatar is that picture.
 */
export function avatarFile(user: BridgeUser, dir = AVATAR_DIR): string | null {
  const file = join(dir, `${user.telegram.toLowerCase()}.png`);
  return existsSync(file) ? file : null;
}
/** Follow-ups from the same host within this window stay in the channel of their last post. */
const STICKY_MS = 10 * 60_000;
/** The "→ #bitcoin" note under a host's post removes itself after this. */
const NOTE_TTL_MS = 90_000;
/** Telegram allows a bot about 20 messages a minute in one group. */
const SEND_GAP_MS = 3_100;
const MAX_UPLOAD = 8 * 1024 * 1024;

export interface BridgeUser {
  /** Telegram username (without @) or numeric user id. */
  telegram: string;
  /** Name shown on Discord. */
  name?: string;
  /** Public image URL for the Discord avatar. */
  avatar?: string;
  /** Discord user id: their Discord name and avatar are used when name/avatar are not set. */
  discord?: string;
}

/** The hosts of The Daily High. TELEGRAM_BRIDGE_USERS (a JSON list) replaces this. */
export const DEFAULT_USERS: BridgeUser[] = [
  { telegram: "ToneVays", name: "Tone Vays" },
  { telegram: "AlphanumetriX", name: "Matt McGregor" },
];

export function parseUsers(raw: string | undefined): BridgeUser[] {
  if (!raw?.trim()) return DEFAULT_USERS;
  const list = JSON.parse(raw) as BridgeUser[];
  if (!Array.isArray(list) || list.some((u) => !u?.telegram)) throw new Error("TELEGRAM_BRIDGE_USERS must be a JSON list of {telegram, name?, avatar?, discord?}");
  return list.map((u) => ({ ...u, telegram: String(u.telegram).replace(/^@/, "") }));
}

export function matchUser(users: BridgeUser[], from: TgUser | undefined): BridgeUser | null {
  if (!from || from.is_bot) return null;
  return users.find((u) => u.telegram === String(from.id) || (!!from.username && u.telegram.toLowerCase() === from.username.toLowerCase())) ?? null;
}

/** A Telegram message's Discord side. */
interface TgEntry {
  /** Discord message id. */
  d: string;
  c: ChannelKey;
  /** Set when the host wrote it in Telegram and the bridge posted it to Discord. */
  own?: true;
  /** For own posts: text as sent (tag removed), reply header, Telegram file ids. */
  text?: string;
  h?: string | null;
  f?: { id: string; name: string }[];
  u?: string;
}

/** A Discord message's Telegram copy. */
interface DcEntry {
  t: number;
  /** photo copies are edited through their caption */
  k?: "photo";
}

export interface BridgeOptions {
  guild: Guild;
  db: Db;
  groups: GroupIndex;
  token: string;
  users: BridgeUser[];
  /** Fixed chat id. Without one, a host binds the group by sending /bind there. */
  chatId?: number;
  model?: ModelPick;
}

export class TelegramBridge {
  readonly api: TelegramApi;
  private guild: Guild;
  private db: Db;
  private groups: GroupIndex;
  private users: BridgeUser[];
  private model?: ModelPick;
  private chatId: number | null;
  private paused = false;
  private running = false;
  private abort = new AbortController();
  private hooks = new Map<string, WebhookClient>();
  private hookIds = new Set<string>();
  private sticky = new Map<string, { channel: ChannelKey; at: number }>();
  private sendChain: Promise<unknown> = Promise.resolve();
  private botId = 0;
  private admins: { chat: number; at: number; users: BridgeUser[] } = { chat: 0, at: 0, users: [] };
  /** Discord avatars as small link-preview thumbnails on forwarded messages. Off by default (JT found the card too heavy). */
  private avatars = process.env.TELEGRAM_AVATARS?.trim() === "on";

  constructor(opts: BridgeOptions) {
    this.api = new TelegramApi(opts.token);
    this.guild = opts.guild;
    this.db = opts.db;
    this.groups = opts.groups;
    this.users = opts.users;
    this.model = opts.model;
    this.chatId = opts.chatId ?? null;
  }

  // ---------- setup ----------

  /** English channel of each bridged group, found by the mirror group's name. */
  channelOf(key: ChannelKey): string | null {
    const group = this.groups.groups.find((g) => g.name.toLowerCase() === key);
    return group?.members.find((m) => m.lang === "en")?.channel_id ?? null;
  }

  keyOf(channelId: string): ChannelKey | null {
    const hit = this.groups.lookup(channelId);
    if (!hit || hit.member.lang !== "en") return null;
    const name = hit.group.name.toLowerCase();
    return isChannelKey(name) ? name : null;
  }

  async start() {
    const me = await this.api.getMe();
    this.botId = me.id;
    if (this.chatId == null) {
      const saved = await this.db.getSetting(this.guild.id, "tg:chat");
      this.chatId = saved ? Number(saved) : null;
    }
    this.paused = (await this.db.getSetting(this.guild.id, "tg:paused")) === "1";
    for (const key of CHANNELS) {
      const ch = this.channelOf(key);
      if (!ch) { log.warn("telegram bridge: no English channel for group", { key }); continue; }
      await this.hook(ch).catch((e) => log.warn("telegram bridge webhook failed", { key, ...errInfo(e) }));
      for (const u of this.users) if (avatarFile(u)) await this.hook(ch, u).catch((e) => log.warn("telegram bridge webhook failed", { key, user: u.telegram, ...errInfo(e) }));
    }
    this.running = true;
    void this.poll();
    log.info("telegram bridge on", { bot: me.username, chat: this.chatId ?? "unbound (send /bind in the group)", paused: this.paused, users: this.users.map((u) => u.telegram) });
  }

  stop() {
    this.running = false;
    this.abort.abort();
  }

  /** The channel's bridge webhook: the host's own one when they have a picture file, else the shared one. */
  private async hook(channelId: string, user?: BridgeUser | null): Promise<WebhookClient> {
    const file = user ? avatarFile(user) : null;
    const name = file && user ? `${BRIDGE_WEBHOOK_NAME} · ${user.telegram}` : BRIDGE_WEBHOOK_NAME;
    const cacheKey = `${channelId}:${name}`;
    const cached = this.hooks.get(cacheKey);
    if (cached) return cached;
    const channel = await this.guild.channels.fetch(channelId);
    if (!channel || !("createWebhook" in channel)) throw new Error(`channel ${channelId} cannot host webhooks`);
    const ch = channel as TextChannel | NewsChannel;
    const existing = (await ch.fetchWebhooks()).find((w) => w.name === name && w.token);
    const hook = existing ?? (await ch.createWebhook({ name, avatar: file ? readFileSync(file) : undefined, reason: "Telegram bridge for The Daily High" }));
    if (!hook.token) throw new Error(`webhook ${hook.id} has no token`);
    this.hookIds.add(hook.id);
    const client = new WebhookClient({ id: hook.id, token: hook.token });
    this.hooks.set(cacheKey, client);
    return client;
  }

  private owner(entry: TgEntry): BridgeUser | null {
    return this.users.find((u) => u.telegram === entry.u) ?? this.admins.users.find((u) => u.telegram === entry.u) ?? null;
  }

  /**
   * Who may post through: the listed hosts, plus the group's own Telegram
   * admins (JT), who post under their Telegram name. TELEGRAM_BRIDGE_ADMINS=off
   * limits it to the list.
   */
  private async userFor(from: TgUser | undefined, chatId: number): Promise<BridgeUser | null> {
    const listed = matchUser(this.users, from);
    if (listed || !from || from.is_bot || process.env.TELEGRAM_BRIDGE_ADMINS?.trim() === "off") return listed;
    if (this.admins.chat !== chatId || Date.now() - this.admins.at > 10 * 60_000) {
      const list = await this.api.getChatAdministrators(chatId).catch(() => null);
      if (list) {
        this.admins = {
          chat: chatId,
          at: Date.now(),
          users: list.filter((m) => !m.user.is_bot).map((m) => ({ telegram: String(m.user.id), name: [m.user.first_name, m.user.last_name].filter(Boolean).join(" ") })),
        };
      }
    }
    return this.admins.chat === chatId ? this.admins.users.find((u) => u.telegram === String(from.id)) ?? null : null;
  }

  // ---------- storage ----------

  private tKey(id: number) {
    return `tg:t:${this.chatId}:${id}`;
  }

  private async getT(id: number): Promise<TgEntry | null> {
    const v = await this.db.getSetting(this.guild.id, this.tKey(id)).catch(() => null);
    return v ? (JSON.parse(v) as TgEntry) : null;
  }

  private async getD(id: string): Promise<DcEntry | null> {
    const v = await this.db.getSetting(this.guild.id, `tg:d:${id}`).catch(() => null);
    return v ? (JSON.parse(v) as DcEntry) : null;
  }

  private async link(tgId: number, t: TgEntry, d: DcEntry) {
    await this.db.setSetting(this.guild.id, this.tKey(tgId), JSON.stringify(t));
    await this.db.setSetting(this.guild.id, `tg:d:${t.d}`, JSON.stringify(d));
  }

  private async unlink(tgId: number, discordId: string) {
    await this.db.deleteSetting(this.guild.id, this.tKey(tgId)).catch(() => {});
    await this.db.deleteSetting(this.guild.id, `tg:d:${discordId}`).catch(() => {});
  }

  /** One Telegram send at a time, spaced out, with one retry after a flood wait. */
  private send<T>(fn: () => Promise<T>): Promise<T> {
    const run = async () => {
      try {
        return await fn();
      } catch (e) {
        if (e instanceof TelegramError && e.code === 429 && e.retryAfter) {
          await sleep(e.retryAfter * 1000 + 250);
          return fn();
        }
        throw e;
      } finally {
        await sleep(SEND_GAP_MS);
      }
    };
    const p = this.sendChain.then(run, run);
    this.sendChain = p.catch(() => {});
    return p;
  }

  // ---------- Discord → Telegram ----------

  private names(): DiscordNames {
    const g = this.guild;
    return {
      user: (id) => g.members.cache.get(id)?.displayName ?? g.client.users.cache.get(id)?.username ?? null,
      channel: (id) => g.channels.cache.get(id)?.name ?? null,
      role: (id) => g.roles.cache.get(id)?.name ?? null,
    };
  }

  /** Mirror copies are forwarded (they carry the other languages); other bots and our own posts are not. */
  private forwardable(message: Message): ChannelKey | null {
    if (this.paused || this.chatId == null) return null;
    if (!message.inGuild() || message.guildId !== this.guild.id || message.channel.isThread()) return null;
    const key = this.keyOf(message.channelId);
    if (!key) return null;
    if (message.type !== MessageType.Default && message.type !== MessageType.Reply) return null;
    if (message.webhookId) {
      if (this.hookIds.has(message.webhookId)) return null;
      if (!this.groups.isOurWebhook(message.webhookId)) return null;
    } else if (message.author.bot) return null;
    return key;
  }

  /** Language the message was first written in: a mirror copy points back to its source. */
  private async sourceLang(message: Message): Promise<Lang | null> {
    if (!message.webhookId) return null;
    // The mirror writes its map row just after the copy lands.
    for (let i = 0; i < 3; i++) {
      const row = await this.db.sourceOf(message.id).catch(() => null);
      if (row) return this.groups.lookup(row.source_channel_id)?.member.lang ?? null;
      await sleep(1500);
    }
    return null;
  }

  private async render(message: Message, key: ChannelKey) {
    const { parent, rest } = splitReplyHeader(message.content);
    const lang = await this.sourceLang(message);
    const author = message.member?.displayName ?? message.author.displayName ?? message.author.username;
    let body = discordToTelegram(rest, this.names());
    const images = [...message.attachments.values()].filter((a) => a.contentType?.startsWith("image/"));
    const others = [...message.attachments.values()].filter((a) => !a.contentType?.startsWith("image/"));
    const extra = [
      ...images.slice(1).map((a) => `🖼 <a href="${a.url}">${a.name}</a>`),
      ...others.map((a) => `📎 <a href="${a.url}">${a.name}</a>`),
      ...[...message.stickers.values()].map((s) => `[sticker: ${s.name}]`),
    ];
    if (extra.length) body = [body, ...extra].filter(Boolean).join("\n");
    const parentId = message.reference?.messageId ?? parent?.messageId ?? null;
    // Mirror copies carry the original author's avatar on the webhook message.
    // Otherwise links in the text get Telegram's own preview (TradingView charts show the chart).
    const avatar = this.avatars ? (message.member ?? message.author).displayAvatarURL({ extension: "png", size: 128 }) : "auto";
    return { html: telegramPost(key, author, body, lang), image: images[0]?.url ?? null, avatar, parentId, empty: !body && !images.length };
  }

  onDiscordCreate(message: Message) {
    const key = this.forwardable(message);
    if (!key) return;
    void (async () => {
      const r = await this.render(message, key);
      if (r.empty) return;
      const replyTo = r.parentId ? (await this.getD(r.parentId))?.t : undefined;
      const chat = this.chatId!;
      const sent = r.image
        ? await this.send(() => this.api.sendPhoto(chat, r.image!, fitTelegram(r.html, 1024), { replyTo }))
        : await this.send(() => this.api.sendMessage(chat, fitTelegram(r.html, 4096), { replyTo, preview: r.avatar }));
      await this.link(sent.message_id, { d: message.id, c: key }, { t: sent.message_id, k: r.image ? "photo" : undefined });
    })().catch((e) => log.warn("telegram forward failed", { id: message.id, ...errInfo(e) }));
  }

  onDiscordUpdate(message: Message | PartialMessage) {
    if (message.partial || !message.editedTimestamp) return;
    const key = this.forwardable(message);
    if (!key) return;
    void (async () => {
      const entry = await this.getD(message.id);
      if (!entry) return;
      const r = await this.render(message, key);
      const chat = this.chatId!;
      await this.send(() => entry.k === "photo"
        ? this.api.editMessageCaption(chat, entry.t, fitTelegram(r.html, 1024))
        : this.api.editMessageText(chat, entry.t, fitTelegram(r.html, 4096), undefined, r.avatar));
    })().catch((e) => {
      if (e instanceof TelegramError && /not modified/i.test(e.description)) return;
      log.warn("telegram edit failed", { id: message.id, ...errInfo(e) });
    });
  }

  onDiscordDelete(message: Message | PartialMessage) {
    if (this.chatId == null || !this.keyOf(message.channelId)) return;
    void (async () => {
      const entry = await this.getD(message.id);
      if (!entry) return;
      const own = await this.getT(entry.t);
      // A host's own post deleted on Discord (by a mod, or a move) stays in Telegram; only the link goes.
      if (own?.own) {
        await this.unlink(entry.t, message.id);
        return;
      }
      await this.send(() => this.api.deleteMessage(this.chatId!, entry.t)).catch(() => {});
      await this.unlink(entry.t, message.id);
    })().catch((e) => log.warn("telegram delete failed", { id: message.id, ...errInfo(e) }));
  }

  // ---------- Telegram → Discord ----------

  private async poll() {
    let offset = Number((await this.db.getSetting(this.guild.id, "tg:offset").catch(() => null)) ?? 0);
    while (this.running) {
      try {
        const updates = await this.api.getUpdates(offset, 25, this.abort.signal);
        for (const u of updates) {
          offset = u.update_id + 1;
          try {
            if (u.message) await this.onTelegramMessage(u.message);
            else if (u.edited_message) await this.onTelegramEdit(u.edited_message);
            else if (u.callback_query) await this.onCallback(u.callback_query);
          } catch (e) {
            log.warn("telegram update failed", { update: u.update_id, ...errInfo(e) });
          }
        }
        if (updates.length) await this.db.setSetting(this.guild.id, "tg:offset", String(offset)).catch(() => {});
      } catch (e) {
        if (!this.running) return;
        const conflict = e instanceof TelegramError && e.code === 409;
        log.warn(conflict ? "telegram bridge: another copy is polling this bot token" : "telegram poll failed", errInfo(e));
        await sleep(conflict ? 30_000 : 5_000);
      }
    }
  }

  private reply(to: TgMessage, html: string, ttlMs = NOTE_TTL_MS, buttons?: InlineButton[][]) {
    return this.send(() => this.api.sendMessage(to.chat.id, html, { replyTo: to.message_id, buttons, silent: true })).then((note) => {
      if (ttlMs > 0) setTimeout(() => void this.send(() => this.api.deleteMessage(note.chat.id, note.message_id)).catch(() => {}), ttlMs).unref();
      return note;
    });
  }

  private async command(msg: TgMessage, user: BridgeUser | null): Promise<boolean> {
    const cmd = msg.text?.match(/^\/(\w+)(?:@\w+)?\s*$/)?.[1]?.toLowerCase();
    if (!cmd || !["bind", "pause", "resume", "delete", "where", "help"].includes(cmd)) return false;
    if (!user) return true;
    if (cmd === "bind") {
      this.chatId = msg.chat.id;
      await this.db.setSetting(this.guild.id, "tg:chat", String(msg.chat.id));
      await this.reply(msg, `✅ This chat is now bridged to Discord: ${CHANNELS.map((c) => CHANNEL_LABEL[c]).join(", ")}.`, 0);
      log.info("telegram bridge bound", { chat: msg.chat.id, title: msg.chat.title });
      return true;
    }
    if (msg.chat.id !== this.chatId) return true;
    if (cmd === "pause" || cmd === "resume") {
      this.paused = cmd === "pause";
      await this.db.setSetting(this.guild.id, "tg:paused", this.paused ? "1" : "0");
      await this.reply(msg, this.paused ? "⏸ Bridge paused. Nothing moves either way until /resume." : "▶️ Bridge back on.", 0);
      return true;
    }
    if (cmd === "delete") {
      const target = msg.reply_to_message;
      const entry = target ? await this.getT(target.message_id) : null;
      if (!target || !entry?.own) {
        await this.reply(msg, "Reply /delete to one of your own posts to take it off Discord.");
        return true;
      }
      const ch = this.channelOf(entry.c);
      if (ch) await (await this.hook(ch, this.owner(entry))).deleteMessage(entry.d).catch((e) => log.warn("telegram /delete failed", errInfo(e)));
      await this.unlink(target.message_id, entry.d);
      await this.reply(msg, `🗑 Removed from ${CHANNEL_LABEL[entry.c]} on Discord.`);
      return true;
    }
    await this.reply(msg, [
      "<b>The Daily High bridge</b>",
      "Everything from the Discord channels shows up here. What you write goes back:",
      "• a reply goes to the channel of the message you answer",
      "• start with /btc, /stocks, /crypto or /general to pick the channel",
      "• otherwise the bot picks; tap a button under its note to move the post",
      "/delete (as a reply) removes your post from Discord · /pause · /resume",
    ].join("\n"), 0);
    return true;
  }

  async onTelegramMessage(msg: TgMessage) {
    const user = await this.userFor(msg.from, msg.chat.id);
    if (await this.command(msg, user)) return;
    if (msg.chat.id !== this.chatId || !user || this.paused) return;
    const raw = msg.text ?? msg.caption ?? "";
    const photo = msg.photo?.length ? msg.photo[msg.photo.length - 1] : null;
    const doc = msg.document && (msg.document.file_size ?? 0) <= MAX_UPLOAD ? msg.document : null;
    if (!raw.trim() && !photo && !doc) return;

    const route = await this.route(msg, user, raw);
    const files = [
      ...(photo ? [{ id: photo.file_id, name: "photo.jpg" }] : []),
      ...(doc ? [{ id: doc.file_id, name: doc.file_name ?? "file" }] : []),
    ];
    const posted = await this.postToDiscord(user, route.channel, route.text, route.header, files);
    this.sticky.set(user.telegram, { channel: route.channel, at: Date.now() });
    await this.link(msg.message_id, { d: posted, c: route.channel, own: true, text: route.text, h: route.header, f: files, u: user.telegram }, { t: msg.message_id });
    log.info("telegram → discord", { user: user.telegram, channel: route.channel, by: route.by });
    await this.reply(msg, noteText(route.channel, route.by), NOTE_TTL_MS, moveButtons(msg.message_id, route.channel));
  }

  private async route(msg: TgMessage, user: BridgeUser, raw: string): Promise<Route & { header: string | null }> {
    const tagged = explicitTag(raw);
    // Replies to a bridged message: that message's channel, with a link back to it.
    const replyTo = msg.reply_to_message ? await this.getT(msg.reply_to_message.message_id) : null;
    let header: string | null = null;
    if (replyTo) {
      const ch = this.channelOf(replyTo.c);
      const orig = ch ? await this.fetchDiscord(ch, replyTo.d) : null;
      if (ch) {
        const name = replyTo.own ? this.displayName(this.owner(replyTo) ?? user) : orig?.member?.displayName ?? orig?.author.displayName ?? orig?.author.username ?? "…";
        const excerpt = replyTo.own ? replyTo.text ?? "" : splitReplyHeader(orig?.content ?? "").rest;
        header = discordReplyHeader(this.guild.id, ch, replyTo.d, name, excerpt);
      }
    }
    if (tagged) return { channel: tagged.channel, text: tagged.text, by: "tag", header: replyTo && replyTo.c === tagged.channel ? header : null };
    if (replyTo) return { channel: replyTo.c, text: raw, by: "reply", header };
    const last = this.sticky.get(user.telegram);
    if (last && Date.now() - last.at < STICKY_MS) {
      // A clear keyword hit still wins over stickiness.
      const r = await classify(raw);
      if (r.by === "keywords" && r.channel !== last.channel) return { ...r, header: null };
      return { channel: last.channel, text: raw, by: "sticky", header: null };
    }
    return { ...(await classify(raw, this.model)), header: null };
  }

  private async fetchDiscord(channelId: string, id: string): Promise<Message | null> {
    const ch = await this.guild.channels.fetch(channelId).catch(() => null);
    if (!ch?.isTextBased()) return null;
    return ch.messages.fetch(id).catch(() => null);
  }

  private displayName(user: BridgeUser): string {
    if (user.name) return user.name;
    if (user.discord) {
      const m = this.guild.members.cache.get(user.discord);
      if (m) return m.displayName;
    }
    return user.telegram;
  }

  private avatar(user: BridgeUser): string | undefined {
    if (user.avatar) return user.avatar;
    if (user.discord) return this.guild.members.cache.get(user.discord)?.displayAvatarURL({ extension: "png", size: 256 });
    return undefined;
  }

  private async postToDiscord(user: BridgeUser, key: ChannelKey, text: string, header: string | null | undefined, files: { id: string; name: string }[]): Promise<string> {
    const ch = this.channelOf(key);
    if (!ch) throw new Error(`no English channel for ${key}`);
    if (user.discord && !this.guild.members.cache.has(user.discord)) await this.guild.members.fetch(user.discord).catch(() => null);
    const hook = await this.hook(ch, user);
    const attachments = [];
    for (const f of files) attachments.push({ attachment: await this.api.download(f.id), name: f.name });
    const sent = await hook.send({
      username: sanitizeUsername(this.displayName(user)),
      // A host with a picture file posts through their own webhook, which already wears it.
      avatarURL: avatarFile(user) ? undefined : this.avatar(user),
      content: fitDiscord(telegramToDiscord(text, header ?? null)),
      files: attachments,
      allowedMentions: { parse: [] },
    });
    return sent.id;
  }

  async onTelegramEdit(msg: TgMessage) {
    if (msg.chat.id !== this.chatId || this.paused) return;
    const user = await this.userFor(msg.from, msg.chat.id);
    const entry = user ? await this.getT(msg.message_id) : null;
    if (!user || !entry?.own) return;
    const raw = msg.text ?? msg.caption ?? "";
    const text = explicitTag(raw)?.text ?? raw;
    const ch = this.channelOf(entry.c);
    if (!ch) return;
    await (await this.hook(ch, this.owner(entry))).editMessage(entry.d, { content: fitDiscord(telegramToDiscord(text, entry.h ?? null)), allowedMentions: { parse: [] } });
    await this.db.setSetting(this.guild.id, this.tKey(msg.message_id), JSON.stringify({ ...entry, text }));
  }

  async onCallback(q: TgCallbackQuery) {
    const m = q.data?.match(/^mv:(\d+):(\w+)$/);
    if (!m || !isChannelKey(m[2])) return void this.api.answerCallbackQuery(q.id).catch(() => {});
    const user = q.message ? await this.userFor(q.from, q.message.chat.id) : matchUser(this.users, q.from);
    if (!user) return void this.api.answerCallbackQuery(q.id, "Only the hosts can move posts.").catch(() => {});
    const tgId = Number(m[1]);
    const to = m[2];
    const entry = await this.getT(tgId);
    if (!entry?.own) return void this.api.answerCallbackQuery(q.id, "That post is no longer on Discord.").catch(() => {});
    if (entry.c === to) return void this.api.answerCallbackQuery(q.id).catch(() => {});
    const owner = this.owner(entry) ?? user;
    const oldCh = this.channelOf(entry.c);
    if (oldCh) await (await this.hook(oldCh, this.owner(entry))).deleteMessage(entry.d).catch((e) => log.warn("telegram move: delete failed", errInfo(e)));
    await this.db.deleteSetting(this.guild.id, `tg:d:${entry.d}`).catch(() => {});
    const posted = await this.postToDiscord(owner, to, entry.text ?? "", null, entry.f ?? []);
    await this.link(tgId, { ...entry, d: posted, c: to, h: null }, { t: tgId });
    this.sticky.set(owner.telegram, { channel: to, at: Date.now() });
    log.info("telegram post moved", { user: owner.telegram, from: entry.c, to });
    await this.api.answerCallbackQuery(q.id, `Moved to ${CHANNEL_LABEL[to]}`).catch(() => {});
    if (q.message) await this.send(() => this.api.editMessageText(q.message!.chat.id, q.message!.message_id, noteText(to, "moved"), moveButtons(tgId, to))).catch(() => {});
  }
}

export function noteText(channel: ChannelKey, by: Route["by"] | "moved"): string {
  const why = by === "moved" ? "moved" : by === "reply" ? "reply" : by === "tag" ? "your tag" : by === "sticky" ? "same as your last post" : by === "default" ? "no clear topic" : "auto";
  return `→ <b>${CHANNEL_LABEL[channel]}</b> <i>(${why})</i>`;
}

export function moveButtons(tgId: number, current: ChannelKey): InlineButton[][] {
  return [CHANNELS.filter((c) => c !== current).map((c) => ({ text: CHANNEL_LABEL[c], callback_data: `mv:${tgId}:${c}` }))];
}

/** Claude Haiku as the last-resort router. */
export function anthropicPicker(model = process.env.TELEGRAM_CLASSIFIER_MODEL?.trim() || "claude-haiku-5-5", client = new Anthropic()): ModelPick {
  return async (text) => {
    const res = await client.messages.create({
      model,
      max_tokens: 60,
      system: MODEL_PROMPT,
      messages: [{ role: "user", content: `<message>\n${text.slice(0, 2000)}\n</message>` }],
    }, { timeout: 8_000, maxRetries: 0 });
    const out = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    return parseModelPick(out);
  };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
