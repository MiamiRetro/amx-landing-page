import type { ChannelKey } from "./classify.js";
import type { Lang } from "../config.js";

export const VIA_LINE = "-# via Telegram";
const PENDING_LINE = /\n?-# ⏳ translation pending\s*$/;

export const FLAGS: Record<Lang, string> = {
  en: "🇬🇧", zh: "🇨🇳", ko: "🇰🇷", id: "🇮🇩", vi: "🇻🇳", es: "🇪🇸", pt: "🇧🇷", tr: "🇹🇷", ru: "🇷🇺", ja: "🇯🇵",
};

export const CHANNEL_LABEL: Record<ChannelKey, string> = {
  general: "💬 general",
  bitcoin: "₿ bitcoin",
  stocks: "📈 stocks",
  crypto: "🪙 crypto",
};

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export interface DiscordNames {
  user(id: string): string | null;
  channel(id: string): string | null;
  role(id: string): string | null;
}

/** The mirror's reply header: `[↩](https://discord.com/channels/g/c/m) **Name**: excerpt`, first line. */
const REPLY_HEADER = /^(?:\[↩\]\(https:\/\/discord\.com\/channels\/\d+\/(\d+)\/(\d+)\)|↩) \*\*[^*\n]+\*\*(?::[^\n]*)?\n?/;

/** Pulls the mirror's reply header off a translated copy; returns the linked message, if any. */
export function splitReplyHeader(content: string): { parent: { channelId: string; messageId: string } | null; rest: string } {
  const m = content.match(REPLY_HEADER);
  if (!m) return { parent: null, rest: content };
  return { parent: m[1] ? { channelId: m[1], messageId: m[2] } : null, rest: content.slice(m[0].length) };
}

/**
 * Discord markdown to Telegram HTML. Covers what people actually type:
 * mentions, custom emoji, bold/italic/strike/code, spoilers, subtext and links.
 */
export function discordToTelegram(content: string, names: DiscordNames): string {
  let s = content.replace(PENDING_LINE, "");
  s = s.replace(/<@!?(\d+)>/g, (_, id) => `@${names.user(id) ?? "member"}`);
  s = s.replace(/<#(\d+)>/g, (_, id) => `#${names.channel(id) ?? "channel"}`);
  s = s.replace(/<@&(\d+)>/g, (_, id) => `@${names.role(id) ?? "role"}`);
  s = s.replace(/<a?:(\w+):\d+>/g, ":$1:");
  s = s.replace(/<t:(\d+)(?::\w)?>/g, (_, t) => new Date(Number(t) * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC");
  s = escapeHtml(s);
  // Code first so its insides aren't styled.
  const code: string[] = [];
  s = s.replace(/```(?:\w+\n)?([\s\S]*?)```/g, (_, c) => `\u0000${code.push(`<pre>${c}</pre>`) - 1}\u0000`);
  s = s.replace(/`([^`\n]+)`/g, (_, c) => `\u0000${code.push(`<code>${c}</code>`) - 1}\u0000`);
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, t, u) => `<a href="${u.replace(/"/g, "&quot;")}">${t}</a>`);
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  s = s.replace(/__([^_\n]+)__/g, "<u>$1</u>");
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<i>$2</i>");
  s = s.replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, "$1<i>$2</i>");
  s = s.replace(/~~([^~\n]+)~~/g, "<s>$1</s>");
  s = s.replace(/\|\|([^|\n]+)\|\|/g, "<tg-spoiler>$1</tg-spoiler>");
  s = s.replace(/^-# (.*)$/gm, "<i>$1</i>");
  s = s.replace(/^#{1,3} (.*)$/gm, "<b>$1</b>");
  s = s.replace(/^&gt; (.*)$/gm, "┃ $1");
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => code[Number(i)]);
  return s.trim();
}

/** `₿ bitcoin · Name 🇰🇷` header, then the text. */
export function telegramPost(channel: ChannelKey, author: string, bodyHtml: string, lang?: Lang | null): string {
  const flag = lang && lang !== "en" ? ` ${FLAGS[lang]}` : "";
  const head = `<b>${escapeHtml(author)}</b>${flag} · <i>${CHANNEL_LABEL[channel]}</i>`;
  return bodyHtml ? `${head}\n${bodyHtml}` : head;
}

