/**
 * Moves the server onto the language-gated onboarding flow:
 *
 *   @everyone          sees only the language picker
 *   "中文"              (picked a language) sees the free and teaser channels in 中文, plus verify
 *   "中文 Member"       (verified as well) sees the full 中文 channels; verify is gone
 *
 *   npx tsx scripts/onboarding.ts                    # dry run: prints every change
 *   npx tsx scripts/onboarding.ts --apply            # all steps, in order
 *   npx tsx scripts/onboarding.ts --apply --step members
 *
 * Steps run in an order that never takes access away mid-way: roles are made
 * and handed out before any channel starts requiring them, and the picker is
 * opened last. Every step is idempotent, so a failed run is safe to repeat.
 */
import {
  ChannelType,
  OverwriteType,
  PermissionFlagsBits as P,
  type CategoryChannel,
  type Guild,
  type GuildBasedChannel,
  type NonThreadGuildBasedChannel,
  type OverwriteResolvable,
  type TextChannel,
} from "discord.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LANGS, type Lang } from "../src/config.js";
import { Db } from "../src/db/index.js";
import { connect } from "../src/lib/client.js";
import { startHereMessages } from "../src/startHere.js";
import { LANG_ROLE_NAMES } from "../src/roles.js";
import { verifyPanel } from "../src/verify/panel.js";

type Tier =
  | "picker" //    @everyone only; every language role denied
  | "verify" //    language role only: vanishes on verification
  | "teaser" //    language role only, read-only
  | "free" //      both tiers
  | "trader" //    both see it, only members talk
  | "member" //    members only
  | "ops"; //      nobody but staff and the bot

/** What a channel is, the same in every language. */
type Kind =
  | "announcements" | "teaser" | "signals" | "flagship" | "investor" | "daytrade"
  | "lock-flagship" | "lock-investor" | "lock-daytrade" | "lock-crypto" | "lock-stocks" | "lock-commodities"
  | "verify" | "btcgate" | "general" | "trader" | "bitcoin" | "crypto" | "stocks" | "commodities" | "memes" | "help"
  | "start" | "guides" | "strategies" | "forums";

interface Spec {
  name: string;
  /** Category name; null for top level. */
  parent: string | null;
  lang: Lang | "all";
  tier: Tier;
  kind?: Kind;
  readOnly?: boolean;
  type?: "text" | "voice" | "forum";
  topic?: string;
  /** Where this channel lived before the restructure; it is moved from there instead of recreated. */
  legacy?: { name: string; parent: string | null }[];
  panel?: "picker" | "verify" | "bitcoin" | "start" | "locked";
  /** For a lock channel: the name of the channel it stands in for, shown on its Verify panel. */
  topic?: string;
}

/**
 * The one layout every language gets. A member only ever sees their own
 * language's copy:
 *
 *   ANNOUNCEMENTS   server-guide (always on top) · announcements · signals preview · signals
 *   COMMUNITY       verify · locked bitcoin · general · trader-chat · bitcoin · crypto · stocks · commodities · memes · help-desk
 *   REFERENCE       setup-guides · trading-strategies · forums
 *
 * No voice channels: one per language is more rooms than anyone would use.
 */
// Members see the real channel, unverified members see its 🔒 stand-in with the Verify button; each sees one set.
const LAYOUT: { cat: "ann" | "com" | "ref"; kind: Kind; tier: Tier; readOnly?: boolean; type?: "voice" | "forum"; panel?: Spec["panel"]; lockFor?: Kind }[] = [
  { cat: "ann", kind: "start", tier: "free", readOnly: true, panel: "start" },
  { cat: "ann", kind: "announcements", tier: "free", readOnly: true },
  { cat: "ann", kind: "flagship", tier: "member", readOnly: true },
  { cat: "ann", kind: "daytrade", tier: "member", readOnly: true },
  { cat: "ann", kind: "signals", tier: "member", readOnly: true },
  { cat: "ann", kind: "lock-flagship", tier: "teaser", readOnly: true, panel: "locked", lockFor: "flagship" },
  { cat: "ann", kind: "lock-daytrade", tier: "teaser", readOnly: true, panel: "locked", lockFor: "daytrade" },
  { cat: "ann", kind: "teaser", tier: "teaser", readOnly: true },
  { cat: "com", kind: "verify", tier: "verify", readOnly: true, panel: "verify" },
  { cat: "com", kind: "btcgate", tier: "teaser", readOnly: true, panel: "bitcoin" },
  { cat: "com", kind: "lock-crypto", tier: "teaser", readOnly: true, panel: "locked", lockFor: "crypto" },
  { cat: "com", kind: "lock-stocks", tier: "teaser", readOnly: true, panel: "locked", lockFor: "stocks" },
  { cat: "com", kind: "lock-commodities", tier: "teaser", readOnly: true, panel: "locked", lockFor: "commodities" },
  { cat: "com", kind: "general", tier: "member" },
  { cat: "com", kind: "trader", tier: "trader" },
  { cat: "com", kind: "bitcoin", tier: "member" },
  { cat: "com", kind: "crypto", tier: "member" },
  { cat: "com", kind: "stocks", tier: "member" },
  { cat: "com", kind: "commodities", tier: "member" },
  { cat: "com", kind: "memes", tier: "member" },
  { cat: "com", kind: "help", tier: "free" },
  { cat: "ref", kind: "guides", tier: "member", type: "forum" },
  { cat: "ref", kind: "strategies", tier: "member", type: "forum" },
  { cat: "ref", kind: "forums", tier: "member", type: "forum" },
];

const CATS: Record<Lang, Record<"ann" | "com" | "ref", string>> = {
  en: { ann: "📢 ANNOUNCEMENTS", com: "💬 COMMUNITY", ref: "📚 REFERENCE" },
  zh: { ann: "📢 公告", com: "💬 社区", ref: "📚 参考资料" },
  ko: { ann: "📢 공지", com: "💬 커뮤니티", ref: "📚 자료실" },
  id: { ann: "📢 PENGUMUMAN", com: "💬 KOMUNITAS", ref: "📚 REFERENSI" },
  vi: { ann: "📢 THÔNG BÁO", com: "💬 CỘNG ĐỒNG", ref: "📚 TÀI LIỆU" },
  es: { ann: "📢 ANUNCIOS", com: "💬 COMUNIDAD", ref: "📚 REFERENCIA" },
  pt: { ann: "📢 ANÚNCIOS", com: "💬 COMUNIDADE", ref: "📚 REFERÊNCIA" },
  tr: { ann: "📢 DUYURULAR", com: "💬 TOPLULUK", ref: "📚 KAYNAKLAR" },
  ru: { ann: "📢 ОБЪЯВЛЕНИЯ", com: "💬 СООБЩЕСТВО", ref: "📚 СПРАВКА" },
  ja: { ann: "📢 お知らせ", com: "💬 コミュニティ", ref: "📚 資料" },
};

const NAMES: Record<Lang, Record<Kind, string>> = {
  en: { announcements: "📢・announcements", flagship: "🟢🟢・alphanumetrix", investor: "💼・investor-signals", daytrade: "🤖・bot-alerts", "lock-flagship": "", "lock-investor": "", "lock-daytrade": "", "lock-crypto": "", "lock-stocks": "", "lock-commodities": "", teaser: "🔒・trade-alerts", signals: "⚡・trade-alerts", verify: "✅・verify", btcgate: "🔒・bitcoin", general: "💬・general", trader: "📈・trader-chat", bitcoin: "🟠・bitcoin", crypto: "🪙・crypto", stocks: "📊・stocks", commodities: "🛢️・commodities", memes: "🐸・memes", help: "☎️・help-desk", start: "🧭・server-guide", guides: "📕・setup-guides", strategies: "📗・trading-strategies", forums: "🧵・forums" },
  zh: { announcements: "📢・公告", flagship: "🟢🟢・alphanumetrix", investor: "💼・投资信号", daytrade: "🤖・机器人提醒", "lock-flagship": "", "lock-investor": "", "lock-daytrade": "", "lock-crypto": "", "lock-stocks": "", "lock-commodities": "", teaser: "🔒・交易提醒", signals: "⚡・交易提醒", verify: "✅・验证", btcgate: "🔒・比特币", general: "💬・闲聊", trader: "📈・交易者聊天", bitcoin: "🟠・比特币", crypto: "🪙・加密货币", stocks: "📊・股票", commodities: "🛢️・大宗商品", memes: "🐸・表情包", help: "☎️・帮助台", start: "🧭・服务器指南", guides: "📕・设置指南", strategies: "📗・交易策略", forums: "🧵・论坛" },
  ko: { announcements: "📢・공지사항", flagship: "🟢🟢・alphanumetrix", investor: "💼・투자-신호", daytrade: "🤖・봇-알림", "lock-flagship": "", "lock-investor": "", "lock-daytrade": "", "lock-crypto": "", "lock-stocks": "", "lock-commodities": "", teaser: "🔒・매매신호", signals: "⚡・매매신호", verify: "✅・인증", btcgate: "🔒・비트코인", general: "💬・자유채팅", trader: "📈・트레이더-채팅", bitcoin: "🟠・비트코인", crypto: "🪙・코인", stocks: "📊・주식", commodities: "🛢️・원자재", memes: "🐸・밈", help: "☎️・도움말", start: "🧭・서버-가이드", guides: "📕・설정-가이드", strategies: "📗・매매-전략", forums: "🧵・포럼" },
  id: { announcements: "📢・pengumuman", flagship: "🟢🟢・alphanumetrix", investor: "💼・sinyal-investor", daytrade: "🤖・alert-bot", "lock-flagship": "", "lock-investor": "", "lock-daytrade": "", "lock-crypto": "", "lock-stocks": "", "lock-commodities": "", teaser: "🔒・sinyal-trading", signals: "⚡・sinyal-trading", verify: "✅・verifikasi", btcgate: "🔒・bitcoin", general: "💬・obrolan-umum", trader: "📈・obrolan-trader", bitcoin: "🟠・bitcoin", crypto: "🪙・kripto", stocks: "📊・saham", commodities: "🛢️・komoditas", memes: "🐸・meme", help: "☎️・bantuan", start: "🧭・panduan-server", guides: "📕・panduan-setup", strategies: "📗・strategi-trading", forums: "🧵・forum" },
  vi: { announcements: "📢・thông-báo", flagship: "🟢🟢・alphanumetrix", investor: "💼・tín-hiệu-đầu-tư", daytrade: "🤖・cảnh-báo-bot", "lock-flagship": "", "lock-investor": "", "lock-daytrade": "", "lock-crypto": "", "lock-stocks": "", "lock-commodities": "", teaser: "🔒・tín-hiệu", signals: "⚡・tín-hiệu", verify: "✅・xác-minh", btcgate: "🔒・bitcoin", general: "💬・tán-gẫu", trader: "📈・trò-chuyện-trader", bitcoin: "🟠・bitcoin", crypto: "🪙・crypto", stocks: "📊・cổ-phiếu", commodities: "🛢️・hàng-hóa", memes: "🐸・meme", help: "☎️・hỗ-trợ", start: "🧭・hướng-dẫn-server", guides: "📕・hướng-dẫn", strategies: "📗・chiến-lược", forums: "🧵・diễn-đàn" },
  es: { announcements: "📢・anuncios", flagship: "🟢🟢・alphanumetrix", investor: "💼・señales-inversión", daytrade: "🤖・alertas-bot", "lock-flagship": "", "lock-investor": "", "lock-daytrade": "", "lock-crypto": "", "lock-stocks": "", "lock-commodities": "", teaser: "🔒・alertas", signals: "⚡・alertas", verify: "✅・verificar", btcgate: "🔒・bitcoin", general: "💬・general", trader: "📈・chat-traders", bitcoin: "🟠・bitcoin", crypto: "🪙・cripto", stocks: "📊・acciones", commodities: "🛢️・materias-primas", memes: "🐸・memes", help: "☎️・ayuda", start: "🧭・guía-del-servidor", guides: "📕・guías", strategies: "📗・estrategias", forums: "🧵・foros" },
  pt: { announcements: "📢・anúncios", flagship: "🟢🟢・alphanumetrix", investor: "💼・sinais-investimento", daytrade: "🤖・alertas-bot", "lock-flagship": "", "lock-investor": "", "lock-daytrade": "", "lock-crypto": "", "lock-stocks": "", "lock-commodities": "", teaser: "🔒・alertas", signals: "⚡・alertas", verify: "✅・verificar", btcgate: "🔒・bitcoin", general: "💬・geral", trader: "📈・chat-traders", bitcoin: "🟠・bitcoin", crypto: "🪙・cripto", stocks: "📊・ações", commodities: "🛢️・commodities", memes: "🐸・memes", help: "☎️・ajuda", start: "🧭・guia-do-servidor", guides: "📕・guias", strategies: "📗・estratégias", forums: "🧵・fóruns" },
  tr: { announcements: "📢・duyurular", flagship: "🟢🟢・alphanumetrix", investor: "💼・yatırım-sinyalleri", daytrade: "🤖・bot-uyarıları", "lock-flagship": "", "lock-investor": "", "lock-daytrade": "", "lock-crypto": "", "lock-stocks": "", "lock-commodities": "", teaser: "🔒・sinyaller", signals: "⚡・sinyaller", verify: "✅・doğrulama", btcgate: "🔒・bitcoin", general: "💬・sohbet", trader: "📈・trader-sohbet", bitcoin: "🟠・bitcoin", crypto: "🪙・kripto", stocks: "📊・hisseler", commodities: "🛢️・emtia", memes: "🐸・mizah", help: "☎️・yardım", start: "🧭・sunucu-rehberi", guides: "📕・kurulum-rehberi", strategies: "📗・stratejiler", forums: "🧵・forum" },
  ru: { announcements: "📢・объявления", flagship: "🟢🟢・alphanumetrix", investor: "💼・инвест-сигналы", daytrade: "🤖・алерты-бота", "lock-flagship": "", "lock-investor": "", "lock-daytrade": "", "lock-crypto": "", "lock-stocks": "", "lock-commodities": "", teaser: "🔒・сигналы", signals: "⚡・сигналы", verify: "✅・верификация", btcgate: "🔒・биткоин", general: "💬・общий-чат", trader: "📈・чат-трейдеров", bitcoin: "🟠・биткоин", crypto: "🪙・крипта", stocks: "📊・акции", commodities: "🛢️・сырьё", memes: "🐸・мемы", help: "☎️・помощь", start: "🧭・гид-по-серверу", guides: "📕・гайды", strategies: "📗・стратегии", forums: "🧵・форум" },
  ja: { announcements: "📢・お知らせ", flagship: "🟢🟢・alphanumetrix", investor: "💼・投資シグナル", daytrade: "🤖・ボットアラート", "lock-flagship": "", "lock-investor": "", "lock-daytrade": "", "lock-crypto": "", "lock-stocks": "", "lock-commodities": "", teaser: "🔒・シグナル", signals: "⚡・シグナル", verify: "✅・認証", btcgate: "🔒・ビットコイン", general: "💬・雑談", trader: "📈・トレーダー-チャット", bitcoin: "🟠・ビットコイン", crypto: "🪙・暗号資産", stocks: "📊・株式", commodities: "🛢️・コモディティ", memes: "🐸・ミーム", help: "☎️・ヘルプ", start: "🧭・サーバーガイド", guides: "📕・設定ガイド", strategies: "📗・トレード戦略", forums: "🧵・フォーラム" },
};

