/**
 * Links the twins created by layouts/languages.json to their English sources,
 * records category/role settings for /mirror create and /language, and pins a
 * translated notice in every twin. Idempotent.
 */
import { ChannelType, WebhookClient, type TextChannel } from "discord.js";
import { LANGS, type Lang } from "../src/config.js";
import { Db } from "../src/db/index.js";
import { connect } from "../src/lib/client.js";
import { WEBHOOK_NAME } from "../src/mirror/webhooks.js";

const GROUPS: { name: string; source: string; readOnly: boolean }[] = [
  { name: "general", source: "💬・general", readOnly: false },
  { name: "trader-chat", source: "📈・trader-chat", readOnly: false },
  { name: "help-desk", source: "☎️・help-desk", readOnly: false },
  { name: "bitcoin", source: "🟠・bitcoin", readOnly: false },
  { name: "trade-alerts", source: "⚡・trade-alerts", readOnly: true },
  { name: "announcements", source: "📢・announcements", readOnly: true },
];
const CATEGORY: Record<Exclude<Lang, "en">, string> = { zh: "╭───  中文  ───╮", ko: "╭───  한국어  ───╮", id: "╭───  Bahasa Indonesia  ───╮" };
const ROLE: Record<Exclude<Lang, "en">, string> = { zh: "中文", ko: "한국어", id: "Bahasa Indonesia" };

function notice(lang: Exclude<Lang, "en">, source: string, readOnly: boolean): string {
  const s = `<#${source}>`;
  if (lang === "zh") return readOnly
    ? `📌 本频道是英文频道 ${s} 的自动翻译镜像，只读。翻译由机器完成，可能不完美；有疑问请以英文原文为准。用 \`/language\` 可随时切换语言。`
    : `📌 本频道是英文频道 ${s} 的自动翻译镜像。直接在这里用中文发言，社区所有人都能看到翻译后的内容；他们的回复也会翻译成中文出现在这里。翻译由机器完成，可能不完美。用 \`/language\` 可随时切换语言。`;
  if (lang === "ko") return readOnly
    ? `📌 이 채널은 영어 채널 ${s} 의 자동 번역 미러이며 읽기 전용입니다. 기계 번역이라 완벽하지 않을 수 있으니 애매하면 영어 원문을 기준으로 봐주세요. \`/language\` 로 언제든 언어를 바꿀 수 있어요.`
    : `📌 이 채널은 영어 채널 ${s} 의 자동 번역 미러입니다. 여기서 한국어로 바로 이야기하면 커뮤니티 전체가 번역된 내용을 보고, 답글도 한국어로 번역되어 여기 올라옵니다. 기계 번역이라 완벽하지 않을 수 있어요. \`/language\` 로 언제든 언어를 바꿀 수 있어요.`;
  return readOnly
    ? `📌 Kanal ini cermin terjemahan otomatis dari kanal Inggris ${s}, hanya-baca. Terjemahan mesin, bisa saja kurang pas; kalau ragu, acu teks Inggris aslinya. Ganti bahasa kapan saja dengan \`/language\`.`
    : `📌 Kanal ini cermin terjemahan otomatis dari kanal Inggris ${s}. Ngobrol saja di sini dalam bahasa Indonesia, seluruh komunitas akan melihat terjemahannya, dan balasan mereka muncul di sini dalam bahasa Indonesia. Terjemahan mesin, bisa saja kurang pas. Ganti bahasa kapan saja dengan \`/language\`.`;
}

async function main() {
  const { client, guild } = await connect();
  const db = new Db();
  try {
    const text = (name: string) => guild.channels.cache.find((c): c is TextChannel => (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement) && c.name === name) as TextChannel | undefined;

    for (const lang of LANGS) {
      if (lang === "en") continue;
      const cat = guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name === CATEGORY[lang]);
      const role = guild.roles.cache.find((r) => r.name === ROLE[lang]);
      if (!cat || !role) throw new Error(`missing category or role for ${lang}`);
      await db.setSetting(guild.id, `category:${lang}`, cat.id);
      await db.setSetting(guild.id, `role:${lang}`, role.id);
      console.log(`settings ${lang}: category=${cat.name} role=${role.name}`);
    }
    await db.setSetting(guild.id, "member_roles", "Member,Members");

    for (const g of GROUPS) {
      const source = text(g.source);
      if (!source) throw new Error(`source ${g.source} not found`);
      const groupId = (await db.findGroupByName(guild.id, g.name)) ?? (await db.createGroup(guild.id, g.name));
      await db.upsertMember({ channel_id: source.id, group_id: groupId, lang: "en", webhook_id: null, webhook_token: null });
      const linked: string[] = [`en=#${source.name}`];
      for (const lang of LANGS) {
        if (lang === "en") continue;
        const twin = guild.channels.cache.find((c): c is TextChannel => c.type === ChannelType.GuildText && c.name.endsWith(`${g.name}-${lang}`) && c.parentId && guild.channels.cache.get(c.parentId)?.name === CATEGORY[lang]) as TextChannel | undefined;
        if (!twin) throw new Error(`twin for ${g.name} ${lang} not found`);
        // ensure the mirror webhook now so the notice can be posted through it and the bot reuses it
        const hooks = await twin.fetchWebhooks();
        const hook = hooks.find((w) => w.name === WEBHOOK_NAME && w.token) ?? (await twin.createWebhook({ name: WEBHOOK_NAME, reason: "AMX mirror bot" }));
        await db.upsertMember({ channel_id: twin.id, group_id: groupId, lang, webhook_id: hook.id, webhook_token: hook.token! });
        const pinned = await twin.messages.fetchPinned().catch(() => null);
        if (!pinned || pinned.size === 0) {
          const wc = new WebhookClient({ id: hook.id, token: hook.token! });
          const msg = await wc.send({ content: notice(lang, source.id, g.readOnly), username: "BLKBöX", allowedMentions: { parse: [] } });
          await twin.messages.pin(msg.id).catch((e) => console.warn(`pin failed in #${twin.name}: ${e.message}`));
          wc.destroy();
        }
        linked.push(`${lang}=#${twin.name}`);
      }
      console.log(`group ${g.name}: ${linked.join("  ")}`);
    }
    console.log("done");
  } finally { await client.destroy(); }
}
main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });
