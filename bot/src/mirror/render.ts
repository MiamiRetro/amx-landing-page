import type { Message, MessageReference } from "discord.js";
import type { Lang } from "../config.js";
import type { Db } from "../db/index.js";
import type { GroupIndex } from "./groups.js";

/** https://discord.com/channels/<guild>/<channel>[/<message>] */
const DISCORD_LINK = /https:\/\/((?:ptb\.|canary\.)?discord(?:app)?\.com)\/channels\/(\d+)\/(\d+)(?:\/(\d+))?/g;
const CHAN_MENTION = /<#(\d+)>/g;

/**
 * Finds the message in `targetChannelId` that corresponds to `messageId`,
 * whether `messageId` is an original or one of its mirrors.
 */
export async function counterpart(db: Db, messageId: string, sourceChannelId: string, targetChannelId: string): Promise<string | null> {
  if (sourceChannelId === targetChannelId) return messageId;
  const mirrors = await db.mirrorsOf(messageId);
  const direct = mirrors.find((m) => m.target_channel_id === targetChannelId);
  if (direct) return direct.mirror_message_id;
  const src = await db.sourceOf(messageId);
  if (!src) return null;
  if (src.source_channel_id === targetChannelId) return src.source_message_id;
  const siblings = await db.mirrorsOf(src.source_message_id);
  return siblings.find((m) => m.target_channel_id === targetChannelId)?.mirror_message_id ?? null;
}

/** What finding a language twin needs: the mirror groups and the message map. */
export interface TwinSource {
  db: Pick<Db, "mirrorsOf" | "sourceOf">;
  groups: Pick<GroupIndex, "twin" | "lookup">;
}

/** The language a mirrored channel or forum is in, or null when it isn't mirrored. */
function langOfChannel(src: TwinSource, channelId: string): Lang | null {
  return src.groups.lookup(channelId)?.member.lang ?? null;
}

/**
 * The copy of `id` that readers of `lang` have: the original when it is in
 * `lang`, otherwise its mirror in `lang`. Works for messages and for forum
 * posts (a post's thread id is its starter message id). Null when there is none.
 */
export async function twinByLang(src: TwinSource, id: string, lang: Lang): Promise<string | null> {
  const mirrors = await src.db.mirrorsOf(id);
  if (mirrors.length) {
    const from = langOfChannel(src, mirrors[0].source_channel_id);
    if (from === lang) return id;
    return mirrors.find((m) => m.lang === lang)?.mirror_message_id ?? null;
  }
  const origin = await src.db.sourceOf(id);
  if (!origin) return null;
  if (origin.lang === lang) return id;
  if (langOfChannel(src, origin.source_channel_id) === lang) return origin.source_message_id;
  const siblings = await src.db.mirrorsOf(origin.source_message_id);
  return siblings.find((m) => m.lang === lang)?.mirror_message_id ?? null;
}

/**
 * The channel `lang` readers should be sent to instead of `channelId`: its twin
 * in the same mirror group, or for a mirrored forum post, the same post in
 * their language's forum. Null when `channelId` has no language twin, so a
 * channel everyone shares stays as it is.
 */
export async function twinChannel(src: TwinSource, channelId: string, lang: Lang): Promise<string | null> {
  if (src.groups.lookup(channelId)) return src.groups.twin(channelId, lang);
  return twinByLang(src, channelId, lang).catch(() => null);
}

async function replaceAsync(text: string, re: RegExp, fn: (...m: string[]) => Promise<string>): Promise<string> {
  const hits = [...text.matchAll(re)];
  if (hits.length === 0) return text;
  const subs = await Promise.all(hits.map((h) => fn(...(h as unknown as string[]))));
  let out = "", last = 0;
  hits.forEach((h, i) => {
    out += text.slice(last, h.index) + subs[i];
    last = h.index! + h[0].length;
  });
  return out + text.slice(last);
}

/**
 * Rewrites channel mentions and Discord links so they point at the reader's
 * language twin: <#english-channel> becomes <#japanese-channel> in the
 * Japanese copy, a mirrored forum post becomes the same post in their forum,
 * and a message link becomes the link to that message's copy. Anything with
 * no language twin is left alone.
 */
export async function remapForTarget(text: string, db: TwinSource["db"], groups: TwinSource["groups"], guildId: string, targetLang: Lang, targetChannelId: string | null = null): Promise<string> {
  if (!text) return text;
  const src: TwinSource = { db, groups };
  let out = await replaceAsync(text, CHAN_MENTION, async (m, id) => {
    const twin = await twinChannel(src, id, targetLang);
    return twin ? `<#${twin}>` : m;
  });
  out = await replaceAsync(out, DISCORD_LINK, async (full, host, g, chan, msg) => {
    if (g !== guildId) return full;
    const twinChan = await twinChannel(src, chan, targetLang);
    if (!twinChan) return full;
    if (!msg) return `https://${host}/channels/${g}/${twinChan}`;
    const twinMsg = await twinByLang(src, msg, targetLang).catch(() => null);
    if (twinMsg) return `https://${host}/channels/${g}/${twinChan}/${twinMsg}`;
    return twinChan !== targetChannelId ? `https://${host}/channels/${g}/${twinChan}` : full;
  });
  return out;
}

/** The quoted header used in place of a native reply. */
export async function replyHeader(
  message: Message,
  db: Db,
  guildId: string,
  targetChannelId: string,
  translatedExcerpt: string | null,
): Promise<string | null> {
  const ref = message.reference as MessageReference | null;
  if (!ref?.messageId) return null;
  const parent = await message.fetchReference().catch(() => null);
  const name = parent?.member?.displayName ?? parent?.author.displayName ?? "…";
  const target = await counterpart(db, ref.messageId, ref.channelId, targetChannelId).catch(() => null);
  const excerptSource = translatedExcerpt ?? parent?.content ?? "";
  const excerpt = excerptSource.replace(/\s+/g, " ").trim().slice(0, 80);
  const link = target ? `https://discord.com/channels/${guildId}/${targetChannelId}/${target}` : null;
  const head = link ? `[↩](${link}) **${name}**` : `↩ **${name}**`;
  return excerpt ? `${head}: ${excerpt}${excerptSource.length > 80 ? "…" : ""}` : head;
}

/** Text rendering for things webhooks cannot send natively (polls, forwards). */
export function renderPoll(message: Message): string | null {
  const poll = message.poll;
  if (!poll) return null;
  const lines = [`📊 **${poll.question.text}**`];
  for (const a of poll.answers.values()) lines.push(`• ${a.emoji ? `${a.emoji.toString()} ` : ""}${a.text ?? ""}`);
  return lines.join("\n");
}

export function renderForward(message: Message): string | null {
  const snaps = message.messageSnapshots;
  if (!snaps || snaps.size === 0) return null;
  const first = snaps.first();
  const body = first?.content ?? "";
  return body ? `> ${body.replace(/\n/g, "\n> ")}` : null;
}
