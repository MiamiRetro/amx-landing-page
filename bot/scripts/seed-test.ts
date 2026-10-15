/**
 * Dresses a TEST server so it looks like the finished thing: the branded
 * picker and start-here cards, and mock chat in every channel, in each
 * channel's language, posted through webhooks under made-up member names.
 *
 *   railway run env DISCORD_GUILD_ID=<test id> npx tsx scripts/seed-test.ts
 *
 * Refuses to run against the live server. Re-running replaces what it posted.
 */
import { ChannelType, type ForumChannel, type Guild, type TextChannel, type Webhook } from "discord.js";
import { connect } from "../src/lib/client.js";
import { startHereMessages } from "../src/startHere.js";
import { Db } from "../src/db/index.js";

const LIVE = "935681399095169035";
const HOOK = "Mock chat";

type Line = [who: string, text: string];

/** People who appear in the mock chat. Avatars are Discord's default ones, picked by index. */
const AVATAR = (i: number) => `https://cdn.discordapp.com/embed/avatars/${i % 6}.png`;
const PEOPLE: Record<string, number> = {};
const avatarFor = (name: string) => AVATAR((PEOPLE[name] ??= Object.keys(PEOPLE).length));

const ALERT_FULL = (side: string, pair: string, entry: string, sl: string, tp: string) =>
  `**${side} ${pair}**\nEntry  \`${entry}\`\nStop  \`${sl}\`\nTargets  \`${tp}\`\nLeverage  \`5x\`  ·  Risk  \`1%\``;
const ALERT_TEASER = (side: string, pair: string, cta: string) =>
  `**${side} ${pair}**\nEntry  \`▒▒▒▒▒▒\`\nStop  \`▒▒▒▒▒▒\`\nTargets  \`▒▒▒▒▒▒ / ▒▒▒▒▒▒\`\n-# 🔒 ${cta}`;

