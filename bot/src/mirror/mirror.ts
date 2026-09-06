import {
  EmbedBuilder,
  MessageType,
  type APIEmbed,
  type Guild,
  type Message,
  type PartialMessage,
  type WebhookClient,
  type WebhookMessageCreateOptions,
} from "discord.js";
import type { Lang } from "../config.js";
import type { Db, GroupMember, MapRow } from "../db/index.js";
import { log, errInfo } from "../log.js";
import type { Translator } from "../translate/index.js";
import type { GroupIndex } from "./groups.js";
import { detokenize, hasTranslatableText, splitForDiscord, tokenize } from "./placeholders.js";
import { KeyedQueue } from "./queue.js";
import { remapForTarget, renderForward, renderPoll, replyHeader } from "./render.js";
import { sanitizeUsername, WebhookPool } from "./webhooks.js";

const UPLOAD_LIMIT: Record<number, number> = { 0: 10, 1: 10, 2: 50, 3: 100 };
const PENDING_NOTE = "\n-# ⏳ translation pending";

interface Segment {
  /** where the segment lives: message content, or a path into an embed */
  path: ["content"] | ["embed", number, "title" | "description" | "footer" | "author"] | ["field", number, number, "name" | "value"];
  tokenized: string;
  entities: string[];
}

export interface MirrorDeps {
  guild: Guild;
  db: Db;
  groups: GroupIndex;
  translator: Translator;
  botUserId: string;
}

export class Mirror {
  readonly queue = new KeyedQueue();
  private hooks: WebhookPool;
  private glossaryCache: { at: number; rows: { term: string; note: string | null }[] } | null = null;
  private recent = new Map<string, string[]>();
  paused = false;

  constructor(private d: MirrorDeps) {
    this.hooks = new WebhookPool(d.guild, d.db);
  }

  get guild() {
    return this.d.guild;
  }

  /** Called on messageCreate. Decides whether the message is ours to mirror. */
  onCreate(message: Message) {
    if (!this.accepts(message)) return;
    void this.queue.run(message.channelId, () => this.mirrorNew(message).catch((e) => log.error("mirror failed", { id: message.id, ...errInfo(e) })));
  }

  onUpdate(message: Message | PartialMessage) {
    if (message.partial || !this.accepts(message)) return;
    if (!message.editedTimestamp) return; // embed unfurl, pin, etc.
    void this.queue.run(message.channelId, () => this.mirrorEdit(message).catch((e) => log.error("edit failed", { id: message.id, ...errInfo(e) })));
  }

  onDelete(message: Message | PartialMessage) {
    const hit = this.d.groups.lookup(message.channelId);
    if (!hit) return;
    void this.queue.run(message.channelId, () => this.mirrorDelete(message.id).catch((e) => log.error("delete failed", { id: message.id, ...errInfo(e) })));
  }

  private accepts(message: Message | PartialMessage): message is Message {
    if (message.partial) return false;
    if (!message.inGuild() || message.guildId !== this.d.guild.id) return false;
    if (message.channel.isThread()) return false;
    const hit = this.d.groups.lookup(message.channelId);
    if (!hit || hit.group.paused || this.paused) return false;
    if (message.author.id === this.d.botUserId) return false;
    if (this.d.groups.isOurWebhook(message.webhookId)) return false;
    if (message.type !== MessageType.Default && message.type !== MessageType.Reply) return false;
    return true;
  }

  // ---------- create ----------

  private async mirrorNew(message: Message) {
    const hit = this.d.groups.lookup(message.channelId)!;
    const targets = this.d.groups.targetsOf(message.channelId);
    if (targets.length === 0) return;

    const segments = collectSegments(message);
    const translatable = segments.filter((s) => hasTranslatableText(s.tokenized));
    const targetLangs = [...new Set(targets.map((t) => t.lang))].filter((l) => l !== hit.member.lang);

    let translations: Record<Lang, string[]> | null = null;
    let translated = true;
    if (translatable.length && targetLangs.length) {
      const r = await this.d.translator.translate(
        translatable.map((s) => s.tokenized),
        translatable.map((s) => s.entities),
        hit.member.lang,
        targetLangs,
        await this.glossary(),
        this.recent.get(message.channelId),
      );
      translations = r.translations;
      translated = r.translated;
    }
    this.remember(message);

    const files = await this.collectFiles(message);
    const rows: MapRow[] = [];
    for (const target of targets) {
      try {
        const built = await this.build(message, hit.member.lang, target, segments, translatable, translations, translated);
        const hook = await this.hooks.ensure(target);
        const ids = await this.send(hook, built, files);
        rows.push(...ids.map((id) => ({
          source_message_id: message.id,
          source_channel_id: message.channelId,
          target_channel_id: target.channel_id,
          mirror_message_id: id,
          lang: target.lang,
        })));
      } catch (e) {
        log.error("mirror send failed", { id: message.id, target: target.channel_id, ...errInfo(e) });
      }
    }
    await this.d.db.insertMap(rows);
    await this.d.db.setLastSeen(message.channelId, message.id).catch(() => {});
    log.info("mirrored", { id: message.id, from: hit.member.lang, targets: rows.length, translated });
  }

