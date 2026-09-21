/** Renames the language twins to native-language names, keeping the emoji prefix. Idempotent. */
import { ChannelType, type TextChannel } from "discord.js";
import { connect } from "../src/lib/client.js";

const CATEGORY: Record<string, string> = { "╭───  中文  ───╮": "zh", "╭───  한국어  ───╮": "ko", "╭───  Bahasa Indonesia  ───╮": "id" };
const NAMES: Record<string, Record<string, string>> = {
  "📢": { zh: "公告", ko: "공지사항", id: "pengumuman" },
  "⚡": { zh: "交易提醒", ko: "매매신호", id: "sinyal-trading" },
  "🟠": { zh: "比特币", ko: "비트코인", id: "bitcoin" },
  "💬": { zh: "闲聊", ko: "자유채팅", id: "obrolan-umum" },
  "📈": { zh: "交易者聊天", ko: "트레이더-채팅", id: "obrolan-trader" },
  "☎️": { zh: "帮助台", ko: "도움말", id: "bantuan" },
};

async function main() {
  const dry = process.argv.includes("--dry-run");
  const { client, guild } = await connect();
  try {
    for (const [catName, lang] of Object.entries(CATEGORY)) {
      const cat = guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name === catName);
      if (!cat) throw new Error(`category ${catName} not found`);
      for (const ch of guild.channels.cache.filter((c): c is TextChannel => c.type === ChannelType.GuildText && c.parentId === cat.id).values()) {
        const emoji = Object.keys(NAMES).find((e) => ch.name.startsWith(e));
        if (!emoji) { console.log(`skip #${ch.name} (no known emoji)`); continue; }
        const target = `${emoji}・${NAMES[emoji][lang]}`;
        if (ch.name === target) { console.log(`ok   #${ch.name}`); continue; }
        console.log(`${dry ? "[dry-run] " : ""}#${ch.name} → #${target}`);
        if (!dry) await ch.setName(target, "native-language channel names");
      }
    }
  } finally { await client.destroy(); }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