/** Mock content per channel name. Keyed by exact channel name; the same name in two categories gets the same chat. */
const CHAT: Record<string, Line[]> = {
  // English
  "📢・announcements": [
    ["BLKBöX", "## Weekly market call\nThursday **18:00 UTC** in 🎙・Meeting Room. Baloo and Matt walk through the BTC weekly, funding and where the bots are positioned.\n-# Recording goes up in setup-guides afterwards."],
    ["BLKBöX", "## Blofin now verifies instantly\nPaste your Blofin UID in ✅・verify and the Trading Floor opens in a second. No waiting for a moderator."],
  ],
  "⚡・trade-alerts": [
    ["AlphanumetriX", ALERT_FULL("🟢 LONG", "BTC/USDT", "61,240", "59,880", "63,100 / 64,500")],
    ["AlphanumetriX", ALERT_FULL("🔴 SHORT", "SOL/USDT", "148.20", "153.60", "141.00 / 136.50")],
    ["AlphanumetriX", "✅ **BTC/USDT** TP1 hit at 63,100 (+3.0%). Stop moved to entry."],
  ],
  "🔒・trade-alerts": [
    ["AlphanumetriX", ALERT_TEASER("🟢 LONG", "BTC/USDT", "Verify your UID to see entries, stops and targets.")],
    ["AlphanumetriX", ALERT_TEASER("🔴 SHORT", "SOL/USDT", "Verify your UID to see entries, stops and targets.")],
    ["AlphanumetriX", "✅ **BTC/USDT** TP1 hit (+3.0%). Members got this one 6 hours ago."],
  ],
  "💬・general": [
    ["Marta", "gm all ☕"],
    ["dylanb", "gm. anyone else wake up to that funding flip?"],
    ["Kenji", "yeah longs got cleaned up around 59.9k, back above now"],
    ["Marta", "the BTC alert from yesterday already hit TP1 btw"],
    ["Sam R.", "first week here, the setup guide for Blofin was super clear 🙏"],
  ],
  "📈・trader-chat": [
    ["Kenji", "SOL 4h holding the range low at 146. Waiting for a reclaim of 150 before adding."],
    ["Priya", "same read. OI is flat so not much leverage chasing it yet"],
    ["dylanb", "anyone trading the ETH/BTC ratio here? 0.036 looks like support"],
    ["Priya", "watching it, but I want a weekly close above 0.037 first"],
  ],
  "🟠・bitcoin": [
    ["Tone", "Weekly still above the 50 SMA. Nothing on the higher timeframe says the trend is over."],
    ["Marta", "ETF flows were positive 4 days straight too"],
    ["Sam R.", "what's everyone's DCA schedule? I do every Monday"],
  ],
  "🐸・memes": [
    ["dylanb", "me explaining to my wife why I need a 4th monitor for 'research'"],
    ["Kenji", "😂 the bots trade while I sleep, that's the whole point"],
  ],
  "☎️・help-desk": [
    ["Sam R.", "Where do I find my UID on Bybit?"],
    ["Mod · Lena", "Profile icon top right, it's the number under your email. There's a picture of it in ✅・verify too."],
    ["Sam R.", "got it, verified ✅ thanks!"],
  ],

  // 中文
  "📢・公告": [
    ["BLKBöX", "## 每周市场直播\n周四 **18:00 UTC**，在 🎙・Meeting Room。Baloo 和 Matt 会讲解 BTC 周线、资金费率以及机器人目前的仓位。"],
    ["BLKBöX", "## Blofin 现已支持即时验证\n在 ✅・验证 粘贴你的 Blofin UID，一秒钟即可开放交易大厅。"],
  ],
  "⚡・交易提醒": [
    ["AlphanumetriX", ALERT_FULL("🟢 做多", "BTC/USDT", "61,240", "59,880", "63,100 / 64,500")],
    ["AlphanumetriX", "✅ **BTC/USDT** 第一目标 63,100 已达成（+3.0%）。止损移至开仓价。"],
  ],
  "💬・闲聊": [
    ["小林", "大家早上好 ☕"],
    ["阿杰", "早！昨晚资金费率翻转了，有人看到吗？"],
    ["Mei", "多单在 59.9k 附近被清了一波，现在又回来了"],
    ["小林", "昨天的 BTC 提醒已经到第一目标了"],
  ],
  "📈・交易者聊天": [
    ["阿杰", "SOL 4 小时图守住了 146 区间下沿，等重新站上 150 再加仓。"],
    ["Mei", "同意，持仓量没怎么变，还没有太多杠杆追进来"],
  ],
  "🟠・比特币": [
    ["Mei", "周线还在 50 均线上方，大周期趋势没有结束的迹象。"],
    ["小林", "ETF 已经连续 4 天净流入了"],
  ],
  "☎️・帮助台": [
    ["小林", "Bybit 的 UID 在哪里找？"],
    ["管理员 · Lena", "右上角头像，邮箱下面那串数字就是。✅・验证 里也有示意图。"],
  ],

  // 한국어
  "📢・공지사항": [
    ["BLKBöX", "## 주간 마켓 콜\n목요일 **18:00 UTC**, 🎙・Meeting Room에서 진행합니다. Baloo와 Matt가 BTC 주봉, 펀딩비, 봇 포지션을 짚어 드려요."],
    ["BLKBöX", "## Blofin 즉시 인증 지원\n✅・인증 채널에 Blofin UID를 붙여 넣으면 바로 트레이딩 플로어가 열립니다."],
  ],
  "⚡・매매신호": [
    ["AlphanumetriX", ALERT_FULL("🟢 롱", "BTC/USDT", "61,240", "59,880", "63,100 / 64,500")],
    ["AlphanumetriX", "✅ **BTC/USDT** 1차 목표 63,100 도달 (+3.0%). 손절가를 진입가로 이동."],
  ],
  "💬・자유채팅": [
    ["지훈", "다들 좋은 아침 ☕"],
    ["수아", "어젯밤 펀딩비 뒤집힌 거 보셨어요?"],
    ["민준", "59.9k 근처에서 롱 청산 한 번 나오고 다시 올라왔네요"],
  ],
  "📈・트레이더-채팅": [
    ["민준", "SOL 4시간봉 146 박스 하단 지지 중. 150 회복하면 추가 진입 생각 중입니다."],
    ["수아", "동의해요. 미결제약정이 그대로라 아직 레버리지가 많이 안 붙었어요"],
  ],
  "🟠・비트코인": [
    ["지훈", "주봉은 여전히 50일선 위. 큰 추세가 꺾였다는 신호는 없어요."],
    ["수아", "ETF 4일 연속 순유입이에요"],
  ],
  "☎️・도움말": [
    ["지훈", "바이비트 UID는 어디서 찾나요?"],
    ["운영진 · Lena", "오른쪽 위 프로필 아이콘, 이메일 아래 숫자예요. ✅・인증 채널에 그림도 있어요."],
  ],

  // Bahasa Indonesia
  "📢・pengumuman": [
    ["BLKBöX", "## Market call mingguan\nKamis **18:00 UTC** di 🎙・Meeting Room. Baloo dan Matt membahas BTC weekly, funding, dan posisi bot."],
    ["BLKBöX", "## Blofin sekarang verifikasi instan\nTempel UID Blofin kamu di ✅・verifikasi dan Trading Floor langsung terbuka."],
  ],
  "⚡・sinyal-trading": [
    ["AlphanumetriX", ALERT_FULL("🟢 LONG", "BTC/USDT", "61,240", "59,880", "63,100 / 64,500")],
    ["AlphanumetriX", "✅ **BTC/USDT** TP1 kena di 63,100 (+3.0%). Stop dipindah ke entry."],
  ],
  "💬・obrolan-umum": [
    ["Rizky", "pagi semua ☕"],
    ["Ayu", "ada yang lihat funding flip semalam?"],
    ["Budi", "long kena likuidasi sekitar 59.9k, sekarang sudah naik lagi"],
  ],
  "📈・obrolan-trader": [
    ["Budi", "SOL 4h bertahan di bawah range 146. Tunggu reclaim 150 baru tambah posisi."],
    ["Ayu", "setuju, OI masih datar jadi belum banyak leverage yang masuk"],
  ],
  "☎️・bantuan": [
    ["Rizky", "UID Bybit ada di mana ya?"],
    ["Mod · Lena", "Ikon profil di kanan atas, angka di bawah email kamu. Ada gambarnya juga di ✅・verifikasi."],
  ],
};