/**
 * Telegram text plus its formatting entities to Discord markdown would need
 * the entity list; the hosts mostly type plain text, so the plain text goes
 * through with Discord's own markdown characters left as typed. Mentions of
 * everyone/here are defanged by allowedMentions at send time.
 */
export function telegramToDiscord(text: string, replyHeader: string | null): string {
  const body = text.trim();
  // A reply to a member opens with their @mention, on the same line, so they get pinged.
  if (replyHeader && /^<@\d+>$/.test(replyHeader)) return [`${replyHeader} ${body}`.trim(), VIA_LINE].join("\n");
  return [replyHeader, body, VIA_LINE].filter(Boolean).join("\n");
}

/** User ids a host post may ping: the member it replies to. */
export function mentionedUsers(header: string | null | undefined): string[] {
  const m = header?.match(/^<@(\d+)>$/);
  return m ? [m[1]] : [];
}

/** Emoji Telegram lets a bot react with (standard reactions). */
export const TELEGRAM_REACTIONS = new Set([
  "👍", "👎", "❤", "🔥", "🥰", "👏", "😁", "🤔", "🤯", "😱", "🤬", "😢", "🎉", "🤩", "🤮", "💩", "🙏", "👌", "🕊", "🤡", "🥱", "🥴", "😍", "🐳",
  "❤‍🔥", "🌚", "🌭", "💯", "🤣", "⚡", "🍌", "🏆", "💔", "🤨", "😐", "🍓", "🍾", "💋", "🖕", "😈", "😴", "😭", "🤓", "👻", "👨‍💻", "👀", "🎃",
  "🙈", "😇", "😨", "🤝", "✍", "🤗", "🫡", "🎅", "🎄", "☃", "💅", "🤪", "🗿", "🆒", "💘", "🙉", "🦄", "😘", "💊", "🙊", "😎", "👾", "🤷‍♂",
  "🤷", "🤷‍♀", "😡",
]);

/** Telegram writes some emoji without the variation selector (❤ not ❤️). */
export function telegramEmoji(emoji: string): string | null {
  const plain = emoji.replace(/\uFE0F/g, "");
  return TELEGRAM_REACTIONS.has(plain) ? plain : null;
}

/** `❤️ 4 · 🔥 2` from Discord reaction counts, most first; custom emoji show as :name:. */
export function reactionLine(counts: { emoji: string; count: number }[]): string {
  return counts
    .filter((c) => c.count > 0)
    .sort((a, b) => b.count - a.count)
    .map((c) => `${escapeHtml(c.emoji)} ${c.count}`)
    .join(" · ");
}

/** Header for a Telegram reply that answers a Discord message, in the mirror's own format. */
export function discordReplyHeader(guildId: string, channelId: string, messageId: string, name: string, excerpt: string): string {
  const clean = excerpt.replace(PENDING_LINE, "").replace(/\s+/g, " ").trim();
  const short = clean.slice(0, 80) + (clean.length > 80 ? "…" : "");
  const head = `[↩](https://discord.com/channels/${guildId}/${channelId}/${messageId}) **${name.replace(/\*/g, "")}**`;
  return short ? `${head}: ${short}` : head;
}

/** Discord caps message content at 2000 characters. */
export function fitDiscord(content: string, limit = 2000): string {
  if (content.length <= limit) return content;
  const tail = `…\n${VIA_LINE}`;
  return content.slice(0, limit - tail.length) + tail;
}

/** Telegram caps text at 4096 and captions at 1024. */
export function fitTelegram(html: string, limit: number): string {
  if (html.length <= limit) return html;
  // Cutting HTML mid-tag breaks parsing; drop tags from the overflow version.
  const plain = html.replace(/<[^>]+>/g, "");
  return plain.length <= limit ? plain : plain.slice(0, limit - 1) + "…";
}