/** Names the bot-alerts channel had as day-trade signals, so the migration renames instead of recreating. */
const DAYTRADE_OLD: Record<Lang, string> = {"en": "⏱️・day-trade-signals", "zh": "⏱️・日内交易信号", "ko": "⏱️・단타-신호", "id": "⏱️・sinyal-day-trade", "vi": "⏱️・tín-hiệu-lướt-sóng", "es": "⏱️・señales-day-trading", "pt": "⏱️・sinais-day-trade", "tr": "⏱️・günlük-işlem-sinyalleri", "ru": "⏱️・интрадей-сигналы", "ja": "⏱️・デイトレシグナル"};

// A lock channel is the real channel's name behind a 🔒.
const bare = (name: string) => name.split("・").slice(1).join("・");
for (const lang of LANGS) for (const l of LAYOUT) if (l.lockFor) NAMES[lang][l.kind] = `🔒・${bare(NAMES[lang][l.lockFor])}`;

/** The flagship channel's icon follows the AlphanumetriX indicator: /flagship sets it. */
export { ICONS as FLAGSHIP_STATES } from "../src/flagship.js";

/** Categories before the restructure. Channels found in them are moved, not recreated; emptied ones are deleted. */
const OLD_CATS = {
  alerts: "╭───  Alerts  ───╮",
  chat: "╭───  Chat Rooms  ───╮",
  edu: "╭─── Education ───╮",
  zh: "╭───  中文  ───╮",
  ko: "╭───  한국어  ───╮",
  id: "╭───  Bahasa Indonesia  ───╮",
  vi: "╭───  Tiếng Việt  ───╮",
  es: "╭───  Español  ───╮",
  pt: "╭───  Português  ───╮",
  tr: "╭───  Türkçe  ───╮",
  ru: "╭───  Русский  ───╮",
  ja: "╭───  日本語  ───╮",
} as const;

/** Where the English channels lived. */
const EN_OLD: Partial<Record<Kind, string | null>> = {
  announcements: null, teaser: OLD_CATS.alerts, signals: OLD_CATS.alerts, verify: null,
  btcgate: OLD_CATS.chat, general: OLD_CATS.chat, trader: OLD_CATS.chat, bitcoin: OLD_CATS.chat, memes: OLD_CATS.chat,
  help: OLD_CATS.chat, start: null, guides: OLD_CATS.edu, strategies: OLD_CATS.edu, forums: OLD_CATS.chat,
};

/** Kinds whose chat the bot mirrors and translates, keyed to their mirror group (names match the live server's groups). */
const MIRROR_GROUP: Partial<Record<Kind, string>> = {
  announcements: "announcements", teaser: "trade-alerts-teaser", signals: "trade-alerts",
  general: "general", trader: "trader-chat", bitcoin: "bitcoin", help: "help-desk", memes: "memes",
  guides: "setup-guides", strategies: "trading-strategies", forums: "forums",
  crypto: "crypto", stocks: "stocks", commodities: "commodities",
  flagship: "alphanumetrix", daytrade: "bot-alerts",
};

const PICKER: Spec = { name: "🌐・choose-language", parent: null, lang: "all", tier: "picker", readOnly: true, topic: "Pick your language to enter", panel: "picker" };

const SPECS: Spec[] = [PICKER, { name: "verify-preview", parent: null, lang: "all", tier: "ops" }];
for (const lang of LANGS) {
  for (const l of LAYOUT) {
    const name = NAMES[lang][l.kind];
    const legacy = lang === "en"
      ? [{ name, parent: EN_OLD[l.kind] ?? null }, ...(l.kind === "start" ? [{ name: "📍・start-here", parent: null }] : [])]
      : [{ name, parent: OLD_CATS[lang as Exclude<Lang, "en">] }];
    if (l.kind === "daytrade" || l.kind === "lock-daytrade") {
      const was = l.kind === "daytrade" ? DAYTRADE_OLD[lang] : `🔒・${bare(DAYTRADE_OLD[lang])}`;
      legacy.push({ name: was, parent: CATS[lang][l.cat] });
    }
    const topic = l.lockFor ? bare(NAMES[lang][l.lockFor]) : undefined;
    SPECS.push({ name, parent: CATS[lang][l.cat], lang, tier: l.tier, kind: l.kind, readOnly: l.readOnly, type: l.type, panel: l.panel, topic, legacy });
  }
}

const CATEGORY_SPECS: { name: string; lang: Lang; tier: Tier }[] = LANGS.flatMap((lang) => [
  { name: CATS[lang].ann, lang, tier: "free" as Tier },
  { name: CATS[lang].com, lang, tier: "free" as Tier },
  { name: CATS[lang].ref, lang, tier: "free" as Tier },
]);

/**
 * Roles whose ViewChannel the new tiers replace on the channels above. Their
 * other bits (a mute's send deny, say) are kept. Staff and bot roles are not
 * listed and keep their overwrites untouched.
 */
const REPLACED_ROLE_NAMES = ["Member", "Members", "New Member", "Muted Member"];

const BOT_ALLOW = [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.ManageMessages, P.ManageWebhooks, P.EmbedLinks, P.AttachFiles];

const TRANSLATE_PNG = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "emoji", "translate.png");

const STEPS = ["roles", "members", "channels", "perms", "mirror", "panels", "rules", "vip", "cleanup"] as const;
type Step = (typeof STEPS)[number];

interface Ctx {
  guild: Guild;
  db: Db;
  apply: boolean;
  role: (lang: Lang, tier: "base" | "member") => string | undefined;
}

const log = (s: string) => console.log(s);

/** Channel names compare equal across the flagship's state emoji, which /flagship changes. */
const STATE = /^[🟢🟡🔴]{1,2}・/u;
const sameName = (a: string, b: string) => a === b || (STATE.test(a) && STATE.test(b) && a.replace(STATE, "") === b.replace(STATE, ""));

function findChannel(guild: Guild, spec: { name: string; parent: string | null }) {
  const parentId = spec.parent ? guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name === spec.parent)?.id ?? "missing" : null;
  return guild.channels.cache.find(
    (c): c is NonThreadGuildBasedChannel => !c.isThread() && c.type !== ChannelType.GuildCategory && sameName(c.name, spec.name) && (c.parentId ?? null) === parentId,
  );
}

async function stepRoles(ctx: Ctx) {
  const { guild } = ctx;
  for (const lang of LANGS) {
    for (const tier of ["base", "member"] as const) {
      const name = LANG_ROLE_NAMES[lang][tier];
      let role = guild.roles.cache.find((r) => r.name === name);
      if (!role) {
        log(`  create role ${name}`);
        if (ctx.apply) role = await guild.roles.create({ name, mentionable: false, permissions: [], reason: "onboarding: language tiers" });
      }
      if (role && ctx.apply) await ctx.db.setSetting(guild.id, `${tier === "base" ? "role" : "mrole"}:${lang}`, role.id);
    }
  }
}

/**
 * Everyone already here gets a language so nobody is locked out: whoever holds
 * an old language role keeps that language, everyone else gets English, and
 * membership decides the tier.
 */
async function stepMembers(ctx: Ctx) {
  const { guild } = ctx;
  const memberNames = ["member", "members"];
  const memberRoleIds = new Set(guild.roles.cache.filter((r) => memberNames.includes(r.name.toLowerCase())).map((r) => r.id));
  const all = await guild.members.fetch();
  const counts = new Map<string, number>();
  let changed = 0;
  for (const m of all.values()) {
    if (m.user.bot) continue;
    const lang: Lang = (["zh", "ko", "id"] as const).find((l) => {
      const p = [ctx.role(l, "base"), ctx.role(l, "member")];
      return p.some((id) => id && m.roles.cache.has(id));
    }) ?? "en";
    const tier = m.roles.cache.some((r) => memberRoleIds.has(r.id)) ? "member" : "base";
    const want = ctx.role(lang, tier);
    const key = LANG_ROLE_NAMES[lang][tier];
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (!want || want.startsWith("pending:")) { if (!m.roles.cache.has(want ?? "")) changed++; continue; } // dry run before roles exist
    const all8 = LANGS.flatMap((l) => [ctx.role(l, "base"), ctx.role(l, "member")]).filter((x): x is string => !!x);
    const remove = all8.filter((id) => id !== want && m.roles.cache.has(id));
    if (m.roles.cache.has(want) && remove.length === 0) continue;
    changed++;
    if (ctx.apply) {
      if (!m.roles.cache.has(want)) await m.roles.add(want, "onboarding: existing member keeps access");
      if (remove.length) await m.roles.remove(remove, "onboarding: one language tier");
      if (changed % 50 === 0) log(`  ...${changed} members updated`);
    }
  }
  log(`  ${all.filter((m) => !m.user.bot).size} people: ${[...counts].map(([k, v]) => `${k} ${v}`).join(", ")}`);
  log(`  ${changed} need a role change`);
}

const TYPE = { text: ChannelType.GuildText, voice: ChannelType.GuildVoice, forum: ChannelType.GuildForum } as const;

function findCategory(guild: Guild, name: string) {
  return guild.channels.cache.find((c): c is CategoryChannel => c.type === ChannelType.GuildCategory && c.name === name);
}

/**
 * The channel for a spec: already in place, in another of its language's
 * categories (the layout moved it), or still where it lived before the restructure.
 */
function locate(guild: Guild, s: Spec) {
  const siblings = s.lang === "all" ? [] : Object.values(CATS[s.lang]).map((parent) => ({ name: s.name, parent }));
  return findChannel(guild, s) ?? [...siblings, ...(s.legacy ?? [])].map((l) => findChannel(guild, l)).find(Boolean);
}

async function stepChannels(ctx: Ctx) {
  const { guild } = ctx;
  const me = guild.members.me ?? (await guild.members.fetchMe());
  for (const c of CATEGORY_SPECS) {
    if (findCategory(guild, c.name)) continue;
    log(`  create category ${c.name}`);
    if (ctx.apply) await guild.channels.create({ name: c.name, type: ChannelType.GuildCategory, permissionOverwrites: [{ id: guild.roles.everyone.id, deny: [P.ViewChannel] }], reason: "onboarding" });
  }
  if (ctx.apply) await guild.channels.fetch();

  for (const s of SPECS) {
    if (s.tier === "ops") continue;
    const parent = s.parent ? findCategory(guild, s.parent) : undefined;
    const existing = locate(guild, s);
    if (existing) {
      if (!sameName(existing.name, s.name) || (existing.name !== s.name && !STATE.test(s.name))) {
        log(`  rename #${existing.name} → #${s.name}`);
        if (ctx.apply) await existing.setName(s.name, "onboarding: one layout per language");
      }
      if ((existing.parentId ?? null) !== (parent?.id ?? null)) {
        log(`  move #${existing.name} → ${s.parent ?? "top"}`);
        if (ctx.apply) await existing.setParent(parent?.id ?? null, { lockPermissions: false, reason: "onboarding: one layout per language" });
      }
      continue;
    }
    log(`  create ${s.type ?? "text"} #${s.name} in ${s.parent ?? "top"}`);
    if (!ctx.apply) continue;
    // Born hidden; the perms step opens it to the right tier.
    await guild.channels.create({
      name: s.name,
      type: TYPE[s.type ?? "text"] as ChannelType.GuildText,
      parent: parent?.id,
      topic: s.type === "voice" ? undefined : s.topic,
      permissionOverwrites: [
        { id: guild.roles.everyone.id, deny: [P.ViewChannel] },
        { id: me.id, type: OverwriteType.Member, allow: BOT_ALLOW },
      ],
      reason: "onboarding",
    });
  }
  if (!ctx.apply) return;
  await guild.channels.fetch();

  // Order: picker on top, then each language's three categories, channels in layout order.
  const positions: { channel: string; position: number }[] = [];
  const picker = findChannel(guild, PICKER);
  if (picker) positions.push({ channel: picker.id, position: 0 });
  CATEGORY_SPECS.forEach((c, i) => {
    const cat = findCategory(guild, c.name);
    if (cat) positions.push({ channel: cat.id, position: i + 1 });
  });
  for (const c of CATEGORY_SPECS) {
    SPECS.filter((s) => s.parent === c.name).forEach((s, i) => {
      const ch = findChannel(guild, s);
      if (ch) positions.push({ channel: ch.id, position: i });
    });
  }
  await guild.channels.setPositions(positions);
}

const VIP_CAT = "👑 VIP";
const VIP_ROLES = ["VIPs", "VIP 1", "VIP 2", "VIP 3", "VIP 4"];

/**
 * The VIP lounge sits right under the picker, shared by every language: the
 * legacy VIPs role and the commission tiers VIP 1-4 see it, staff keep their
 * access. The weekly report goes to an admin-only channel, because it lists
 * what we earn per client.
 */
