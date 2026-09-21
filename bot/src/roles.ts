import { PermissionFlagsBits, type Guild, type GuildMember } from "discord.js";
import { LANG_NAMES, LANGS, type Lang } from "./config.js";
import type { Db } from "./db/index.js";
import { log, errInfo } from "./log.js";

/**
 * Language roles are owned by the bot. A member may hold exactly one, and only
 * while they hold a membership role. Discord cannot express "verified AND
 * language" in channel permissions, so this is what keeps the language
 * categories members-only.
 */
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

  /** Sets the member's language (or clears it with null). Returns a user-facing message. */
  async set(member: GuildMember, lang: Lang | null): Promise<string> {
    await this.ensureLoaded();
    if (lang && !this.roleIds.has(lang)) return `The ${LANG_NAMES[lang]} channels are not set up yet.`;
    if (lang && lang !== "en" && !this.isVerified(member)) return "Language channels are for verified members. Finish verification first, then run this again.";
    const remove = [...this.roleIds.values()].filter((id) => member.roles.cache.has(id) && id !== (lang ? this.roleIds.get(lang) : undefined));
    if (remove.length) await member.roles.remove(remove, "language change");
    if (lang && lang !== "en") await member.roles.add(this.roleIds.get(lang)!, "language choice");
    return lang && lang !== "en" ? `Done. You now see the ${LANG_NAMES[lang]} channels.` : "Done. You are back on the English channels only.";
  }

  /** Removes language roles from anyone who is no longer a verified member. */
  async sweep() {
    await this.ensureLoaded();
    if (this.roleIds.size === 0 || this.memberRoleIds.size === 0) return;
    let removed = 0;
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
