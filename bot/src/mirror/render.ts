import type { Message, MessageReference } from "discord.js";
import type { Lang } from "../config.js";
import type { Db } from "../db/index.js";
import type { GroupIndex } from "./groups.js";

const MSG_LINK = /https:\/\/(?:ptb\.|canary\.)?discord\.com\/channels\/(\d+)\/(\d+)\/(\d+)/g;
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

/** Rewrites channel mentions and message links so they point at the reader's language twin. */
export async function remapForTarget(text: string, db: Db, groups: GroupIndex, guildId: string, targetLang: Lang, targetChannelId: string): Promise<string> {
  let out = text.replace(CHAN_MENTION, (m, id: string) => {
    const twin = groups.twin(id, targetLang);
    return twin ? `<#${twin}>` : m;
  });
  const links = [...out.matchAll(MSG_LINK)];
  for (const link of links) {
    const [full, g, chan, msg] = link;
    if (g !== guildId) continue;
    const twinChannel = groups.twin(chan, targetLang);
    if (!twinChannel) continue;
    const twinMsg = await counterpart(db, msg, chan, twinChannel).catch(() => null);
    if (twinMsg) out = out.replace(full, `https://discord.com/channels/${g}/${twinChannel}/${twinMsg}`);
    else if (twinChannel !== targetChannelId) out = out.replace(full, `https://discord.com/channels/${g}/${twinChannel}`);
  }
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
