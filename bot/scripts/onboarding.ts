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

interface Spec {
  name: string;
  /** Category name; null for top level. */
  parent: string | null;
  lang: Lang | "all";
  tier: Tier;
  readOnly?: boolean;
  /** Created when missing. Existing channels are only re-permissioned, never renamed or moved. */
  create?: { topic: string; type?: "text" | "voice" | "forum" };
  /** Panel the bot posts here after creating it. */
  panel?: "picker" | "verify" | "bitcoin";
  /** Mirror group this channel joins, with its source channel. */
  mirror?: { group: string; source: string };
}

const CAT = {
  alerts: "╭───  Alerts  ───╮",
  chat: "╭───  Chat Rooms  ───╮",
  edu: "╭─── Education ───╮",
  zh: "╭───  中文  ───╮",
  ko: "╭───  한국어  ───╮",
  id: "╭───  Bahasa Indonesia  ───╮",
};

const TEASER = "🔒・trade-alerts";
const teaserTopic: Record<Exclude<Lang, "en">, string> = {
  zh: "交易提醒预览（#🔒・trade-alerts 的自动翻译镜像）。验证 UID 后可看到完整提醒",
  ko: "매매신호 미리보기 (#🔒・trade-alerts 자동 번역 미러). UID 인증 후 전체 신호가 열립니다",
  id: "Pratinjau sinyal trading (cermin terjemahan #🔒・trade-alerts). Verifikasi UID untuk sinyal lengkap",
};

const SPECS: Spec[] = [
  // Everyone
  { name: "🌐・choose-language", parent: null, lang: "all", tier: "picker", readOnly: true, create: { topic: "Pick your language to enter · 选择语言 · 언어 선택 · Pilih bahasa" }, panel: "picker" },
  { name: "📍・start-here", parent: null, lang: "all", tier: "free", readOnly: true },
  { name: "verify-preview", parent: null, lang: "all", tier: "ops" },

  // English
  { name: "✅・verify", parent: null, lang: "en", tier: "verify", readOnly: true, create: { topic: "Verify your exchange UID to unlock the Trading Floor" }, panel: "verify" },
  { name: "📢・announcements", parent: null, lang: "en", tier: "free", readOnly: true },
  { name: TEASER, parent: CAT.alerts, lang: "en", tier: "teaser", readOnly: true },
  { name: "⚡・trade-alerts", parent: CAT.alerts, lang: "en", tier: "member", readOnly: true },
  { name: "🔒・bitcoin", parent: CAT.chat, lang: "en", tier: "teaser", readOnly: true, create: { topic: "Verified members only. Verify your UID here to unlock bitcoin chat" }, panel: "bitcoin" },
  { name: "☎️・help-desk", parent: CAT.chat, lang: "en", tier: "free" },
  { name: "📈・trader-chat", parent: CAT.chat, lang: "en", tier: "trader" },
  { name: "🟠・bitcoin", parent: CAT.chat, lang: "en", tier: "member" },
  { name: "💬・general", parent: CAT.chat, lang: "en", tier: "member" },
  { name: "🐸・memes", parent: CAT.chat, lang: "en", tier: "member" },
  { name: "🧵・forums", parent: CAT.chat, lang: "en", tier: "member" },
  { name: "🎙・Meeting Room", parent: CAT.chat, lang: "en", tier: "member" },
  { name: "📕・setup-guides", parent: CAT.edu, lang: "en", tier: "member" },
  { name: "📗・trading-strategies", parent: CAT.edu, lang: "en", tier: "member" },

  // 中文
  { name: "✅・验证", parent: CAT.zh, lang: "zh", tier: "verify", readOnly: true, create: { topic: "验证你的交易所 UID，解锁交易大厅" }, panel: "verify" },
  { name: "📢・公告", parent: CAT.zh, lang: "zh", tier: "free", readOnly: true },
  { name: "🔒・交易提醒", parent: CAT.zh, lang: "zh", tier: "teaser", readOnly: true, create: { topic: teaserTopic.zh }, mirror: { group: "trade-alerts-teaser", source: TEASER } },
  { name: "⚡・交易提醒", parent: CAT.zh, lang: "zh", tier: "member", readOnly: true },
  { name: "🔒・比特币", parent: CAT.zh, lang: "zh", tier: "teaser", readOnly: true, create: { topic: "仅限已验证会员。在这里验证 UID 即可解锁比特币频道" }, panel: "bitcoin" },
  { name: "☎️・帮助台", parent: CAT.zh, lang: "zh", tier: "free" },
  { name: "📈・交易者聊天", parent: CAT.zh, lang: "zh", tier: "trader" },
  { name: "🟠・比特币", parent: CAT.zh, lang: "zh", tier: "member" },
  { name: "💬・闲聊", parent: CAT.zh, lang: "zh", tier: "member" },

  // 한국어
  { name: "✅・인증", parent: CAT.ko, lang: "ko", tier: "verify", readOnly: true, create: { topic: "거래소 UID를 인증하고 트레이딩 플로어를 여세요" }, panel: "verify" },
  { name: "📢・공지사항", parent: CAT.ko, lang: "ko", tier: "free", readOnly: true },
  { name: "🔒・매매신호", parent: CAT.ko, lang: "ko", tier: "teaser", readOnly: true, create: { topic: teaserTopic.ko }, mirror: { group: "trade-alerts-teaser", source: TEASER } },
  { name: "⚡・매매신호", parent: CAT.ko, lang: "ko", tier: "member", readOnly: true },
  { name: "🔒・비트코인", parent: CAT.ko, lang: "ko", tier: "teaser", readOnly: true, create: { topic: "인증된 멤버 전용. 여기서 UID를 인증하면 비트코인 채널이 열립니다" }, panel: "bitcoin" },
  { name: "☎️・도움말", parent: CAT.ko, lang: "ko", tier: "free" },
  { name: "📈・트레이더-채팅", parent: CAT.ko, lang: "ko", tier: "trader" },
  { name: "🟠・비트코인", parent: CAT.ko, lang: "ko", tier: "member" },
  { name: "💬・자유채팅", parent: CAT.ko, lang: "ko", tier: "member" },

  // Bahasa Indonesia
  { name: "✅・verifikasi", parent: CAT.id, lang: "id", tier: "verify", readOnly: true, create: { topic: "Verifikasi UID exchange kamu untuk membuka Trading Floor" }, panel: "verify" },
  { name: "📢・pengumuman", parent: CAT.id, lang: "id", tier: "free", readOnly: true },
  { name: "🔒・sinyal-trading", parent: CAT.id, lang: "id", tier: "teaser", readOnly: true, create: { topic: teaserTopic.id }, mirror: { group: "trade-alerts-teaser", source: TEASER } },
  { name: "⚡・sinyal-trading", parent: CAT.id, lang: "id", tier: "member", readOnly: true },
  { name: "🔒・bitcoin", parent: CAT.id, lang: "id", tier: "teaser", readOnly: true, create: { topic: "Khusus member terverifikasi. Verifikasi UID di sini untuk membuka kanal Bitcoin" }, panel: "bitcoin" },
  { name: "☎️・bantuan", parent: CAT.id, lang: "id", tier: "free" },
  { name: "📈・obrolan-trader", parent: CAT.id, lang: "id", tier: "trader" },
  { name: "🟠・bitcoin", parent: CAT.id, lang: "id", tier: "member" },
  { name: "💬・obrolan-umum", parent: CAT.id, lang: "id", tier: "member" },
];

/** Categories get the union of their channels, so anything created in them later starts sensible. */
const CATEGORY_SPECS: { name: string; lang: Lang; tier: Tier }[] = [
  { name: CAT.alerts, lang: "en", tier: "free" },
  { name: CAT.chat, lang: "en", tier: "free" },
  { name: CAT.edu, lang: "en", tier: "member" },
  { name: CAT.zh, lang: "zh", tier: "free" },
  { name: CAT.ko, lang: "ko", tier: "free" },
  { name: CAT.id, lang: "id", tier: "free" },
];

/**
 * Roles whose ViewChannel the new tiers replace on the channels above. Their
 * other bits (a mute's send deny, say) are kept. Staff and bot roles are not
 * listed and keep their overwrites untouched.
 */
const REPLACED_ROLE_NAMES = ["Member", "Members", "New Member", "Muted Member"];

const BOT_ALLOW = [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.ManageMessages, P.ManageWebhooks, P.EmbedLinks, P.AttachFiles];

const TRANSLATE_PNG = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "emoji", "translate.png");

const STEPS = ["roles", "members", "channels", "perms", "mirror", "panels", "rules"] as const;
type Step = (typeof STEPS)[number];

interface Ctx {
  guild: Guild;
  db: Db;
  apply: boolean;
  role: (lang: Lang, tier: "base" | "member") => string | undefined;
}

const log = (s: string) => console.log(s);

function findChannel(guild: Guild, spec: { name: string; parent: string | null }) {
  const parentId = spec.parent ? guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name === spec.parent)?.id ?? "missing" : null;
  return guild.channels.cache.find(
    (c): c is NonThreadGuildBasedChannel => !c.isThread() && c.type !== ChannelType.GuildCategory && c.name === spec.name && (c.parentId ?? null) === parentId,
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

async function stepChannels(ctx: Ctx) {
  const { guild } = ctx;
  const me = guild.members.me ?? (await guild.members.fetchMe());
  for (const s of SPECS) {
    if (findChannel(guild, s)) continue;
    if (!s.create) {
      log(`  ! missing #${s.name}${s.parent ? ` in ${s.parent}` : ""} (not created by this script)`);
      continue;
    }
    log(`  create #${s.name}${s.parent ? ` in ${s.parent}` : ""}`);
    if (!ctx.apply) continue;
    const parent = s.parent ? guild.channels.cache.find((c): c is CategoryChannel => c.type === ChannelType.GuildCategory && c.name === s.parent) : undefined;
    // Born hidden; the perms step opens it to the right tier.
    await guild.channels.create({
      name: s.name,
      type: ChannelType.GuildText,
      parent: parent?.id,
      topic: s.create.topic,
      permissionOverwrites: [
        { id: guild.roles.everyone.id, deny: [P.ViewChannel] },
        { id: me.id, type: OverwriteType.Member, allow: BOT_ALLOW },
      ],
      reason: "onboarding",
    });
  }
  if (ctx.apply) await guild.channels.fetch();
  // The picker sits at the very top so a newcomer sees it first.
  const picker = findChannel(guild, SPECS[0]);
  if (picker && ctx.apply && "setPosition" in picker) await picker.setPosition(0).catch(() => {});
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
  for (const s of [...SPECS.slice(1), SPECS[0]]) {
    const ch = findChannel(guild, s);
    if (!ch) { log(`  ! skip #${s.name} (missing)`); continue; }
    const ows = overwritesFor(ctx, ch, s.lang, s.tier, !!s.readOnly);
    log(`  #${s.name} [${s.tier}] ${describe(guild, ows)}`);
    if (ctx.apply) await ch.permissionOverwrites.set(ows, "onboarding: language tiers");
  }
}

async function stepMirror(ctx: Ctx) {
  const { guild, db } = ctx;
  for (const s of SPECS.filter((x) => x.mirror)) {
    const ch = findChannel(guild, s);
    const source = guild.channels.cache.find((c) => c.name === s.mirror!.source && c.isTextBased());
    if (!ch || !source) { log(`  ! cannot link #${s.name} (${!ch ? "channel" : "source"} missing)`); continue; }
    log(`  link #${s.name} (${s.lang}) ← #${source.name} in group ${s.mirror!.group}`);
    if (!ctx.apply) continue;
    const groupId = (await db.findGroupByName(guild.id, s.mirror!.group)) ?? (await db.createGroup(guild.id, s.mirror!.group));
    await db.upsertMember({ channel_id: source.id, group_id: groupId, lang: "en", webhook_id: null, webhook_token: null });
    await db.upsertMember({ channel_id: ch.id, group_id: groupId, lang: s.lang as Lang, webhook_id: null, webhook_token: null });
  }
}

async function stepPanels(ctx: Ctx) {
  const { guild } = ctx;
  const me = guild.members.me!;
  for (const s of SPECS.filter((x) => x.panel)) {
    const ch = findChannel(guild, s) as TextChannel | undefined;
    if (!ch) { log(`  ! no #${s.name} for its panel`); continue; }
    log(`  post ${s.panel} panel in #${s.name}`);
    if (!ctx.apply) continue;
    const old = (await ch.messages.fetch({ limit: 50 })).filter((m) => m.author.id === me.id);
    for (const m of old.values()) await m.delete().catch(() => {});
    const lang = s.lang === "all" ? "en" : s.lang;
    if (s.panel === "picker") {
      const help = guild.channels.cache.find((c) => c.name === "☎️・help-desk");
      const emojis = await guild.emojis.fetch();
      let tr = emojis.find((e) => e.name === "translate");
      if (!tr) tr = await guild.emojis.create({ attachment: TRANSLATE_PNG, name: "translate", reason: "onboarding: language picker icon" });
      for (const msg of startHereMessages({ picker: true, translateEmoji: tr.toString(), helpDeskUrl: `https://discord.com/channels/${guild.id}/${help?.id ?? ""}` })) await ch.send(msg);
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
  const picker = findChannel(guild, SPECS[0]);
  if (!picker) { log("  ! picker channel missing"); return; }
  const old = guild.rulesChannelId && guild.rulesChannelId !== picker.id ? guild.channels.cache.get(guild.rulesChannelId) : undefined;
  if (guild.rulesChannelId !== picker.id) {
    log(`  rules channel: #${old?.name ?? "none"} → #${picker.name}`);
    if (ctx.apply) await guild.setRulesChannel(picker.id, "onboarding: the picker carries the rules");
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
    const run: Record<Step, (c: Ctx) => Promise<void>> = { roles: stepRoles, members: stepMembers, channels: stepChannels, perms: stepPerms, mirror: stepMirror, panels: stepPanels, rules: stepRules };
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
