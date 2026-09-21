import { PermissionFlagsBits, type Guild, type GuildMember } from "discord.js";
import { LANGS, type Lang } from "./config.js";
import type { Db } from "./db/index.js";
import { log, errInfo } from "./log.js";

/**
 * Language roles are owned by the bot. A member may hold exactly one, and only
 * while they hold a membership role. Discord cannot express "verified AND
 * language" in channel permissions, so this is what keeps the language
 * categories members-only.
 */
const REPLY: Record<Lang, { done: string; pending: string; notReady: string }> = {
  en: { done: "Done. You're on the English channels.", pending: "Done. You're on the English channels.", notReady: "English is always available." },
  zh: { done: "好了，你现在可以看到中文频道了。", pending: "已记住你的选择。完成会员验证后，中文频道会自动对你开放。", notReady: "中文频道还没准备好。" },
  ko: { done: "완료! 이제 한국어 채널이 보여요.", pending: "선택을 저장했어요. 멤버 인증이 끝나면 한국어 채널이 자동으로 열립니다.", notReady: "한국어 채널이 아직 준비되지 않았어요." },
  id: { done: "Beres. Kanal Bahasa Indonesia sekarang terbuka untukmu.", pending: "Pilihanmu disimpan. Begitu verifikasi member selesai, kanal Bahasa Indonesia otomatis terbuka.", notReady: "Kanal Bahasa Indonesia belum siap." },
};

export class LanguageRoles {
  private roleIds = new Map<Lang, string>();
  private memberRoleIds = new Set<string>();
  private loadedAt = 0;

  constructor(private guild: Guild, private db: Db) {}

  async load() {
    this.roleIds.clear();
    for (const lang of LANGS) {
      const id = await this.db.getSetting(this.guild.id, `role:${lang}`);
      if (id && this.guild.roles.cache.has(id)) this.roleIds.set(lang, id);
    }
    const names = ((await this.db.getSetting(this.guild.id, "member_roles")) ?? "Member,Members").split(",").map((s) => s.trim().toLowerCase());
    this.memberRoleIds = new Set(this.guild.roles.cache.filter((r) => names.includes(r.name.toLowerCase())).map((r) => r.id));
    this.loadedAt = Date.now();
  }

  private async ensureLoaded() {
    if (Date.now() - this.loadedAt > 60_000) await this.load();
  }

  isVerified(member: GuildMember) {
    return member.roles.cache.some((r) => this.memberRoleIds.has(r.id)) || member.permissions.has(PermissionFlagsBits.Administrator);
  }

  langOf(member: GuildMember): Lang | null {
    for (const [lang, id] of this.roleIds) if (member.roles.cache.has(id)) return lang;
    return null;
  }

  /**
   * Records the member's language choice and applies the role if they are
   * verified. Unverified members keep the preference; `applyPending` grants
   * the role once they are. Returns a confirmation in the chosen language.
   */
  async set(member: GuildMember, lang: Lang): Promise<string> {
    await this.ensureLoaded();
    await this.db.setLangPref(this.guild.id, member.id, lang);
    if (lang !== "en" && !this.roleIds.has(lang)) return REPLY[lang].notReady;
    const verified = this.isVerified(member);
    if (verified || lang === "en") await this.apply(member, lang);
    return verified || lang === "en" ? REPLY[lang].done : REPLY[lang].pending;
  }

  /** Puts the member on exactly the roles their language implies. */
  private async apply(member: GuildMember, lang: Lang) {
    const want = lang === "en" ? undefined : this.roleIds.get(lang);
    const remove = [...this.roleIds.values()].filter((id) => member.roles.cache.has(id) && id !== want);
    if (remove.length) await member.roles.remove(remove, "language change");
    if (want && !member.roles.cache.has(want)) await member.roles.add(want, "language choice");
  }

  /** Called when a member's roles change: grant a remembered language once they become verified. */
  async applyPending(member: GuildMember) {
    await this.ensureLoaded();
    if (!this.isVerified(member) || this.langOf(member)) return;
    const pref = await this.db.getLangPref(this.guild.id, member.id).catch(() => null);
    if (pref && pref !== "en" && this.roleIds.has(pref)) {
      await this.apply(member, pref);
      log.info("applied remembered language", { user: member.id, lang: pref });
    }
  }

  /** Removes language roles from anyone who is no longer a verified member. */
  async sweep() {
    await this.ensureLoaded();
    if (this.roleIds.size === 0 || this.memberRoleIds.size === 0) return;
    let removed = 0;
    // grant remembered choices to anyone verified since the last sweep
    for (const roleId of this.memberRoleIds) {
      const role = this.guild.roles.cache.get(roleId);
      if (!role) continue;
      for (const member of role.members.values()) if (!this.langOf(member)) await this.applyPending(member).catch(() => {});
    }
    for (const [lang, id] of this.roleIds) {
      const role = this.guild.roles.cache.get(id);
      if (!role) continue;
      for (const member of role.members.values()) {
        if (this.isVerified(member)) continue;
        await member.roles.remove(id, "membership lapsed").catch((e) => log.warn("role sweep failed", { user: member.id, lang, ...errInfo(e) }));
        removed++;
      }
    }
    if (removed) log.info("language roles removed from unverified members", { removed });
  }
}