/** The bitcoin twins share a name across languages; tell them apart by category. */
const BY_CATEGORY: Record<string, Record<string, Line[]>> = {
  "╭───  Bahasa Indonesia  ───╮": {
    "🟠・bitcoin": [
      ["Ayu", "Weekly masih di atas SMA 50. Belum ada tanda tren besar selesai."],
      ["Rizky", "ETF inflow 4 hari berturut-turut"],
    ],
  },
};

const FORUMS: Record<string, { title: string; lines: Line[] }[]> = {
  "📕・setup-guides": [
    { title: "Connect Blofin to the command center", lines: [["BLKBöX", "1. Blofin → Profile → API Management → Create\n2. Permissions: **Read** and **Trade**. Never Withdraw.\n3. Paste the key, secret and passphrase in app.blkbox.pro → Exchanges\n-# Takes about two minutes."], ["Sam R.", "worked first try, thanks"]] },
    { title: "Find your UID on Bybit, Bitget and Blofin", lines: [["BLKBöX", "Your UID is the account number in your exchange profile, usually 7 to 10 digits. It is never your email or an API key."]] },
  ],
  "📗・trading-strategies": [
    { title: "Risk 1% per trade", lines: [["BLKBöX", "Every alert lists a stop. Size the position so hitting that stop costs 1% of your account. Ten losers in a row is a bad week, not a blown account."], ["Priya", "this alone changed my trading"]] },
    { title: "Reading funding rates", lines: [["Kenji", "When funding is very positive, longs are paying shorts to stay open. Crowded longs tend to get flushed."]] },
  ],
  "🧵・forums": [
  { title: "Share your setup 🖥️", lines: [["dylanb", "3 monitors, TradingView on two, the command center on the third."], ["Kenji", "laptop + phone, I let the bots do the work 😅"]] },
  { title: "Blofin vs Bybit for futures?", lines: [["Sam R.", "Which one do people prefer for futures from the EU?"], ["Priya", "Blofin, no ID check and futures are open straight away."]] },
  ],
};

async function hookFor(ch: TextChannel | ForumChannel, botId: string): Promise<Webhook> {
  const hooks = await ch.fetchWebhooks();
  return hooks.find((h) => h.name === HOOK && h.owner?.id === botId) ?? (await ch.createWebhook({ name: HOOK, reason: "test server mock chat" }));
}

