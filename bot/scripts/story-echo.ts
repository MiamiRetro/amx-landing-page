/**
 * Copies one already-shared story post from Discord into the Telegram group,
 * the same way new stories now are (for stories shared before that existed).
 *
 *   railway run -e production npx tsx scripts/story-echo.ts <discord message link> <telegram chat id>
 *
 * Needs DISCORD_TOKEN and TELEGRAM_BRIDGE_TOKEN in the environment.
 */
import { storyNotice } from "../src/telegram/format.js";
import { STORY_LINE } from "../src/telegram/stories.js";

const [link, chatArg] = process.argv.slice(2);
const m = link?.match(/channels\/(\d+)\/(\d+)\/(\d+)/);
const chat = Number(chatArg || process.env.TELEGRAM_BRIDGE_CHAT_ID);
if (!m || !chat) throw new Error("usage: story-echo.ts <discord message link> <telegram chat id>");
const [, , channelId, messageId] = m;

const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`, { headers: { authorization: `Bot ${process.env.DISCORD_TOKEN}` } });
if (!res.ok) throw new Error(`discord ${res.status}: ${await res.text()}`);
const msg = (await res.json()) as { content: string; author: { username: string }; attachments: { url: string; content_type?: string }[] };
const caption = msg.content.replace(STORY_LINE, "").trim();
const html = storyNotice(msg.author.username, "general", link, caption).slice(0, 1024);
const file = msg.attachments[0];
const [method, extra] = file?.content_type?.startsWith("image/") ? ["sendPhoto", { photo: file.url, caption: html }]
  : file?.content_type?.startsWith("video/") ? ["sendVideo", { video: file.url, caption: html, supports_streaming: true }]
  : ["sendMessage", { text: html, link_preview_options: { is_disabled: true } }];
const tg = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BRIDGE_TOKEN}/${method}`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ chat_id: chat, parse_mode: "HTML", ...extra }),
});
const body = (await tg.json()) as { ok: boolean; description?: string; result?: { message_id: number } };
console.log(body.ok ? `sent to Telegram as message ${body.result?.message_id} (${method})` : `telegram failed: ${body.description}`);