async function stepVip(ctx: Ctx) {
  const { guild, db } = ctx;
  const me = guild.members.me!;
  for (const name of VIP_ROLES.slice(1)) {
    if (guild.roles.cache.some((r) => r.name === name)) continue;
    log(`  create role ${name}`);
    if (ctx.apply) await guild.roles.create({ name, permissions: [], reason: "VIP tiers" });
  }
  let cat = findCategory(guild, VIP_CAT);
  if (!cat) {
    log(`  create category ${VIP_CAT}`);
    if (ctx.apply) cat = await guild.channels.create({ name: VIP_CAT, type: ChannelType.GuildCategory, reason: "VIP lounge" });
  }
  const vipRoleIds = VIP_ROLES.map((n) => guild.roles.cache.find((r) => r.name === n)?.id).filter((x): x is string => !!x);
  const lounge: OverwriteResolvable[] = [
    { id: guild.roles.everyone.id, deny: [P.ViewChannel] },
    ...vipRoleIds.map((id) => ({ id, allow: [P.ViewChannel] })),
    ...["Moderators", "Team - Will Not DM"].map((n) => guild.roles.cache.find((r) => r.name === n)).filter((r) => !!r).map((r) => ({ id: r!.id, allow: [P.ViewChannel] })),
  ];
  if (cat && ctx.apply) await cat.permissionOverwrites.set(lounge, "VIP lounge");

  let chat = guild.channels.cache.find((c): c is TextChannel => c.type === ChannelType.GuildText && c.name === "👑・vip-chat");
  if (!chat) {
    log("  create #👑・vip-chat");
    if (ctx.apply && cat) chat = await guild.channels.create({ name: "👑・vip-chat", type: ChannelType.GuildText, parent: cat.id, topic: "For our VIPs", reason: "VIP lounge" });
  } else if (cat && chat.parentId !== cat.id) {
    log(`  move #${chat.name} → ${VIP_CAT}`);
    if (ctx.apply) await chat.setParent(cat.id, { lockPermissions: false, reason: "VIP lounge" });
  }
  if (chat && ctx.apply) {
    // Keep its own overwrites (muted and booster denies), add every VIP tier.
    for (const id of vipRoleIds) await chat.permissionOverwrites.edit(id, { ViewChannel: true }, { reason: "VIP tiers" });
    await chat.permissionOverwrites.edit(guild.roles.everyone.id, { ViewChannel: false }, { reason: "VIP lounge" });
    await chat.permissionOverwrites.edit(me.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true }, { reason: "VIP lounge" });
  }

  let report = guild.channels.cache.find((c): c is TextChannel => c.type === ChannelType.GuildText && c.name === "📊・vip-report");
  if (!report) {
    log("  create #📊・vip-report (admins only)");
    if (ctx.apply) report = await guild.channels.create({
      name: "📊・vip-report", type: ChannelType.GuildText, topic: "Weekly commission per client and VIP tier changes. Admins only.",
      permissionOverwrites: [{ id: guild.roles.everyone.id, deny: [P.ViewChannel] }, { id: me.id, type: OverwriteType.Member, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.EmbedLinks] }],
      reason: "VIP report",
    });
  }
  if (report && ctx.apply) await db.setSetting(guild.id, "vip_report_channel", report.id);

  if (ctx.apply && cat) {
    await guild.channels.fetch();
    const picker = findChannel(guild, PICKER);
    const order = [picker?.id, cat.id, ...CATEGORY_SPECS.map((c) => findCategory(guild, c.name)?.id)].filter((x): x is string => !!x);
    await guild.channels.setPositions(order.map((channel, position) => ({ channel, position })));
  }
}

/** Old categories the restructure emptied. Anything still holding a channel (vip-chat, mod-chat) stays. */
async function stepCleanup(ctx: Ctx) {
  const { guild } = ctx;
  for (const v of guild.channels.cache.filter((c) => c.type === ChannelType.GuildVoice && c.name === "🎙・Meeting Room").values()) {
    log(`  delete voice #${v.name} (no voice rooms in the per-language layout)`);
    if (ctx.apply) await v.delete("onboarding: no voice channels");
  }
  for (const name of Object.values(OLD_CATS)) {
    const cat = findCategory(guild, name);
    if (!cat) continue;
    const left = guild.channels.cache.filter((c) => c.parentId === cat.id);
    if (left.size) { log(`  keep ${name} (still holds ${left.map((c) => "#" + c.name).join(", ")})`); continue; }
    log(`  delete empty category ${name}`);
    if (ctx.apply) await cat.delete("onboarding: replaced by the per-language layout");
  }
}

