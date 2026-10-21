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
  type Message,
} from "discord.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LANGS, type Lang } from "../src/config.js";
import { Db } from "../src/db/index.js";
import { connect } from "../src/lib/client.js";
import { startHereMessages } from "../src/startHere.js";
import { NOTIFY_ROLES, NOTIFY_TOPICS } from "../src/notify.js";
import { guideChannelName } from "../src/i18n/guide.js";
import { LANG_ROLE_NAMES } from "../src/roles.js";
import { verifyPanel } from "../src/verify/panel.js";
import { supportPanel } from "../src/support/desk.js";

type Tier =
  | "picker" //    @everyone only; every language role denied
  | "verify" //    language role only: vanishes on verification
  | "teaser" //    language role only, read-only
  | "free" //      both tiers
  | "trader" //    both see it, only members talk
  | "help" //      both see it; nobody talks in the channel, everyone writes in their own help thread with links and screenshots
  | "member" //    members only
  | "ops"; //      nobody but staff and the bot

/** What a channel is, the same in every language. */
type Kind =
  | "announcements" | "teaser" | "signals" | "flagship" | "investor" | "daytrade"
  | "lock-flagship" | "lock-investor" | "lock-daytrade" | "lock-crypto" | "lock-stocks" | "lock-commodities"
  | "verify" | "btcgate" | "tradegate" | "general" | "trader" | "bitcoin" | "crypto" | "stocks" | "commodities" | "memes" | "help"
  | "start" | "guides" | "strategies" | "forums" | "academy";

interface Spec {
  name: string;
  /** Category name; null for top level. */
  parent: string | null;
  lang: Lang | "all";
  tier: Tier;
  kind?: Kind;
  readOnly?: boolean;
  /** Members see only messages sent while they're there, not the backlog. */
  noHistory?: boolean;
  type?: "text" | "voice" | "forum";
  topic?: string;
  /** Where this channel lived before the restructure; it is moved from there instead of recreated. */
  legacy?: { name: string; parent: string | null }[];
  panel?: "picker" | "verify" | "bitcoin" | "start" | "locked" | "support";
  /** For a lock channel: the name of the channel it stands in for, shown on its Verify panel. */
  topic?: string;
}

/**
 * The one layout every language gets. A member only ever sees their own
 * language's copy:
 *
 *   (top level)     🧭・𝐒𝐄𝐑𝐕𝐄𝐑-𝐆𝐔𝐈𝐃𝐄, above every category, in bold capitals so it reads as its own part
 *   ANNOUNCEMENTS   announcements · alphanumetrix · bot-alerts · signals · 🔒 trade-signals
 *   COMMUNITY       🔒 trading-group · bitcoin · crypto · stocks · commodities · general · memes · help-desk
 *   REFERENCE       setup-guides · trading-strategies · forums
 *
 * No voice channels: one per language is more rooms than anyone would use.
 */
// Members see the real channel, unverified members see its 🔒 stand-in with the Verify button; each sees one set.
const LAYOUT: { cat: "ann" | "com" | "ref"; top?: true; kind: Kind; tier: Tier; readOnly?: boolean; noHistory?: true; type?: "voice" | "forum"; panel?: Spec["panel"]; lockFor?: Kind }[] = [
  // Outside every category, so it sits above them all; each language role sees only its own.
  { cat: "ann", top: true, kind: "start", tier: "free", readOnly: true, panel: "start" },
  { cat: "ann", kind: "announcements", tier: "free", readOnly: true },
  { cat: "ann", kind: "flagship", tier: "member", readOnly: true },
  { cat: "ann", kind: "daytrade", tier: "member", readOnly: true },
  { cat: "ann", kind: "signals", tier: "member", readOnly: true },
  // One 🔒 trade-signals channel stands in for alphanumetrix, bot-alerts and trade-alerts.
  { cat: "ann", kind: "teaser", tier: "teaser", readOnly: true, panel: "locked" },
  // General and memes are open to everyone who picked a language, without the backlog; the 🔒 panels carry the Verify button.
  { cat: "com", kind: "bitcoin", tier: "member" },
  { cat: "com", kind: "crypto", tier: "member" },
  { cat: "com", kind: "stocks", tier: "member" },
  { cat: "com", kind: "commodities", tier: "member" },
  { cat: "com", kind: "general", tier: "free", noHistory: true },
  { cat: "com", kind: "memes", tier: "free", noHistory: true },
  { cat: "com", kind: "help", tier: "help", readOnly: true, panel: "support" },
  // One forum for guides, strategies, videos and questions, under help-desk, for verified members.
  { cat: "com", kind: "academy", tier: "member", type: "forum" },
  // One 🔒 trading-group channel, at the bottom, stands in for bitcoin, crypto, stocks and commodities.
  // Unverified members see it last (┗), verified members see the academy last.
  { cat: "com", kind: "tradegate", tier: "teaser", readOnly: true, panel: "locked" },
];

/** The categories as they were named with an emoji; renamed in place to the folder style below. */
const CATS_EMOJI: Record<Lang, Record<"ann" | "com" | "ref", string>> = {
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

/**
 * Folder style: a category reads as the parent folder (┏━━ SIGNALS & ALERTS) and
 * its channels as branches under it (┣📢・announcements), the last one closing
 * the folder (┗). Unverified and verified members see different channels, so
 * each audience's own last channel gets the ┗ (see branchOf).
 */
const FOLDER = "┏━━ ";
const BRANCH = "┣";
const END = "┗";
/** The first folder-style names: the emoji names with ┏━━ in place of the emoji. */
const CATS_V1 = Object.fromEntries(
  LANGS.map((lang) => [lang, Object.fromEntries(Object.entries(CATS_EMOJI[lang]).map(([k, v]) => [k, FOLDER + v.replace(/^\S+\s+/u, "")]))]),
) as Record<Lang, Record<"ann" | "com" | "ref", string>>;
/**
 * Signals & Alerts holds announcements and the alerts; Trading Floor, the server's own name for itself, holds the rest.
 * Each language says it its own way: the script finds categories by name, so no two languages may share one.
 */
const CAT_TITLES: Record<Lang, { ann: string; com: string }> = {
  en: { ann: "SIGNALS & ALERTS", com: "TRADING FLOOR" },
  zh: { ann: "信号与提醒", com: "交易大厅" },
  ko: { ann: "시그널 & 알림", com: "트레이딩 플로어" },
  id: { ann: "SINYAL & ALERT", com: "RUANG TRADING" },
  vi: { ann: "TÍN HIỆU & CẢNH BÁO", com: "SÀN GIAO DỊCH" },
  es: { ann: "SEÑALES Y ALERTAS", com: "SALA DE TRADING" },
  pt: { ann: "SINAIS E ALERTAS", com: "PREGÃO" },
  tr: { ann: "SİNYALLER & UYARILAR", com: "İŞLEM SALONU" },
  ru: { ann: "СИГНАЛЫ И АЛЕРТЫ", com: "ТОРГОВЫЙ ЗАЛ" },
  ja: { ann: "シグナル＆アラート", com: "トレーディングフロア" },
};
const CATS = Object.fromEntries(
  LANGS.map((lang) => [lang, { ann: FOLDER + CAT_TITLES[lang].ann, com: FOLDER + CAT_TITLES[lang].com, ref: CATS_V1[lang].ref }]),
) as Record<Lang, Record<"ann" | "com" | "ref", string>>;

const NAMES: Record<Lang, Record<Kind, string>> = {
  en: { academy: "🎓・academy", announcements: "📢・announcements", flagship: "🟢🟢・alphanumetrix", investor: "💼・investor-signals", daytrade: "🤖・bot-alerts", "lock-flagship": "", "lock-investor": "", "lock-daytrade": "", "lock-crypto": "", "lock-stocks": "", "lock-commodities": "", teaser: "🔒・trade-signals", signals: "⚡・trade-alerts", verify: "✅・verify", btcgate: "🔒・bitcoin", tradegate: "🔒・trading-group", general: "💬・general", trader: "📈・trader-chat", bitcoin: "🟠・bitcoin", crypto: "🪙・crypto", stocks: "📊・stocks", commodities: "🛢️・commodities", memes: "😂・memes", help: "☎️・help-desk", start: "🧭・server-guide", guides: "📕・setup-guides", strategies: "📗・trading-strategies", forums: "🧵・forums" },
  zh: { academy: "🎓・学院", announcements: "📢・公告", flagship: "🟢🟢・alphanumetrix", investor: "💼・投资信号", daytrade: "🤖・机器人提醒", "lock-flagship": "", "lock-investor": "", "lock-daytrade": "", "lock-crypto": "", "lock-stocks": "", "lock-commodities": "", teaser: "🔒・交易信号", signals: "⚡・交易提醒", verify: "✅・验证", btcgate: "🔒・比特币", tradegate: "🔒・交易群组", general: "💬・闲聊", trader: "📈・交易者聊天", bitcoin: "🟠・比特币", crypto: "🪙・加密货币", stocks: "📊・股票", commodities: "🛢️・大宗商品", memes: "😂・表情包", help: "☎️・帮助台", start: "🧭・服务器指南", guides: "📕・设置指南", strategies: "📗・交易策略", forums: "🧵・论坛" },
  ko: { academy: "🎓・아카데미", announcements: "📢・공지사항", flagship: "🟢🟢・alphanumetrix", investor: "💼・투자-신호", daytrade: "🤖・봇-알림", "lock-flagship": "", "lock-investor": "", "lock-daytrade": "", "lock-crypto": "", "lock-stocks": "", "lock-commodities": "", teaser: "🔒・매매신호", signals: "⚡・매매신호", verify: "✅・인증", btcgate: "🔒・비트코인", tradegate: "🔒・트레이딩-그룹", general: "💬・자유채팅", trader: "📈・트레이더-채팅", bitcoin: "🟠・비트코인", crypto: "🪙・코인", stocks: "📊・주식", commodities: "🛢️・원자재", memes: "😂・밈", help: "☎️・도움말", start: "🧭・서버-가이드", guides: "📕・설정-가이드", strategies: "📗・매매-전략", forums: "🧵・포럼" },
  id: { academy: "🎓・akademi", announcements: "📢・pengumuman", flagship: "🟢🟢・alphanumetrix", investor: "💼・sinyal-investor", daytrade: "🤖・alert-bot", "lock-flagship": "", "lock-investor": "", "lock-daytrade": "", "lock-crypto": "", "lock-stocks": "", "lock-commodities": "", teaser: "🔒・sinyal-trading", signals: "⚡・sinyal-trading", verify: "✅・verifikasi", btcgate: "🔒・bitcoin", tradegate: "🔒・grup-trading", general: "💬・obrolan-umum", trader: "📈・obrolan-trader", bitcoin: "🟠・bitcoin", crypto: "🪙・kripto", stocks: "📊・saham", commodities: "🛢️・komoditas", memes: "😂・meme", help: "☎️・bantuan", start: "🧭・panduan-server", guides: "📕・panduan-setup", strategies: "📗・strategi-trading", forums: "🧵・forum" },
  vi: { academy: "🎓・học-viện", announcements: "📢・thông-báo", flagship: "🟢🟢・alphanumetrix", investor: "💼・tín-hiệu-đầu-tư", daytrade: "🤖・cảnh-báo-bot", "lock-flagship": "", "lock-investor": "", "lock-daytrade": "", "lock-crypto": "", "lock-stocks": "", "lock-commodities": "", teaser: "🔒・tín-hiệu-giao-dịch", signals: "⚡・tín-hiệu", verify: "✅・xác-minh", btcgate: "🔒・bitcoin", tradegate: "🔒・nhóm-giao-dịch", general: "💬・tán-gẫu", trader: "📈・trò-chuyện-trader", bitcoin: "🟠・bitcoin", crypto: "🪙・crypto", stocks: "📊・cổ-phiếu", commodities: "🛢️・hàng-hóa", memes: "😂・meme", help: "☎️・hỗ-trợ", start: "🧭・hướng-dẫn-server", guides: "📕・hướng-dẫn", strategies: "📗・chiến-lược", forums: "🧵・diễn-đàn" },
  es: { academy: "🎓・academia", announcements: "📢・anuncios", flagship: "🟢🟢・alphanumetrix", investor: "💼・señales-inversión", daytrade: "🤖・alertas-bot", "lock-flagship": "", "lock-investor": "", "lock-daytrade": "", "lock-crypto": "", "lock-stocks": "", "lock-commodities": "", teaser: "🔒・señales-trading", signals: "⚡・alertas", verify: "✅・verificar", btcgate: "🔒・bitcoin", tradegate: "🔒・grupo-trading", general: "💬・general", trader: "📈・chat-traders", bitcoin: "🟠・bitcoin", crypto: "🪙・cripto", stocks: "📊・acciones", commodities: "🛢️・materias-primas", memes: "😂・memes", help: "☎️・ayuda", start: "🧭・guía-del-servidor", guides: "📕・guías", strategies: "📗・estrategias", forums: "🧵・foros" },
  pt: { academy: "🎓・academia", announcements: "📢・anúncios", flagship: "🟢🟢・alphanumetrix", investor: "💼・sinais-investimento", daytrade: "🤖・alertas-bot", "lock-flagship": "", "lock-investor": "", "lock-daytrade": "", "lock-crypto": "", "lock-stocks": "", "lock-commodities": "", teaser: "🔒・sinais-trading", signals: "⚡・alertas", verify: "✅・verificar", btcgate: "🔒・bitcoin", tradegate: "🔒・grupo-trading", general: "💬・geral", trader: "📈・chat-traders", bitcoin: "🟠・bitcoin", crypto: "🪙・cripto", stocks: "📊・ações", commodities: "🛢️・commodities", memes: "😂・memes", help: "☎️・ajuda", start: "🧭・guia-do-servidor", guides: "📕・guias", strategies: "📗・estratégias", forums: "🧵・fóruns" },
  tr: { academy: "🎓・akademi", announcements: "📢・duyurular", flagship: "🟢🟢・alphanumetrix", investor: "💼・yatırım-sinyalleri", daytrade: "🤖・bot-uyarıları", "lock-flagship": "", "lock-investor": "", "lock-daytrade": "", "lock-crypto": "", "lock-stocks": "", "lock-commodities": "", teaser: "🔒・işlem-sinyalleri", signals: "⚡・sinyaller", verify: "✅・doğrulama", btcgate: "🔒・bitcoin", tradegate: "🔒・trading-grubu", general: "💬・sohbet", trader: "📈・trader-sohbet", bitcoin: "🟠・bitcoin", crypto: "🪙・kripto", stocks: "📊・hisseler", commodities: "🛢️・emtia", memes: "😂・mizah", help: "☎️・yardım", start: "🧭・sunucu-rehberi", guides: "📕・kurulum-rehberi", strategies: "📗・stratejiler", forums: "🧵・forum" },
  ru: { academy: "🎓・академия", announcements: "📢・объявления", flagship: "🟢🟢・alphanumetrix", investor: "💼・инвест-сигналы", daytrade: "🤖・алерты-бота", "lock-flagship": "", "lock-investor": "", "lock-daytrade": "", "lock-crypto": "", "lock-stocks": "", "lock-commodities": "", teaser: "🔒・торговые-сигналы", signals: "⚡・сигналы", verify: "✅・верификация", btcgate: "🔒・биткоин", tradegate: "🔒・трейдинг-группа", general: "💬・общий-чат", trader: "📈・чат-трейдеров", bitcoin: "🟠・биткоин", crypto: "🪙・крипта", stocks: "📊・акции", commodities: "🛢️・сырьё", memes: "😂・мемы", help: "☎️・помощь", start: "🧭・гид-по-серверу", guides: "📕・гайды", strategies: "📗・стратегии", forums: "🧵・форум" },
  ja: { academy: "🎓・アカデミー", announcements: "📢・お知らせ", flagship: "🟢🟢・alphanumetrix", investor: "💼・投資シグナル", daytrade: "🤖・ボットアラート", "lock-flagship": "", "lock-investor": "", "lock-daytrade": "", "lock-crypto": "", "lock-stocks": "", "lock-commodities": "", teaser: "🔒・トレードシグナル", signals: "⚡・シグナル", verify: "✅・認証", btcgate: "🔒・ビットコイン", tradegate: "🔒・トレードグループ", general: "💬・雑談", trader: "📈・トレーダー-チャット", bitcoin: "🟠・ビットコイン", crypto: "🪙・暗号資産", stocks: "📊・株式", commodities: "🛢️・コモディティ", memes: "😂・ミーム", help: "☎️・ヘルプ", start: "🧭・サーバーガイド", guides: "📕・設定ガイド", strategies: "📗・トレード戦略", forums: "🧵・フォーラム" },
};

/** Names the bot-alerts channel had as day-trade signals, so the migration renames instead of recreating. */
const DAYTRADE_OLD: Record<Lang, string> = {"en": "⏱️・day-trade-signals", "zh": "⏱️・日内交易信号", "ko": "⏱️・단타-신호", "id": "⏱️・sinyal-day-trade", "vi": "⏱️・tín-hiệu-lướt-sóng", "es": "⏱️・señales-day-trading", "pt": "⏱️・sinais-day-trade", "tr": "⏱️・günlük-işlem-sinyalleri", "ru": "⏱️・интрадей-сигналы", "ja": "⏱️・デイトレシグナル"};

/** Names the 🔒 trade-signals channel had as trade-alerts, so the migration renames instead of recreating. */
const TEASER_OLD: Record<Lang, string> = {"en": "🔒・trade-alerts", "zh": "🔒・交易提醒", "ko": "🔒・매매신호", "id": "🔒・sinyal-trading", "vi": "🔒・tín-hiệu", "es": "🔒・alertas", "pt": "🔒・alertas", "tr": "🔒・sinyaller", "ru": "🔒・сигналы", "ja": "🔒・シグナル"};

// A lock channel is the real channel's name behind a 🔒.
const bare = (name: string) => name.split("・").slice(1).join("・");
for (const lang of LANGS) for (const l of LAYOUT) if (l.lockFor) NAMES[lang][l.kind] = `🔒・${bare(NAMES[lang][l.lockFor])}`;
/** The server guide's name before it was framed and lifted out of ANNOUNCEMENTS. */
const START_OLD = Object.fromEntries(LANGS.map((lang) => [lang, NAMES[lang].start])) as Record<Lang, string>;
// Bracketed, so the one channel above the categories reads as a separate part.
for (const lang of LANGS) NAMES[lang].start = guideChannelName(lang);

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
  guides: "setup-guides", strategies: "trading-strategies", forums: "forums", academy: "academy",
  crypto: "crypto", stocks: "stocks", commodities: "commodities",
  flagship: "alphanumetrix", daytrade: "bot-alerts",
};

/**
 * The academy's tags, in the same order in every language: the mirror maps a
 * post's tags to its twins by position.
 */
const ACADEMY_TAG_EMOJI = ["📕", "📗", "🎬", "❓", "💬"] as const;
const ACADEMY_TAGS: Record<Lang, string[]> = {
  en: ["Setup guide", "Strategy", "Video tutorial", "Question", "Discussion"],
  zh: ["设置指南", "策略", "视频教程", "提问", "讨论"],
  ko: ["설정 가이드", "전략", "영상 강의", "질문", "토론"],
  id: ["Panduan setup", "Strategi", "Video tutorial", "Pertanyaan", "Diskusi"],
  vi: ["Hướng dẫn cài đặt", "Chiến lược", "Video hướng dẫn", "Câu hỏi", "Thảo luận"],
  es: ["Configuración", "Estrategia", "Video tutorial", "Pregunta", "Debate"],
  pt: ["Configuração", "Estratégia", "Vídeo tutorial", "Pergunta", "Discussão"],
  tr: ["Kurulum rehberi", "Strateji", "Video eğitim", "Soru", "Tartışma"],
  ru: ["Настройка", "Стратегия", "Видеоурок", "Вопрос", "Обсуждение"],
  ja: ["設定ガイド", "戦略", "動画チュートリアル", "質問", "ディスカッション"],
};
const academyTags = (lang: Lang) => ACADEMY_TAGS[lang].map((name, i) => ({ name, emoji: { id: null, name: ACADEMY_TAG_EMOJI[i] } }));
/** The forums the academy replaces, with the tag their posts get when they move. */
const ACADEMY_FROM: { kind: "guides" | "strategies" | "forums"; tag: number }[] = [
  { kind: "guides", tag: 0 },
  { kind: "strategies", tag: 1 },
  { kind: "forums", tag: 4 },
];
/** Where an old forum is: under REFERENCE, folder style or emoji style, with or without its branch. */
function oldForum(guild: Guild, lang: Lang, kind: "guides" | "strategies" | "forums") {
  const plain = NAMES[lang][kind];
  for (const parent of [CATS[lang].ref, CATS_EMOJI[lang].ref]) {
    for (const name of [BRANCH + plain, plain]) {
      const ch = findChannel(guild, { name, parent });
      if (ch?.type === ChannelType.GuildForum) return ch;
    }
  }
  return undefined;
}

const PICKER: Spec = { name: "🌐・choose-language", parent: null, lang: "all", tier: "picker", readOnly: true, topic: "Pick your language to enter", panel: "picker" };

/** Tiers each audience sees: a member who picked a language, and one who also verified. */
const SEEN_BY = { base: ["verify", "teaser", "free", "trader", "help"], member: ["free", "trader", "member", "help"] } as Record<"base" | "member", Tier[]>;
/** ┗ for the last channel of its category that either audience sees, ┣ for the rest. */
function branchOf(l: (typeof LAYOUT)[number]) {
  const inCat = LAYOUT.filter((x) => x.cat === l.cat && !x.top);
  const last = (who: "base" | "member") => inCat.filter((x) => SEEN_BY[who].includes(x.tier)).at(-1);
  return last("base") === l || last("member") === l ? END : BRANCH;
}

const SPECS: Spec[] = [PICKER, { name: "verify-preview", parent: null, lang: "all", tier: "ops" }];
for (const lang of LANGS) {
  for (const l of LAYOUT) {
    const plain = NAMES[lang][l.kind];
    const name = l.top ? plain : branchOf(l) + plain;
    const legacy = lang === "en"
      ? [{ name: plain, parent: EN_OLD[l.kind] ?? null }, ...(l.kind === "start" ? [{ name: "📍・start-here", parent: null }] : [])]
      : [{ name: plain, parent: OLD_CATS[lang as Exclude<Lang, "en">] }];
    // Before the folder style the channel carried no branch, then the same ┣ on every channel; its category had other names.
    if (!l.top) {
      for (const parent of [CATS[lang][l.cat], CATS_V1[lang][l.cat], CATS_EMOJI[lang][l.cat]]) {
        for (const n of [plain, BRANCH + plain, END + plain]) if (n !== name || parent !== CATS[lang][l.cat]) legacy.push({ name: n, parent });
      }
    }
    if (l.kind === "start") legacy.push({ name: START_OLD[lang], parent: CATS[lang][l.cat] }, { name: `═🧭・${bare(START_OLD[lang])}・🧭═`, parent: null }, { name: `【${bare(START_OLD[lang])}】`, parent: null });
    if (l.kind === "tradegate") legacy.push({ name: NAMES[lang].btcgate, parent: CATS[lang][l.cat] });
    // Memes wore 🐸 before 😂, which reads as "funny" in every language.
    if (l.kind === "memes") legacy.push({ name: NAMES[lang].memes.replace("😂", "🐸"), parent: CATS[lang][l.cat] });
    if (l.kind === "teaser") legacy.push({ name: TEASER_OLD[lang], parent: CATS[lang][l.cat] });
    if (l.kind === "daytrade") {
      legacy.push({ name: DAYTRADE_OLD[lang], parent: CATS[lang][l.cat] });
    }
    const topic = l.lockFor ? bare(NAMES[lang][l.lockFor]) : l.panel === "locked" ? bare(name) : undefined;
    SPECS.push({ name, parent: l.top ? null : CATS[lang][l.cat], lang, tier: l.tier, kind: l.kind, readOnly: l.readOnly, noHistory: l.noHistory, type: l.type, panel: l.panel, topic, legacy });
  }
}

// REFERENCE is gone: its forums became the academy. Cleanup deletes it once the posts have moved.
const ALL_CATS = LANGS.flatMap((l) => [CATS[l].ann, CATS[l].com]);
if (new Set(ALL_CATS).size !== ALL_CATS.length) throw new Error("two languages share a category name");
const CATEGORY_SPECS: { name: string; olds: string[]; lang: Lang; tier: Tier }[] = LANGS.flatMap((lang) =>
  (["ann", "com"] as const).map((k) => ({ name: CATS[lang][k], olds: [CATS_V1[lang][k], CATS_EMOJI[lang][k]], lang, tier: "free" as Tier })),
);

/**
 * Roles whose ViewChannel the new tiers replace on the channels above. Their
 * other bits (a mute's send deny, say) are kept. Staff and bot roles are not
 * listed and keep their overwrites untouched.
 */
const REPLACED_ROLE_NAMES = ["Member", "Members", "New Member", "Muted Member"];

// Thread permissions are for help-desk, where each support request gets a private thread.
const BOT_ALLOW = [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.ManageMessages, P.ManageWebhooks, P.EmbedLinks, P.AttachFiles, P.CreatePrivateThreads, P.SendMessagesInThreads, P.ManageThreads, P.PinMessages];

const TRANSLATE_PNG = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "emoji", "translate.png");

