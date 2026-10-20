import { PermissionFlagsBits, type Guild, type GuildMember } from "discord.js";
import { LANGS, type Lang } from "./config.js";
import type { Db } from "./db/index.js";
import type { Funnel } from "./funnel.js";
import { log, errInfo } from "./log.js";

/**
 * Onboarding runs on two bot-owned roles per language:
 *
 *   picked a language (accepted the rules)  →  the language role, e.g. "中文"
 *   verified a UID as well                  →  the language member role, e.g. "中文 Member"
 *
 * A member holds exactly one of the eight. Discord cannot express "verified AND
 * 中文" in channel permissions, so the bot keeps the pair honest instead: the
 * membership role (Member/Members) decides the tier, the language decides which
 * of the pair. Every channel then needs one allow per tier, the verify channel
 * hides itself once the swap happens, and the picker hides behind any of them.
 *
 * The choice is final for the member. Only a moderator can move someone to
 * another language, with `/language`.
 */
export interface LangRolePair {
  base: string;
  member: string;
}

/** Role names the layout creates. Settings `role:<lang>` / `mrole:<lang>` override them by id. */
export const LANG_ROLE_NAMES: Record<Lang, { base: string; member: string }> = {
  en: { base: "English", member: "English Member" },
  zh: { base: "中文", member: "中文 Member" },
  ko: { base: "한국어", member: "한국어 Member" },
  id: { base: "Bahasa Indonesia", member: "Bahasa Indonesia Member" },
  vi: { base: "Tiếng Việt", member: "Tiếng Việt Member" },
  es: { base: "Español", member: "Español Member" },
  pt: { base: "Português", member: "Português Member" },
  tr: { base: "Türkçe", member: "Türkçe Member" },
  ru: { base: "Русский", member: "Русский Member" },
  ja: { base: "日本語", member: "日本語 Member" },
};

const REPLY: Record<Lang, { base: string; member: string; locked: string }> = {
  en: {
    base: "Welcome. Your English channels are open. Press “Verify my UID” in any 🔒 channel to unlock the full Trading Floor.",
    member: "Welcome back. Your English channels are open.",
    locked: "Your language is already set. Ask a moderator in help-desk if you need it changed.",
  },
  zh: {
    base: "欢迎！中文频道已经为你开放。在任意 🔒 频道点击「验证我的 UID」，即可解锁完整的交易大厅。",
    member: "欢迎回来，中文频道已经为你开放。",
    locked: "你的语言已经设置好了。如需更改，请在帮助台联系管理员。",
  },
  ko: {
    base: "환영합니다! 한국어 채널이 열렸어요. 🔒 채널에서 「내 UID 인증하기」를 누르면 트레이딩 플로어 전체가 열립니다.",
    member: "다시 오신 걸 환영해요. 한국어 채널이 열렸어요.",
    locked: "언어가 이미 설정되어 있어요. 변경이 필요하면 도움말 채널에서 운영진에게 문의해 주세요.",
  },
  id: {
    base: "Selamat datang! Kanal Bahasa Indonesia sudah terbuka. Tekan “Verifikasi UID saya” di kanal 🔒 mana pun untuk membuka seluruh Trading Floor.",
    member: "Selamat datang kembali. Kanal Bahasa Indonesia sudah terbuka.",
    locked: "Bahasamu sudah diatur. Minta moderator di kanal bantuan kalau perlu diganti.",
  },
  vi: {
    base: "Chào mừng! Các kênh tiếng Việt đã mở cho bạn. Bấm “Xác minh UID” trong bất kỳ kênh 🔒 nào để mở toàn bộ Trading Floor.",
    member: "Chào mừng bạn quay lại. Các kênh tiếng Việt đã mở cho bạn.",
    locked: "Ngôn ngữ của bạn đã được chọn. Nhờ quản trị viên trong kênh hỗ trợ nếu cần đổi.",
  },
  es: {
    base: "¡Bienvenido! Tus canales en español ya están abiertos. Pulsa «Verificar mi UID» en cualquier canal 🔒 para desbloquear todo el Trading Floor.",
    member: "Bienvenido de nuevo. Tus canales en español ya están abiertos.",
    locked: "Tu idioma ya está elegido. Pide a un moderador en el canal de ayuda si necesitas cambiarlo.",
  },
  pt: {
    base: "Bem-vindo! Seus canais em português já estão abertos. Toque em “Verificar meu UID” em qualquer canal 🔒 para liberar todo o Trading Floor.",
    member: "Bem-vindo de volta. Seus canais em português já estão abertos.",
    locked: "Seu idioma já foi escolhido. Peça a um moderador no canal de ajuda se precisar mudar.",
  },
  tr: {
    base: "Hoş geldin! Türkçe kanalların açıldı. Tüm Trading Floor'u açmak için herhangi bir 🔒 kanalında “UID'mi doğrula”ya bas.",
    member: "Tekrar hoş geldin. Türkçe kanalların açıldı.",
    locked: "Dilin zaten seçildi. Değiştirmen gerekirse yardım kanalında bir moderatöre sor.",
  },
  ru: {
    base: "Добро пожаловать! Русские каналы открыты. Нажмите «Подтвердить UID» в любом 🔒 канале, чтобы открыть весь Trading Floor.",
    member: "С возвращением. Русские каналы открыты.",
    locked: "Язык уже выбран. Если нужно сменить, обратитесь к модератору в канале помощи.",
  },
  ja: {
    base: "ようこそ！日本語チャンネルが開きました。🔒 チャンネルの「UIDを認証する」を押すと、Trading Floor 全体が開きます。",
    member: "おかえりなさい。日本語チャンネルが開きました。",
    locked: "言語はすでに設定されています。変更が必要な場合はヘルプチャンネルでモデレーターに伝えてください。",
  },
};