  private async build(
    message: Message,
    sourceLang: Lang,
    target: GroupMember,
    segments: Segment[],
    translatable: Segment[],
    translations: Record<Lang, string[]> | null,
    translated: boolean,
  ): Promise<WebhookMessageCreateOptions> {
    const lang = target.lang;
    const pick = (s: Segment): string => {
      const i = translatable.indexOf(s);
      const t = i >= 0 && translations && lang !== sourceLang ? translations[lang]?.[i] ?? s.tokenized : s.tokenized;
      return detokenize(t, s.entities);
    };

    let content = "";
    const embeds: APIEmbed[] = message.embeds.filter((e) => e.data.type === "rich" || !e.data.type).map((e) => e.toJSON());
    for (const s of segments) {
      const text = pick(s);
      const p = s.path;
      if (p[0] === "content") content = text;
      else if (p[0] === "embed") {
        const e = embeds[p[1]];
        if (!e) continue;
        if (p[2] === "title") e.title = text;
        else if (p[2] === "description") e.description = text;
        else if (p[2] === "footer" && e.footer) e.footer.text = text;
        else if (p[2] === "author" && e.author) e.author.name = text;
      } else if (p[0] === "field") {
        const f = embeds[p[1]]?.fields?.[p[2]];
        if (f) f[p[3]] = text;
      }
    }

    content = await remapForTarget(content, this.d.db, this.d.groups, this.d.guild.id, lang, target.channel_id);
    const contentSeg = segments.find((s) => s.path[0] === "content");
    const header = await replyHeader(message, this.d.db, this.d.guild.id, target.channel_id, null);
    const extras = [renderForward(message), renderPoll(message)].filter(Boolean) as string[];
    const parts = [header, ...extras, content].filter((p) => p && p.length);
    let body = parts.join("\n");
    if (!translated && contentSeg && hasTranslatableText(contentSeg.tokenized) && lang !== sourceLang) body += PENDING_NOTE;

    const member = message.member;
    return {
      content: body || undefined,
      username: sanitizeUsername(member?.displayName ?? message.author.displayName ?? message.author.username),
      avatarURL: (member ?? message.author).displayAvatarURL({ extension: "png", size: 256 }),
      embeds: embeds.length ? embeds.map((e) => EmbedBuilder.from(e)) : undefined,
      allowedMentions: {
        parse: message.mentions.everyone ? ["everyone"] : [],
        users: [...message.mentions.users.keys()],
        roles: [...message.mentions.roles.keys()],
      },
    };
  }

  private async send(hook: WebhookClient, built: WebhookMessageCreateOptions, files: { attachment: Buffer | string; name: string }[]): Promise<string[]> {
    const ids: string[] = [];
    const chunks = built.content ? splitForDiscord(built.content) : [undefined];
    for (let i = 0; i < chunks.length; i++) {
      const last = i === chunks.length - 1;
      const msg = await hook.send({
        ...built,
        content: chunks[i],
        embeds: last ? built.embeds : undefined,
        files: last && files.length ? files : undefined,
      });
      ids.push(msg.id);
    }
    return ids;
  }

  private async collectFiles(message: Message): Promise<{ attachment: Buffer | string; name: string }[]> {
    const limitMb = UPLOAD_LIMIT[this.d.guild.premiumTier] ?? 10;
    const files: { attachment: Buffer | string; name: string }[] = [];
    for (const a of message.attachments.values()) {
      if (a.size > limitMb * 1024 * 1024) {
        log.warn("attachment too large to re-upload, linking instead", { id: message.id, name: a.name, size: a.size });
        continue;
      }
      try {
        const res = await fetch(a.url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        files.push({ attachment: Buffer.from(await res.arrayBuffer()), name: a.name });
      } catch (e) {
        log.warn("attachment download failed", { id: message.id, name: a.name, ...errInfo(e) });
      }
    }
    for (const s of message.stickers.values()) {
      if (s.format === 3 /* Lottie */) continue;
      files.push({ attachment: s.url, name: `${s.name}.${s.format === 4 ? "gif" : "png"}` });
    }
    return files;
  }

  // ---------- edit ----------

  private async mirrorEdit(message: Message) {
    const rows = await this.d.db.mirrorsOf(message.id);
    if (rows.length === 0) return;
    const hit = this.d.groups.lookup(message.channelId)!;
    const targets = this.d.groups.targetsOf(message.channelId);
    const segments = collectSegments(message);
    const translatable = segments.filter((s) => hasTranslatableText(s.tokenized));
    const targetLangs = [...new Set(targets.map((t) => t.lang))].filter((l) => l !== hit.member.lang);
    let translations: Record<Lang, string[]> | null = null;
    let translated = true;
    if (translatable.length && targetLangs.length) {
      const r = await this.d.translator.translate(translatable.map((s) => s.tokenized), translatable.map((s) => s.entities), hit.member.lang, targetLangs, await this.glossary());
      translations = r.translations;
      translated = r.translated;
    }
    for (const target of targets) {
      const mine = rows.filter((r) => r.target_channel_id === target.channel_id);
      if (mine.length === 0) continue;
      try {
        const built = await this.build(message, hit.member.lang, target, segments, translatable, translations, translated);
        const hook = await this.hooks.ensure(target);
        const chunks = built.content ? splitForDiscord(built.content) : [undefined];
        // edit existing chunks in place; extra chunks are dropped, missing ones appended to the last
        for (let i = 0; i < mine.length; i++) {
          const isLast = i === mine.length - 1;
          const content = isLast ? chunks.slice(i).join("\n") : chunks[i];
          await hook.editMessage(mine[i].mirror_message_id, {
            content: content ?? "",
            embeds: isLast ? built.embeds : undefined,
            allowedMentions: built.allowedMentions,
          });
        }
      } catch (e) {
        log.error("mirror edit failed", { id: message.id, target: target.channel_id, ...errInfo(e) });
      }
    }
    log.info("mirror edited", { id: message.id, targets: rows.length });
  }

  // ---------- delete ----------

  private async mirrorDelete(messageId: string) {
    // deleting an original removes its mirrors; deleting a mirror removes the original and siblings
    let sourceId = messageId;
    let sourceChannel: string | null = null;
    const asMirror = await this.d.db.sourceOf(messageId);
    if (asMirror) {
      sourceId = asMirror.source_message_id;
      sourceChannel = asMirror.source_channel_id;
    }
    const rows = await this.d.db.mirrorsOf(sourceId);
    if (rows.length === 0 && !asMirror) return;

    for (const r of rows) {
      if (r.mirror_message_id === messageId) continue;
      const target = this.d.groups.lookup(r.target_channel_id)?.member;
      if (!target) continue;
      try {
        const hook = await this.hooks.ensure(target);
        await hook.deleteMessage(r.mirror_message_id);
      } catch (e) {
        log.warn("mirror delete failed", { id: r.mirror_message_id, ...errInfo(e) });
      }
    }
    if (asMirror && sourceChannel) {
      try {
        const ch = await this.d.guild.channels.fetch(sourceChannel);
        if (ch?.isTextBased()) await ch.messages.delete(sourceId);
      } catch (e) {
        log.warn("original delete failed", { id: sourceId, ...errInfo(e) });
      }
    }
    await this.d.db.deleteMap(sourceId);
    log.info("mirror deleted", { id: sourceId, mirrors: rows.length });
  }

  // ---------- backfill ----------

  /** Mirrors anything posted while the bot was offline, oldest first. */
  async backfill(limit: number) {
    for (const channelId of this.d.groups.allChannelIds()) {
      const hit = this.d.groups.lookup(channelId)!;
      const ch = await this.d.guild.channels.fetch(channelId).catch(() => null);
      if (!ch || !ch.isTextBased()) continue;
      if (!hit.member.last_seen_message_id) {
        const latest = await ch.messages.fetch({ limit: 1 }).catch(() => null);
        const id = latest?.first()?.id;
        if (id) await this.d.db.setLastSeen(channelId, id);
        continue;
      }
      const missed = await ch.messages.fetch({ after: hit.member.last_seen_message_id, limit: Math.min(limit, 100) }).catch(() => null);
      if (!missed || missed.size === 0) continue;
      const ordered = [...missed.values()].sort((a, b) => Number(BigInt(a.id) - BigInt(b.id)));
      log.info("backfilling", { channel: channelId, count: ordered.length });
      for (const m of ordered) this.onCreate(m);
    }
  }

  // ---------- helpers ----------

  private async glossary() {
    if (this.glossaryCache && Date.now() - this.glossaryCache.at < 60_000) return this.glossaryCache.rows;
    const rows = await this.d.db.glossary(this.d.guild.id).catch(() => []);
    this.glossaryCache = { at: Date.now(), rows };
    return rows;
  }

  invalidateGlossary() {
    this.glossaryCache = null;
  }

  private remember(message: Message) {
    if (!message.content) return;
    const list = this.recent.get(message.channelId) ?? [];
    list.push(`${message.member?.displayName ?? message.author.username}: ${message.content.slice(0, 200)}`);
    while (list.length > 4) list.shift();
    this.recent.set(message.channelId, list);
  }
}

/** Everything in a message that is human language: content plus rich-embed strings. */
export function collectSegments(message: Message): Segment[] {
  const out: Segment[] = [];
  const add = (path: Segment["path"], text: string | null | undefined) => {
    if (!text) return;
    const t = tokenize(text);
    out.push({ path, tokenized: t.text, entities: t.entities });
  };
  add(["content"], message.content);
  const rich = message.embeds.filter((e) => e.data.type === "rich" || !e.data.type);
  rich.forEach((e, ei) => {
    add(["embed", ei, "title"], e.title);
    add(["embed", ei, "description"], e.description);
    add(["embed", ei, "footer"], e.footer?.text);
    add(["embed", ei, "author"], e.author?.name);
    e.fields.forEach((f, fi) => {
      add(["field", ei, fi, "name"], f.name);
      add(["field", ei, fi, "value"], f.value);
    });
  });
  return out;
}