/** The overwrites a channel ends up with: its staff overwrites kept, the tier's language roles laid on top. */
function overwritesFor(ctx: Ctx, ch: NonThreadGuildBasedChannel | CategoryChannel, lang: Lang | "all", tier: Tier, readOnly: boolean): OverwriteResolvable[] {
  const { guild } = ctx;
  const me = guild.members.me!;
  const langRoleIds = new Set(LANGS.flatMap((l) => [ctx.role(l, "base"), ctx.role(l, "member")]).filter((x): x is string => !!x));
  const replaced = new Set(guild.roles.cache.filter((r) => REPLACED_ROLE_NAMES.includes(r.name)).map((r) => r.id));
  const out = new Map<string, { id: string; type: OverwriteType; allow: bigint; deny: bigint }>();

  for (const o of ch.permissionOverwrites.cache.values()) {
    if (langRoleIds.has(o.id)) continue;
    let allow = o.allow.bitfield, deny = o.deny.bitfield;
    if (replaced.has(o.id) || o.id === guild.roles.everyone.id) {
      allow &= ~P.ViewChannel;
      deny &= ~P.ViewChannel;
      if (allow === 0n && deny === 0n) continue;
    }
    out.set(o.id, { id: o.id, type: o.type, allow, deny });
  }
  const set = (id: string, type: OverwriteType, allow: bigint, deny: bigint) => {
    const cur = out.get(id) ?? { id, type, allow: 0n, deny: 0n };
    cur.allow = (cur.allow | allow) & ~deny;
    cur.deny = (cur.deny | deny) & ~allow;
    out.set(id, cur);
  };
  const role = (l: Lang, t: "base" | "member") => ctx.role(l, t);
  const langs: Lang[] = lang === "all" ? [...LANGS] : [lang];
  const everyone = guild.roles.everyone.id;

  if (tier === "picker") {
    set(everyone, OverwriteType.Role, P.ViewChannel | P.ReadMessageHistory, 0n);
    for (const id of langRoleIds) set(id, OverwriteType.Role, 0n, P.ViewChannel);
  } else {
    set(everyone, OverwriteType.Role, 0n, P.ViewChannel);
    for (const l of langs) {
      const base = role(l, "base"), member = role(l, "member");
      if (tier === "verify" || tier === "teaser") base && set(base, OverwriteType.Role, P.ViewChannel, 0n);
      if (tier === "free") {
        base && set(base, OverwriteType.Role, P.ViewChannel, 0n);
        member && set(member, OverwriteType.Role, P.ViewChannel, 0n);
      }
      if (tier === "trader") {
        base && set(base, OverwriteType.Role, P.ViewChannel, P.SendMessages | P.SendMessagesInThreads | P.CreatePublicThreads | P.AddReactions);
        member && set(member, OverwriteType.Role, P.ViewChannel, 0n);
      }
      if (tier === "member") member && set(member, OverwriteType.Role, P.ViewChannel, 0n);
    }
  }
  if (readOnly) set(everyone, OverwriteType.Role, 0n, P.SendMessages);
  if (ch.type !== ChannelType.GuildCategory) set(me.id, OverwriteType.Member, BOT_ALLOW.reduce((a, b) => a | b, 0n), 0n);
  return [...out.values()].map((o) => ({ id: o.id, type: o.type, allow: o.allow, deny: o.deny }));
}

function describe(guild: Guild, ows: OverwriteResolvable[]) {
  return ows
    .map((o) => {
      const id = String(o.id);
      const name = id.startsWith("pending:") ? id.slice(8) : id === guild.roles.everyone.id ? "@everyone" : guild.roles.cache.get(id)?.name ?? (id === guild.members.me?.id ? "bot" : `user ${id}`);
      const a = BigInt((o.allow as bigint) ?? 0n), d = BigInt((o.deny as bigint) ?? 0n);
      const v = a & P.ViewChannel ? "+view" : d & P.ViewChannel ? "-view" : "";
      const s = d & P.SendMessages ? " -send" : "";
      return v || s ? `${name}${v ? " " + v : ""}${s}` : null;
    })
    .filter(Boolean)
    .join(", ");
}

async function stepPerms(ctx: Ctx) {
  const { guild } = ctx;
  for (const c of CATEGORY_SPECS) {
    const cat = guild.channels.cache.find((x): x is CategoryChannel => x.type === ChannelType.GuildCategory && x.name === c.name);
    if (!cat) { log(`  ! missing category ${c.name}`); continue; }
    const ows = overwritesFor(ctx, cat, c.lang, c.tier, false);
    log(`  [${c.name}] ${describe(guild, ows)}`);
    if (ctx.apply) await cat.permissionOverwrites.set(ows, "onboarding: language tiers");
  }
  // The picker goes last: it only opens once every other channel is gated.
  for (const s of [...SPECS.slice(1), PICKER]) {
    const ch = findChannel(guild, s);
    if (!ch) { log(`  ! skip #${s.name} (missing)`); continue; }
    const ows = overwritesFor(ctx, ch, s.lang, s.tier, !!s.readOnly);
    log(`  #${s.name} [${s.tier}] ${describe(guild, ows)}`);
    if (ctx.apply) await ch.permissionOverwrites.set(ows, "onboarding: language tiers");
  }
}

async function stepMirror(ctx: Ctx) {
  const { guild, db } = ctx;
  // Channels already in a group keep their row: re-upserting would wipe the webhook the mirror posts through.
  const linked = new Set((await db.loadGroups(guild.id)).flatMap((g) => g.members.map((m) => m.channel_id)));
  const link = async (channelId: string, groupId: string, lang: Lang) => {
    if (linked.has(channelId)) return;
    await db.upsertMember({ channel_id: channelId, group_id: groupId, lang, webhook_id: null, webhook_token: null });
    linked.add(channelId);
  };
  for (const s of SPECS) {
    const group = s.kind && MIRROR_GROUP[s.kind];
    if (!group || s.lang === "en" || s.lang === "all") continue;
    const ch = findChannel(guild, s);
    const sourceSpec = SPECS.find((x) => x.lang === "en" && x.kind === s.kind)!;
    const source = findChannel(guild, sourceSpec);
    if (!ch || !source) { log(`  ! cannot link #${s.name} (${!ch ? "channel" : "source"} missing)`); continue; }
    if (linked.has(ch.id)) continue;
    log(`  link #${s.name} (${s.lang}) ← #${source.name} in ${group}`);
    if (!ctx.apply) continue;
    const groupId = (await db.findGroupByName(guild.id, group)) ?? (await db.createGroup(guild.id, group));
    await link(source.id, groupId, "en");
    await link(ch.id, groupId, s.lang);
  }
}

async function stepPanels(ctx: Ctx) {
  const { guild } = ctx;
  const me = guild.members.me!;
  const emojis = await guild.emojis.fetch();
  let tr = emojis.find((e) => e.name === "translate");
  for (const s of SPECS.filter((x) => x.panel)) {
    const ch = findChannel(guild, s) as TextChannel | undefined;
    if (!ch) { log(`  ! no #${s.name} for its panel`); continue; }
    log(`  post ${s.panel} panel in #${s.name}`);
    if (!ctx.apply) continue;
    const old = (await ch.messages.fetch({ limit: 50 })).filter((m) => m.author.id === me.id);
    for (const m of old.values()) await m.delete().catch(() => {});
    const lang: Lang = s.lang === "all" ? "en" : s.lang;
    const help = findChannel(guild, SPECS.find((x) => x.lang === lang && x.kind === "help")!);
    const helpDeskUrl = `https://discord.com/channels/${guild.id}/${help?.id ?? ""}`;
    if (s.panel === "picker") {
      if (!tr) tr = await guild.emojis.create({ attachment: TRANSLATE_PNG, name: "translate", reason: "onboarding: language picker icon" });
      for (const msg of startHereMessages({ picker: true, translateEmoji: tr.toString(), helpDeskUrl })) await ch.send(msg);
    } else if (s.panel === "locked") {
      await ch.send(verifyPanel(lang, "locked", s.topic));
    } else if (s.panel === "start") {
      for (const msg of startHereMessages({ helpDeskUrl, lang })) await ch.send(msg);
    } else await ch.send(verifyPanel(lang, s.panel));
  }
}

/**
 * Community servers must name a rules channel, and Discord shows it to
 * everyone, member list and all. The picker already carries the rules, so it
 * becomes the rules channel and the old one is hidden from everyone but staff.
 */
async function stepRules(ctx: Ctx) {
  const { guild } = ctx;
  if (!guild.features.includes("COMMUNITY")) { log("  not a Community server, nothing to do"); return; }
  const picker = findChannel(guild, PICKER);
  if (!picker) { log("  ! picker channel missing"); return; }
  const old = guild.rulesChannelId && guild.rulesChannelId !== picker.id ? guild.channels.cache.get(guild.rulesChannelId) : undefined;
  if (guild.rulesChannelId !== picker.id) {
    log(`  rules channel: #${old?.name ?? "none"} → #${picker.name}`);
    if (ctx.apply) {
      const after = await guild.setRulesChannel(picker.id, "onboarding: the picker carries the rules");
      // Discord answers 200 and keeps the old channel when the new one is hidden from some members,
      // which the picker is by design. Then the old channel stays the rules channel, hidden below.
      if (after.rulesChannelId !== picker.id) log(`  ! Discord kept #${old?.name} as the rules channel (the picker is hidden from members who picked a language)`);
    }
  }
  if (old && "permissionOverwrites" in old) {
    const everyone = old.permissionOverwrites.cache.get(guild.roles.everyone.id);
    if (!everyone?.deny.has(P.ViewChannel) || old.permissionOverwrites.cache.some((o) => o.id !== guild.roles.everyone.id && o.allow.has(P.ViewChannel))) {
      log(`  hide #${old.name} from everyone but staff`);
      if (ctx.apply) await old.permissionOverwrites.set([{ id: guild.roles.everyone.id, deny: [P.ViewChannel] }], "onboarding: rules live in the picker now");
    }
  }
}

/** What each tier can see, computed by Discord from the overwrites, not from what we meant to write. */
async function audit(ctx: Ctx) {
  const { guild } = ctx;
  await guild.channels.fetch();
  const visible = (roleId: string) =>
    guild.channels.cache
      .filter((c): c is NonThreadGuildBasedChannel => !c.isThread() && c.type !== ChannelType.GuildCategory)
      .filter((c) => {
        // @everyone's permissions plus this role's, the way Discord resolves a member holding just the two
        const ow = c.permissionOverwrites.cache;
        const e = ow.get(guild.roles.everyone.id), r = roleId === guild.roles.everyone.id ? undefined : ow.get(roleId);
        let view = guild.roles.everyone.permissions.has(P.ViewChannel);
        if (e?.deny.has(P.ViewChannel)) view = false;
        if (e?.allow.has(P.ViewChannel)) view = true;
        if (r?.deny.has(P.ViewChannel)) view = false;
        if (r?.allow.has(P.ViewChannel)) view = true;
        return view;
      })
      .map((c: GuildBasedChannel) => `#${c.name}`);
  log(`\n  @everyone only → ${visible(guild.roles.everyone.id).join(" ") || "(nothing)"}`);
  for (const l of LANGS) {
    for (const t of ["base", "member"] as const) {
      const id = ctx.role(l, t);
      if (id) log(`  ${LANG_ROLE_NAMES[l][t]} → ${visible(id).join(" ")}`);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const only = args.includes("--step") ? (args[args.indexOf("--step") + 1] as Step) : null;
  if (only && !STEPS.includes(only)) throw new Error(`--step must be one of ${STEPS.join(", ")}`);
  const { client, guild } = await connect();
  const db = new Db();
  const ctx: Ctx = {
    guild,
    db,
    apply,
    // In a dry run, roles the run would create stand in as "pending:<name>" so the plan still shows them.
    role: (lang, tier) => guild.roles.cache.find((r) => r.name === LANG_ROLE_NAMES[lang][tier])?.id ?? (apply ? undefined : `pending:${LANG_ROLE_NAMES[lang][tier]}`),
  };
  try {
    log(apply ? "APPLYING" : "DRY RUN (add --apply to make these changes)");
    const run: Record<Step, (c: Ctx) => Promise<void>> = { roles: stepRoles, members: stepMembers, channels: stepChannels, perms: stepPerms, mirror: stepMirror, panels: stepPanels, rules: stepRules, vip: stepVip, cleanup: stepCleanup };
    for (const step of STEPS) {
      if (only && step !== only) continue;
      log(`\n== ${step}`);
      await run[step](ctx);
      if (apply) await guild.roles.fetch();
    }
    if (apply && (!only || only === "perms" || only === "rules")) await audit(ctx);
  } finally {
    await client.destroy();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });
