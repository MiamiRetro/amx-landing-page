/** Pins the translated notice (first message posted by the mirror webhook as "BLKBöX") in every twin. Idempotent. */
import { ChannelType, type TextChannel } from "discord.js";
import { connect } from "../src/lib/client.js";
const CATEGORIES = ["╭───  中文  ───╮", "╭───  한국어  ───╮", "╭───  Bahasa Indonesia  ───╮"];
async function main() {
  const { client, guild } = await connect();
  try {
    for (const catName of CATEGORIES) {
      const cat = guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name === catName)!;
      for (const ch of guild.channels.cache.filter((c): c is TextChannel => c.type === ChannelType.GuildText && c.parentId === cat.id).values()) {
        const msgs = await ch.messages.fetch({ limit: 20 });
        const notice = [...msgs.values()].reverse().find((m) => m.webhookId && m.author.username === "BLKBöX" && m.content.startsWith("📌"));
        if (!notice) { console.log(`no notice in #${ch.name}`); continue; }
        if (notice.pinned) { console.log(`already pinned #${ch.name}`); continue; }
        try { await notice.pin(); console.log(`pinned #${ch.name}`); } catch (e) { console.log(`FAILED #${ch.name}: ${(e as Error).message}`); }
      }
    }
  } finally { await client.destroy(); }
}
main();