async function clearOld(ch: TextChannel, hookId: string, botId: string) {
  const msgs = await ch.messages.fetch({ limit: 100 });
  for (const m of msgs.values()) if (m.webhookId || m.author.id === botId) await m.delete().catch(() => {});
}

async function seed(guild: Guild) {
  const me = guild.members.me ?? (await guild.members.fetchMe());
  const text = (name: string, parent?: string) =>
    guild.channels.cache.find(
      (c): c is TextChannel =>
        c.type === ChannelType.GuildText && c.name === name && (parent === undefined || guild.channels.cache.get(c.parentId ?? "")?.name === parent),
    );
  const helpDesk = text("☎️・help-desk");
  const helpDeskUrl = helpDesk ? `https://discord.com/channels/${guild.id}/${helpDesk.id}` : `https://discord.com/channels/${guild.id}`;

  // Branded cards
  for (const [name, picker] of [["🌐・choose-language", true], ["📍・start-here", false]] as const) {
    const ch = text(name);
    if (!ch) { console.log(`! no #${name}`); continue; }
    const old = (await ch.messages.fetch({ limit: 50 })).filter((m) => m.author.id === me.id);
    for (const m of old.values()) await m.delete().catch(() => {});
    for (const msg of startHereMessages({ helpDeskUrl, picker })) await ch.send(msg);
    console.log(`cards  #${name}`);
  }

  // Mirrored channels get their chat from the bot: post in the English
  // source and the bot translates it into every language twin. Clear all of
  // them first (deleting a mirror deletes its original), then post English only.
  const groups = await new Db().loadGroups(guild.id);
  const twinIds = new Set(groups.flatMap((g) => g.members.filter((m) => m.lang !== "en").map((m) => m.channel_id)));
  const groupIds = new Set(groups.flatMap((g) => g.members.map((m) => m.channel_id)));
  for (const id of groupIds) {
    const ch = guild.channels.cache.get(id) as TextChannel | undefined;
    if (!ch) continue;
    for (const m of (await ch.messages.fetch({ limit: 100 })).values()) if (m.webhookId) await m.delete().catch(() => {});
  }
  await new Promise((r) => setTimeout(r, 8000));

  // Mock chat
  const post = async (ch: TextChannel, lines: Line[]) => {
    const hook = await hookFor(ch, me.id);
    await clearOld(ch, hook.id, me.id);
    for (const [who, content] of lines) await hook.send({ username: who, avatarURL: avatarFor(who), content, allowedMentions: { parse: [] } });
    console.log(`chat   #${ch.name} (${lines.length})`);
  };
  for (const ch of guild.channels.cache.values()) {
    if (ch.type !== ChannelType.GuildText) continue;
    const cat = guild.channels.cache.get(ch.parentId ?? "")?.name ?? "";
    if (twinIds.has(ch.id)) continue; // filled by the mirror
    const lines = BY_CATEGORY[cat]?.[ch.name] ?? CHAT[ch.name];
    if (lines) await post(ch as TextChannel, lines);
  }

  // Forum threads
  for (const [name, posts] of Object.entries(FORUMS)) {
    const forum = guild.channels.cache.find((c): c is ForumChannel => c.type === ChannelType.GuildForum && c.name === name);
    if (!forum) { console.log(`! no forum #${name}`); continue; }
    const hook = await hookFor(forum, me.id);
    const active = await forum.threads.fetchActive();
    for (const t of active.threads.values()) if (t.parentId === forum.id && posts.some((p) => p.title === t.name)) await t.delete().catch(() => {});
    for (const p of posts) {
      const [first, ...rest] = p.lines;
      const msg = await hook.send({ username: first[0], avatarURL: avatarFor(first[0]), content: first[1], threadName: p.title });
      for (const [who, content] of rest) await hook.send({ username: who, avatarURL: avatarFor(who), content, threadId: msg.channelId });
    }
    console.log(`forum  #${forum.name} (${posts.length} posts)`);
  }
}

async function main() {
  const { client, guild } = await connect();
  try {
    if (guild.id === LIVE) throw new Error("refusing to seed mock chat into the live server");
    await seed(guild);
  } finally {
    await client.destroy();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });
