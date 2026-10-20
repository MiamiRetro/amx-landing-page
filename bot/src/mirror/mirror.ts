import {
  ChannelType,
  EmbedBuilder,
  MessageType,
  type APIEmbed,
  type Guild,
  type Message,
  type PartialMessage,
  type ThreadChannel,
  type WebhookClient,
  type WebhookMessageCreateOptions,
} from "discord.js";
import type { Lang } from "../config.js";
import type { Db, GroupMember, MapRow } from "../db/index.js";
import { log, errInfo } from "../log.js";
import type { Translator } from "../translate/index.js";
import { chooseFiles, type InfographicLocalizer } from "../infographic/index.js";
import type { GroupIndex } from "./groups.js";
import { detokenize, hasTranslatableText, splitForDiscord, tokenize } from "./placeholders.js";
import { KeyedQueue } from "./queue.js";
import { remapForTarget, renderForward, renderPoll, replyHeader } from "./render.js";
import { sanitizeUsername, WebhookPool, WEBHOOK_NAME } from "./webhooks.js";

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
  /** The bot's application id. Discord stamps it on every message sent through a webhook this bot created. */
  applicationId: string;
  /** Set when INFOGRAPHIC_TRANSLATION=1: re-renders tutorial infographics per language. */
  infographics?: InfographicLocalizer;
}

export class Mirror {
  readonly queue = new KeyedQueue();
  private hooks: WebhookPool;
  private glossaryCache: { at: number; rows: { term: string; note: string | null }[] } | null = null;
  private recent = new Map<string, string[]>();
  /** webhook id → true if it is one of our mirror webhooks (resolved lazily by name). */
  private webhookOwnership = new Map<string, boolean>();
  /** Message ids this bot deleted itself; their delete events are echoes, not new intents. */
  private selfDeleted = new Set<string>();
  paused = false;

  constructor(private d: MirrorDeps) {
    this.hooks = new WebhookPool(d.guild, d.db, (id) => d.groups.addWebhook(id));
  }

  get guild() {
    return this.d.guild;
  }

  /** Called on messageCreate. Decides whether the message is ours to mirror. */
  onCreate(message: Message) {
    // Our own mirrors still move the channel bookmark, so restarts do not re-scan them.
    if (message.webhookId && this.d.groups.isOurWebhook(message.webhookId) && this.d.groups.lookup(message.channelId)) {
      void this.d.db.setLastSeen(message.channelId, message.id).catch(() => {});
      return;
    }
    if (!this.accepts(message)) return;
    void this.queue.run(message.channelId, async () => {
      if (await this.isOwnMirrorWebhook(message)) return;
      await this.mirrorNew(message).catch((e) => log.error("mirror failed", { id: message.id, ...errInfo(e) }));
    });
  }

  /**
   * Second loop-guard layer. A message from a webhook we do not have on record
   * but that carries our application id came from a webhook this bot created.
   * Only our "AMX Mirror" webhooks count as ours; anything else (a test poster,
   * a webhook an admin made through the bot) is mirrored like any other bot.
   */
  private async isOwnMirrorWebhook(message: Message): Promise<boolean> {
    const id = message.webhookId;
    if (!id || message.applicationId !== this.d.applicationId) return false;
    if (this.d.groups.isOurWebhook(id)) return true;
    const known = this.webhookOwnership.get(id);
    if (known !== undefined) return known;
    const hook = await message.client.fetchWebhook(id).catch(() => null);
    const ours = hook?.name === WEBHOOK_NAME;
    this.webhookOwnership.set(id, ours);
    if (ours) this.d.groups.addWebhook(id);
    return ours;
  }

  onUpdate(message: Message | PartialMessage) {
    if (message.partial || !this.accepts(message)) return;
    if (message.channel.isThread()) return; // forum posts mirror on create only; edits stay where they were made
    if (!message.editedTimestamp) return; // embed unfurl, pin, etc.
    void this.queue.run(message.channelId, () => this.mirrorEdit(message).catch((e) => log.error("edit failed", { id: message.id, ...errInfo(e) })));
  }

  onDelete(message: Message | PartialMessage) {
    const hit = this.d.groups.lookup(message.channelId);
    if (!hit) return;
    if (this.selfDeleted.delete(message.id)) return;
    void this.queue.run(message.channelId, () => this.mirrorDelete(message.id).catch((e) => log.error("delete failed", { id: message.id, ...errInfo(e) })));
  }

  private accepts(message: Message | PartialMessage): message is Message {
    if (message.partial) return false;
    if (!message.inGuild() || message.guildId !== this.d.guild.id) return false;
    // Threads are mirrored only inside a mirrored forum (guides, strategies, forums).
    if (message.channel.isThread() && !this.forumOf(message)) return false;
    const hit = this.d.groups.lookup(this.forumOf(message) ?? message.channelId);
    if (!hit || hit.group.paused || this.paused) return false;
    if (message.author.id === this.d.botUserId) return false;
    // Loop guard layer 1: webhook ids we know we own. Layer 2 (application id +
    // webhook name) runs in isOwnMirrorWebhook before mirroring.
    if (this.d.groups.isOurWebhook(message.webhookId)) return false;
    if (message.type !== MessageType.Default && message.type !== MessageType.Reply) return false;
    return true;
  }

  // ---------- create ----------

  /** The forum a message's thread belongs to, when that forum is in a mirror group. */
  private forumOf(message: Message | PartialMessage): string | null {
    const ch = message.channel;
    if (!ch || !("isThread" in ch) || !ch.isThread() || !ch.parentId) return null;
    return this.d.groups.lookup(ch.parentId) ? ch.parentId : null;
  }

  private async mirrorNew(message: Message) {
    if (message.channel.isThread()) return this.mirrorForum(message);
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


  // ---------- forums ----------

  /**
   * A forum post opens the same post, title translated, in every twin forum;
   * a reply inside any of those posts lands in all the others. Map rows for a
   * post record the target forum as target_channel_id and the new thread's id
   * (also its starter message id) as mirror_message_id, so a thread's twins are
   * mirrorsOf(sourceThreadId), and a mirrored thread finds its source with sourceOf.
   */
  /**
   * A post's tags in a twin forum. Every language's forum lists its tags in the
   * same order (the onboarding script creates them that way), so a tag maps by
   * position, whatever its translated name.
   */
  private twinTags(thread: ThreadChannel, targetForumId: string): string[] {
    const source = thread.parent;
    const target = this.d.guild.channels.cache.get(targetForumId);
    if (!source || source.type !== ChannelType.GuildForum || !target || target.type !== ChannelType.GuildForum) return [];
    const from = source.availableTags, to = target.availableTags;
    return thread.appliedTags
      .map((id) => from.findIndex((t) => t.id === id))
      .map((i) => (i >= 0 ? to[i]?.id : undefined))
      .filter((id): id is string => !!id);
  }

  private async mirrorForum(message: Message) {
    const thread = message.channel as ThreadChannel;
    const forumId = thread.parentId!;
    const hit = this.d.groups.lookup(forumId)!;
    const isPost = message.id === thread.id;

    // Where this message goes: [target forum member, thread to post into (null = open a new post)]
    let dests: { member: GroupMember; threadId: string | null }[] = [];
    if (isPost) {
      dests = this.d.groups.targetsOf(forumId).map((member) => ({ member, threadId: null }));
    } else {
      const asSource = await this.d.db.mirrorsOf(thread.id);
      if (asSource.length) {
        dests = asSource.map((r) => ({ member: this.d.groups.lookup(r.target_channel_id)?.member, threadId: r.mirror_message_id })).filter((d): d is { member: GroupMember; threadId: string } => !!d.member);
      } else {
        const src = await this.d.db.sourceOf(thread.id);
        if (!src) return; // a post from before mirroring started
        const siblings = await this.d.db.mirrorsOf(src.source_message_id);
        const origin = this.d.groups.lookup(src.source_channel_id)?.member;
        if (origin) dests.push({ member: origin, threadId: src.source_message_id });
        for (const r of siblings) {
          if (r.mirror_message_id === thread.id) continue;
          const member = this.d.groups.lookup(r.target_channel_id)?.member;
          if (member) dests.push({ member, threadId: r.mirror_message_id });
        }
      }
    }
    if (dests.length === 0) return;

    const segments = collectSegments(message);
    const translatable = segments.filter((s) => hasTranslatableText(s.tokenized));
    const title = isPost ? tokenize(thread.name) : null;
    const asks = title ? [{ tokenized: title.text, entities: title.entities }, ...translatable] : translatable;
    const targetLangs = [...new Set(dests.map((d) => d.member.lang))].filter((l) => l !== hit.member.lang);
    let translations: Record<Lang, string[]> | null = null;
    let translated = true;
    if (asks.length && targetLangs.length) {
      const r = await this.d.translator.translate(asks.map((s) => s.tokenized), asks.map((s) => s.entities), hit.member.lang, targetLangs, await this.glossary());
      translations = r.translations;
      translated = r.translated;
    }
    // build() indexes translations by position in `translatable`; drop the title from the front.
    const bodyTranslations = translations && title
      ? (Object.fromEntries(Object.entries(translations).map(([l, arr]) => [l, arr.slice(1)])) as Record<Lang, string[]>)
      : translations;

    const files = await this.collectFiles(message);
    let localized: Map<Lang, Map<number, Buffer>> | undefined;
    if (this.d.infographics && files.length) {
      localized = await this.d.infographics
        .localize(hit.group.name, files, hit.member.lang, targetLangs, await this.glossary())
        .catch((e) => { log.warn("infographic pass failed, using originals", { id: message.id, ...errInfo(e) }); return undefined; });
    }
    const rows: MapRow[] = [];
    for (const d of dests) {
      try {
        const destFiles = chooseFiles(files, localized?.get(d.member.lang));
        const built = await this.build(message, hit.member.lang, d.member, segments, translatable, bodyTranslations, translated);
        const hook = await this.hooks.ensure(d.member);
        const chunks = built.content ? splitForDiscord(built.content) : [undefined];
        let threadId = d.threadId;
        const ids: string[] = [];
        for (let i = 0; i < chunks.length; i++) {
          const last = i === chunks.length - 1;
          const opts: WebhookMessageCreateOptions = { ...built, content: chunks[i], embeds: last ? built.embeds : undefined, files: last && destFiles.length ? destFiles : undefined };
          if (threadId) opts.threadId = threadId;
          else {
            const t = title && translations && d.member.lang !== hit.member.lang ? translations[d.member.lang]?.[0] ?? title.text : title?.text ?? thread.name;
            opts.threadName = detokenize(t, title?.entities ?? []).slice(0, 100);
            const tags = this.twinTags(thread, d.member.channel_id);
            if (tags.length) opts.appliedTags = tags;
          }
          const sent = await hook.send(opts);
          threadId ??= sent.channel_id;
          ids.push(sent.id);
        }
        const where = { source_thread_id: thread.id, target_thread_id: threadId! };
        if (isPost) rows.push({ source_message_id: message.id, source_channel_id: forumId, target_channel_id: d.member.channel_id, mirror_message_id: threadId!, lang: d.member.lang, ...where });
        else rows.push(...ids.map((id) => ({ source_message_id: message.id, source_channel_id: forumId, target_channel_id: d.member.channel_id, mirror_message_id: id, lang: d.member.lang, ...where })));
      } catch (e) {
        log.error("forum mirror failed", { id: message.id, target: d.member.channel_id, ...errInfo(e) });
      }
    }
    await this.d.db.insertMap(rows);
    log.info("forum mirrored", { id: message.id, post: isPost, from: hit.member.lang, targets: rows.length, translated });
  }

  /**
   * Once a day: forum posts and replies edited since the last sync are
   * re-translated into every copy (a post's title too), and ones deleted take
   * their copies with them. Forums are reference material, so a day's lag is
   * fine and saves translating every typo fix.
   */
  async syncForums(since: number): Promise<{ edited: number; deleted: number }> {
    const rows = await this.d.db.forumRows();
    const bySource = new Map<string, MapRow[]>();
    for (const r of rows) bySource.set(r.source_message_id, [...(bySource.get(r.source_message_id) ?? []), r]);
    let edited = 0, deleted = 0;

    for (const [sourceId, copies] of bySource) {
      const threadId = copies[0].source_thread_id!;
      const isPost = sourceId === threadId;
      const thread = (await this.d.guild.channels.fetch(threadId).catch(() => null)) as ThreadChannel | null;
      const original = thread ? await thread.messages.fetch(sourceId).catch(() => null) : null;

      if (!original) {
        for (const c of copies) {
          try {
            if (isPost) {
              const t = await this.d.guild.channels.fetch(c.target_thread_id!).catch(() => null);
              await t?.delete("original forum post deleted");
            } else {
              const target = this.d.groups.lookup(c.target_channel_id)?.member;
              if (target) await (await this.hooks.ensure(target)).deleteMessage(c.mirror_message_id, c.target_thread_id!);
            }
          } catch (e) {
            if (!/Unknown (Message|Channel)/.test(String(e))) log.warn("forum delete sync failed", { id: c.mirror_message_id, ...errInfo(e) });
          }
        }
        await this.d.db.deleteMap(sourceId);
        deleted++;
        continue;
      }
      if (!original.editedTimestamp || original.editedTimestamp < since) continue;

      const hit = this.d.groups.lookup(copies[0].source_channel_id);
      if (!hit) continue;
      const segments = collectSegments(original);
      const translatable = segments.filter((s) => hasTranslatableText(s.tokenized));
      const title = isPost ? tokenize(thread!.name) : null;
      const asks = title ? [{ tokenized: title.text, entities: title.entities }, ...translatable] : translatable;
      const langs = [...new Set(copies.map((c) => c.lang))].filter((l) => l !== hit.member.lang);
      let translations: Record<Lang, string[]> | null = null;
      let translated = true;
      if (asks.length && langs.length) {
        const r = await this.d.translator.translate(asks.map((s) => s.tokenized), asks.map((s) => s.entities), hit.member.lang, langs, await this.glossary());
        translations = r.translations;
        translated = r.translated;
      }
      const body = translations && title ? (Object.fromEntries(Object.entries(translations).map(([l, a]) => [l, a.slice(1)])) as Record<Lang, string[]>) : translations;
      for (const c of copies) {
        const target = this.d.groups.lookup(c.target_channel_id)?.member;
        if (!target) continue;
        try {
          const built = await this.build(original, hit.member.lang, target, segments, translatable, body, translated);
          const hook = await this.hooks.ensure(target);
          await hook.editMessage(isPost ? c.target_thread_id! : c.mirror_message_id, { content: built.content ?? "", embeds: built.embeds, allowedMentions: built.allowedMentions, threadId: c.target_thread_id! });
          if (title) {
            const name = detokenize(translations && c.lang !== hit.member.lang ? translations[c.lang]?.[0] ?? title.text : title.text, title.entities).slice(0, 100);
            const t = (await this.d.guild.channels.fetch(c.target_thread_id!).catch(() => null)) as ThreadChannel | null;
            if (t && t.name !== name) await t.setName(name, "original forum post renamed");
          }
        } catch (e) {
          log.warn("forum edit sync failed", { id: c.mirror_message_id, ...errInfo(e) });
        }
      }
      edited++;
    }
    log.info("forum sync", { edited, deleted, tracked: bySource.size });
    return { edited, deleted };
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
    // Claim the rows first so the delete events our own deletions produce find nothing to do.
    await this.d.db.deleteMap(sourceId);

    for (const r of rows) {
      if (r.mirror_message_id === messageId) continue;
      const target = this.d.groups.lookup(r.target_channel_id)?.member;
      if (!target) continue;
      try {
        const hook = await this.hooks.ensure(target);
        this.selfDeleted.add(r.mirror_message_id);
        await hook.deleteMessage(r.mirror_message_id);
      } catch (e) {
        this.selfDeleted.delete(r.mirror_message_id);
        if (!/Unknown Message/.test(String(e))) log.warn("mirror delete failed", { id: r.mirror_message_id, ...errInfo(e) });
      }
    }
    if (asMirror && sourceChannel) {
      try {
        const ch = await this.d.guild.channels.fetch(sourceChannel);
        this.selfDeleted.add(sourceId);
        if (ch?.isTextBased()) await ch.messages.delete(sourceId);
      } catch (e) {
        this.selfDeleted.delete(sourceId);
        if (!/Unknown Message/.test(String(e))) log.warn("original delete failed", { id: sourceId, ...errInfo(e) });
      }
    }
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
      const fresh = ordered.filter((m) => !this.d.groups.isOurWebhook(m.webhookId));
      await this.d.db.setLastSeen(channelId, ordered[ordered.length - 1].id).catch(() => {});
      if (fresh.length === 0) continue;
      log.info("backfilling", { channel: channelId, count: fresh.length });
      for (const m of fresh) this.onCreate(m);
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