export class LanguageRoles {
  private pairs = new Map<Lang, LangRolePair>();
  private memberRoleIds = new Set<string>();
  private loadedAt = 0;

  constructor(private guild: Guild, private db: Db, private funnel?: Funnel) {}

  async load() {
    this.pairs.clear();
    const byName = (name: string) => this.guild.roles.cache.find((r) => r.name === name)?.id;
    for (const lang of LANGS) {
      const base = (await this.db.getSetting(this.guild.id, `role:${lang}`)) ?? byName(LANG_ROLE_NAMES[lang].base);
      const member = (await this.db.getSetting(this.guild.id, `mrole:${lang}`)) ?? byName(LANG_ROLE_NAMES[lang].member);
      if (base && member && this.guild.roles.cache.has(base) && this.guild.roles.cache.has(member)) this.pairs.set(lang, { base, member });
    }
    const names = ((await this.db.getSetting(this.guild.id, "member_roles")) ?? "Member,Members").split(",").map((s) => s.trim().toLowerCase());
    this.memberRoleIds = new Set(this.guild.roles.cache.filter((r) => names.includes(r.name.toLowerCase())).map((r) => r.id));
    this.loadedAt = Date.now();
  }

  private async ensureLoaded() {
    if (Date.now() - this.loadedAt > 60_000) await this.load();
  }

  /** The role granted on UID verification: the first configured membership role. */
  memberRoleId(): string | null {
    return [...this.memberRoleIds][0] ?? null;
  }

  isVerified(member: GuildMember) {
    return member.roles.cache.some((r) => this.memberRoleIds.has(r.id)) || member.permissions.has(PermissionFlagsBits.Administrator);
  }

  /** Holds a membership role itself, ignoring Administrator. Admins are not moved between tiers. */
  private holdsMembership(member: GuildMember) {
    return member.roles.cache.some((r) => this.memberRoleIds.has(r.id));
  }

  langOf(member: GuildMember): Lang | null {
    for (const [lang, p] of this.pairs) if (member.roles.cache.has(p.base) || member.roles.cache.has(p.member)) return lang;
    return null;
  }

  /** Every language role id, both tiers. The picker channel denies view to all of them. */
  allRoleIds(): string[] {
    return [...this.pairs.values()].flatMap((p) => [p.base, p.member]);
  }

  /**
   * The member's own pick from the picker. Refused once they have a language,
   * so the choice cannot be changed without a moderator.
   */
  async pick(member: GuildMember, lang: Lang): Promise<string> {
    await this.ensureLoaded();
    if (!this.pairs.has(lang)) return "This language is not available yet.";
    const current = this.langOf(member);
    if (current) return REPLY[current].locked;
    await this.db.setLangPref(this.guild.id, member.id, lang);
    await this.apply(member, lang);
    log.info("language picked", { user: member.id, lang });
    this.funnel?.record(member.id, "language_picked", { lang });
    return this.holdsMembership(member) ? REPLY[lang].member : REPLY[lang].base;
  }

  /** A moderator moving a member to another language. */
  async assign(member: GuildMember, lang: Lang): Promise<string> {
    await this.ensureLoaded();
    if (!this.pairs.has(lang)) return "That language has no roles set up yet.";
    await this.db.setLangPref(this.guild.id, member.id, lang);
    await this.apply(member, lang);
    this.funnel?.record(member.id, "language_changed_by_mod", { lang });
    return `${member.displayName} is now on ${LANG_ROLE_NAMES[lang].base}${this.holdsMembership(member) ? " (verified)" : ""}.`;
  }

  /** Puts the member on exactly one language role: the pair for `lang`, at the tier their membership implies. */
  private async apply(member: GuildMember, lang: Lang) {
    const pair = this.pairs.get(lang);
    if (!pair) return;
    const want = this.holdsMembership(member) ? pair.member : pair.base;
    const remove = this.allRoleIds().filter((id) => id !== want && member.roles.cache.has(id));
    if (remove.length) await member.roles.remove(remove, "language tier");
    if (!member.roles.cache.has(want)) await member.roles.add(want, "language tier");
  }

  /**
   * Moves a member to the right tier of their language after their roles
   * change: verification (or a moderator granting Member) swaps "中文" for
   * "中文 Member", losing membership swaps it back.
   */
  async sync(member: GuildMember): Promise<boolean> {
    await this.ensureLoaded();
    const lang = this.langOf(member);
    if (!lang) return false;
    const pair = this.pairs.get(lang)!;
    const want = this.holdsMembership(member) ? pair.member : pair.base;
    const stray = this.allRoleIds().some((id) => id !== want && member.roles.cache.has(id));
    if (!member.roles.cache.has(want) || stray) {
      await this.apply(member, lang);
      log.info("language tier synced", { user: member.id, lang, tier: want === pair.member ? "member" : "base" });
      return true;
    }
    return false;
  }

  /** Re-checks everyone holding a language role. Catches changes made while the bot was offline. */
  async sweep() {
    await this.ensureLoaded();
    if (this.pairs.size === 0) return;
    const members = await this.guild.members.fetch();
    let fixed = 0;
    for (const m of members.values()) {
      if (m.user.bot || !this.langOf(m)) continue;
      if (await this.sync(m).catch((e) => (log.warn("language sweep failed", { user: m.id, ...errInfo(e) }), false))) fixed++;
    }
    if (fixed) log.info("language sweep fixed members", { fixed });
  }
}