const STEPS = ["roles", "members", "channels", "perms", "mirror", "notify", "panels", "academy", "rules", "vip", "cleanup"] as const;
type Step = (typeof STEPS)[number];

interface Ctx {
  guild: Guild;
  db: Db;
  apply: boolean;
  role: (lang: Lang, tier: "base" | "member") => string | undefined;
}

const log = (s: string) => console.log(s);

/** Channel names compare equal across the flagship's state emoji, which /flagship changes. */
const STATE = /^([┣┗]?)[🟢🟡🔴]{1,2}・/u;
const sameName = (a: string, b: string) => a === b || (STATE.test(a) && STATE.test(b) && a.replace(STATE, "$1") === b.replace(STATE, "$1"));

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
    const old = c.olds.map((n) => findCategory(guild, n)).find(Boolean);
    if (old) {
      log(`  rename category ${old.name} → ${c.name}`);
      if (ctx.apply) await old.setName(c.name, "onboarding: folder style");
      continue;
    }
    log(`  create category ${c.name}`);
    if (ctx.apply) await guild.channels.create({ name: c.name, type: ChannelType.GuildCategory, permissionOverwrites: [{ id: guild.roles.everyone.id, deny: [P.ViewChannel] }], reason: "onboarding" });
  }
  if (ctx.apply) await guild.channels.fetch();

  for (const s of SPECS) {
    if (s.tier === "ops") continue;
    // A dry run sees categories under their old names, before the rename above.
    const parent = s.parent ? findCategory(guild, s.parent) ?? (CATEGORY_SPECS.find((c) => c.name === s.parent)?.olds ?? []).map((n) => findCategory(guild, n)).find(Boolean) : undefined;
    const existing = locate(guild, s);
    if (existing) {
      if (!sameName(existing.name, s.name) || (existing.name !== s.name && !STATE.test(s.name))) {
        // A state channel keeps the icon it shows now; only the rest of the name follows the layout.
        const target = STATE.test(s.name) && STATE.test(existing.name) ? s.name.replace(STATE, `$1${existing.name.match(STATE)![0].replace(/^[┣┗]/, "")}`) : s.name;
        log(`  rename #${existing.name} → #${target}`);
        if (ctx.apply) await existing.setName(target, "onboarding: one layout per language");
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
      ...(s.kind === "academy" && s.lang !== "all" ? { availableTags: academyTags(s.lang) } : {}),
      permissionOverwrites: [
        { id: guild.roles.everyone.id, deny: [P.ViewChannel] },
        { id: me.id, type: OverwriteType.Member, allow: BOT_ALLOW },
      ],
      reason: "onboarding",
    });
  }
  if (!ctx.apply) return;
  await guild.channels.fetch();

  // An academy made before its tags existed gets them now.
  for (const s of SPECS.filter((x) => x.kind === "academy" && x.lang !== "all")) {
    const ch = findChannel(guild, s);
    if (ch?.type === ChannelType.GuildForum && ch.availableTags.length === 0) {
      log(`  tag #${ch.name}`);
      await ch.setAvailableTags(academyTags(s.lang as Lang), "onboarding: academy tags");
    }
  }

  // Order: picker on top, then each language's three categories, channels in layout order.
  const positions: { channel: string; position: number }[] = [];
  const picker = findChannel(guild, PICKER);
  if (picker) positions.push({ channel: picker.id, position: 0 });
  SPECS.filter((s) => s.parent === null && s.lang !== "all").forEach((s, i) => {
    const ch = findChannel(guild, s);
    if (ch) positions.push({ channel: ch.id, position: i + 1 });
  });
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
/**
 * Moves the English posts of the old guide, strategy and discussion forums into
 * the academy, tagged, under their original author's name and avatar. They go
 * through a webhook of our own, so the running bot mirrors and translates them
 * into every other language's academy, as with any new post. The other
 * languages' old forums only hold translations of these, so they need no move.
 * Replies stay behind in the old forums. Each move is recorded, so a rerun only
 * moves what is left; cleanup deletes the old forums once everything moved.
 */
async function stepAcademy(ctx: Ctx) {
  const { guild, db } = ctx;
  const target = findChannel(guild, SPECS.find((s) => s.lang === "en" && s.kind === "academy")!);
  if (target?.type !== ChannelType.GuildForum) { log("  ! no English academy yet (run channels first)"); return; }
  const hooks = ctx.apply ? await target.fetchWebhooks() : null;
  const hook = hooks?.find((h) => h.name === "BLKBöX Academy" && h.token) ?? (ctx.apply ? await target.createWebhook({ name: "BLKBöX Academy", reason: "onboarding: academy move" }) : null);
  let left = 0;
  for (const from of ACADEMY_FROM) {
    const forum = oldForum(guild, "en", from.kind);
    if (!forum) continue;
    const active = await forum.threads.fetchActive();
    const archived = await forum.threads.fetchArchived({ fetchAll: true });
    const posts = [...active.threads.filter((t) => t.parentId === forum.id).values(), ...archived.threads.values()].sort((a, b) => (a.createdTimestamp ?? 0) - (b.createdTimestamp ?? 0));
    for (const t of posts) {
      if (await db.getSetting(guild.id, `academy_moved:${t.id}`)) continue;
      left++;
      log(`  move "${t.name}" from #${forum.name} → #${target.name} [${ACADEMY_TAGS.en[from.tag]}]`);
      if (!ctx.apply || !hook) continue;
      const starter = await t.fetchStarterMessage().catch(() => null);
      if (!starter) { log(`  ! "${t.name}" has no opening message, skipped`); continue; }
      const sent = await hook.send({
        threadName: t.name.slice(0, 100),
        content: starter.content || "\u200b",
        files: [...starter.attachments.values()].map((a) => ({ attachment: a.url, name: a.name })),
        embeds: starter.embeds.filter((e) => !e.data.type || e.data.type === "rich").map((e) => e.toJSON()),
        username: (starter.member?.displayName ?? starter.author.displayName ?? starter.author.username).slice(0, 80),
        avatarURL: starter.author.displayAvatarURL(),
        appliedTags: [target.availableTags[from.tag]?.id].filter((x): x is string => !!x),
        allowedMentions: { parse: [] },
      });
      await db.setSetting(guild.id, `academy_moved:${t.id}`, sent.channelId);
      left--;
      // One post at a time, so the mirror translates each before the next lands.
      await new Promise((r) => setTimeout(r, 4000));
    }
  }
  if (!left) {
    log("  every post is in the academy");
    if (ctx.apply) await db.setSetting(guild.id, "academy_moved", "1");
  }
}

async function stepCleanup(ctx: Ctx) {
  const { guild } = ctx;
  // The old forums and REFERENCE, once the academy step has moved every post.
  const moved = await ctx.db.getSetting(guild.id, "academy_moved");
  for (const lang of LANGS) {
    for (const from of ACADEMY_FROM) {
      const forum = oldForum(guild, lang, from.kind);
      if (!forum) continue;
      if (!moved) { log(`  keep #${forum.name} (${lang}; run the academy step first)`); continue; }
      log(`  delete #${forum.name} (${lang}; its posts are in the academy)`);
      if (!ctx.apply) continue;
      await ctx.db.removeMember(forum.id);
      await forum.delete("onboarding: folded into the academy");
    }
    for (const name of [CATS[lang].ref, CATS_EMOJI[lang].ref]) {
      const cat = findCategory(guild, name);
      if (!cat) continue;
      const left = guild.channels.cache.filter((c) => c.parentId === cat.id && !(ctx.apply && c.type === ChannelType.GuildForum && moved));
      if (left.size) { log(`  keep ${name} (still holds ${left.map((c) => "#" + c.name).join(", ")})`); continue; }
      log(`  delete empty category ${name}`);
      if (ctx.apply) await cat.delete("onboarding: REFERENCE folded into the academy");
    }
  }
  // The 🔒 alphanumetrix and bot-alerts stand-ins, folded into 🔒 trade-signals.
  for (const lang of LANGS) {
    const parent = CATS[lang].ann;
    for (const name of [NAMES[lang].flagship, NAMES[lang].daytrade, DAYTRADE_OLD[lang]].map((n) => `🔒・${bare(n)}`)) {
      const ch = findChannel(guild, { name, parent });
      if (!ch) continue;
      log(`  delete #${ch.name} (${lang}; 🔒 trade-signals replaces it)`);
      if (ctx.apply) await ch.delete("onboarding: one locked trade-signals channel");
    }
    // Verify (every 🔒 panel carries the button), trader-chat, and the 🔒 topic stand-ins folded into trading-group.
    const com = CATS[lang].com;
    const gone = [NAMES[lang].verify, NAMES[lang].trader, NAMES[lang].btcgate, ...(["crypto", "stocks", "commodities"] as const).map((k) => `🔒・${bare(NAMES[lang][k])}`)];
    for (const name of gone) {
      const ch = findChannel(guild, { name, parent: com });
      if (!ch) continue;
      log(`  delete #${ch.name} (${lang}; no longer in the layout)`);
      if (ctx.apply) await ch.delete("onboarding: community layout trimmed");
    }
  }
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
function overwritesFor(ctx: Ctx, ch: NonThreadGuildBasedChannel | CategoryChannel, lang: Lang | "all", tier: Tier, readOnly: boolean, noHistory = false): OverwriteResolvable[] {
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
      // A leftover history allow on an old member role would bring the backlog back.
      if (noHistory) allow &= ~P.ReadMessageHistory;
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
      // History on, so the Verify panel posted before they arrived is there to read.
      if (tier === "verify" || tier === "teaser") base && set(base, OverwriteType.Role, P.ViewChannel | P.ReadMessageHistory, 0n);
      if (tier === "free") {
        // An open channel allows Send outright, so a leftover @everyone deny can't mute it.
        // History allowed outright too (unless the channel hides it), so an old @everyone history deny can't hide the backlog.
        const allow = (readOnly ? P.ViewChannel : P.ViewChannel | P.SendMessages | P.SendMessagesInThreads) | (noHistory ? 0n : P.ReadMessageHistory);
        const deny = noHistory ? P.ReadMessageHistory : 0n;
        base && set(base, OverwriteType.Role, allow, deny);
        member && set(member, OverwriteType.Role, allow, deny);
      }
      if (tier === "help") {
        // Members write only inside the private thread the Get help button opens for them, never in the channel.
        const inThread = P.ViewChannel | P.ReadMessageHistory | P.SendMessagesInThreads | P.EmbedLinks | P.AttachFiles | P.AddReactions | P.UseExternalEmojis;
        const noChat = P.SendMessages | P.CreatePublicThreads | P.CreatePrivateThreads;
        base && set(base, OverwriteType.Role, inThread, noChat);
        member && set(member, OverwriteType.Role, inThread, noChat);
      }
      if (tier === "trader") {
        base && set(base, OverwriteType.Role, P.ViewChannel, P.SendMessages | P.SendMessagesInThreads | P.CreatePublicThreads | P.AddReactions);
        member && set(member, OverwriteType.Role, P.ViewChannel | P.ReadMessageHistory, 0n);
      }
      if (tier === "member") member && set(member, OverwriteType.Role, P.ViewChannel | P.ReadMessageHistory, 0n);
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
      const h = a & P.ReadMessageHistory ? " +history" : d & P.ReadMessageHistory ? " -history" : "";
      return v || s || h ? `${name}${v ? " " + v : ""}${s}${h}` : null;
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
    const ows = overwritesFor(ctx, ch, s.lang, s.tier, !!s.readOnly, !!s.noHistory);
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

/** Notification roles: one per ping topic, which members pick in the server guide instead of being pinged with @everyone. */
async function stepNotify(ctx: Ctx) {
  const { guild } = ctx;
  for (const topic of NOTIFY_TOPICS) {
    const { name } = NOTIFY_ROLES[topic];
    let role = guild.roles.cache.find((r) => r.name === name);
    if (!role) {
      log(`  create role ${name}`);
      // Not mentionable: members can't ping each other with it; moderators (Mention Everyone) and webhooks can.
      if (ctx.apply) role = await guild.roles.create({ name, mentionable: false, permissions: [], reason: "notification center" });
    }
    if (role && ctx.apply) await ctx.db.setSetting(guild.id, `notify_role:${topic}`, role.id);
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
    // Any bot's panels go, not just ours: a panel posted by another bot account (the test server's
    // old shared bot) has buttons only that bot can answer. Webhook posts (mirrored chat) stay.
    const old = (await ch.messages.fetch({ limit: 50 })).filter((m) => m.author.bot && !m.webhookId);
    for (const m of old.values()) await m.delete().catch(() => {});
    const lang: Lang = s.lang === "all" ? "en" : s.lang;
    const help = findChannel(guild, SPECS.find((x) => x.lang === lang && x.kind === "help")!);
    const helpDeskUrl = `https://discord.com/channels/${guild.id}/${help?.id ?? ""}`;
    if (s.panel === "picker") {
      if (!tr) tr = await guild.emojis.create({ attachment: TRANSLATE_PNG, name: "translate", reason: "onboarding: language picker icon" });
      for (const msg of startHereMessages({ picker: true, translateEmoji: tr.toString(), helpDeskUrl })) await ch.send(msg);
    } else if (s.panel === "locked") {
      await ch.send(verifyPanel(lang, "locked", s.topic));
    } else if (s.panel === "support") {
      // Not pinned: nobody can post in help-desk, so the panel is the only message there.
      await ch.send(supportPanel(lang));
      // The bot opens each language's help threads here, whichever button they came from.
      await ctx.db.setSetting(guild.id, `support_channel:${lang}`, ch.id);
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
    const run: Record<Step, (c: Ctx) => Promise<void>> = { roles: stepRoles, members: stepMembers, channels: stepChannels, perms: stepPerms, mirror: stepMirror, panels: stepPanels, rules: stepRules, vip: stepVip, cleanup: stepCleanup, notify: stepNotify, academy: stepAcademy };
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
