/**
 * Undo for the onboarding migration: puts a server back to how a
 * scripts/backup.ts snapshot recorded it.
 *
 *   npx tsx scripts/restore.ts --backup backups/<dir>            # dry run: prints every change
 *   npx tsx scripts/restore.ts --backup backups/<dir> --apply
 *
 * What it does:
 *   - categories and channels in the backup get their old name, category,
 *     position, topic, slowmode and permission overwrites back; ones the
 *     migration deleted are recreated empty (Discord kept no messages)
 *   - channels made after the backup are hidden in a staff-only
 *     "🗄️ ROLLBACK" category, not deleted, so anything posted in them stays
 *   - members get back exactly the language and notification roles they held
 *     in the backup; their other roles are left alone
 *
 * Every step is idempotent: run it again after a failure.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ChannelType,
  OverwriteType,
  PermissionFlagsBits as P,
  type CategoryChannel,
  type GuildBasedChannel,
  type OverwriteResolvable,
} from "discord.js";
import { LANGS } from "../src/config.js";
import { connect } from "../src/lib/client.js";
import { NOTIFY_ROLES, NOTIFY_TOPICS } from "../src/notify.js";
import { LANG_ROLE_NAMES } from "../src/roles.js";

interface BackupOverwrite { id: string; type: "role" | "member"; allow: string; deny: string }
interface BackupChannel {
  id: string; name: string; type: string; parentId: string | null; position?: number;
  topic?: string | null; rateLimitPerUser?: number; overwrites?: BackupOverwrite[];
}
interface Backup {
  guild: { id: string; rulesChannelId: string | null };
  roles: { id: string; name: string }[];
  channels: BackupChannel[];
  memberRoles: { id: string; roles: string[] }[] | null;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : undefined;
}

const log = (s: string) => console.log(s);
const ROLLBACK_CAT = "🗄️ ROLLBACK";
const TYPES: Record<string, ChannelType> = {
  GuildCategory: ChannelType.GuildCategory, GuildText: ChannelType.GuildText, GuildVoice: ChannelType.GuildVoice,
  GuildAnnouncement: ChannelType.GuildAnnouncement, GuildForum: ChannelType.GuildForum, GuildStageVoice: ChannelType.GuildStageVoice,
};

function sameOverwrites(ch: GuildBasedChannel, want: BackupOverwrite[]) {
  if (!("permissionOverwrites" in ch)) return true;
  const have = ch.permissionOverwrites.cache;
  if (have.size !== want.length) return false;
  return want.every((w) => {
    const o = have.get(w.id);
    return !!o && o.allow.bitfield.toString() === w.allow && o.deny.bitfield.toString() === w.deny;
  });
}

async function main() {
  const dir = arg("backup");
  if (!dir) throw new Error("--backup <folder from scripts/backup.ts> is required");
  const apply = process.argv.includes("--apply");
  const backup = JSON.parse(readFileSync(join(dir, "structure.json"), "utf8")) as Backup;
  const { client, guild } = await connect();
  try {
    if (backup.guild.id !== guild.id) throw new Error(`backup is of server ${backup.guild.id}, connected to ${guild.id}`);
    log(`${apply ? "APPLYING" : "DRY RUN (add --apply to make these changes)"} on ${guild.name}, from ${dir}`);
    // Deleted categories and channels come back with new ids.
    const idMap = new Map<string, string>();
    const resolve = (id: string | null) => (id ? idMap.get(id) ?? id : null);
    const overwritesOf = (c: BackupChannel): OverwriteResolvable[] =>
      (c.overwrites ?? [])
        .filter((o) => o.type === "member" || guild.roles.cache.has(o.id))
        .map((o) => ({ id: o.id, type: o.type === "role" ? OverwriteType.Role : OverwriteType.Member, allow: BigInt(o.allow), deny: BigInt(o.deny) }));

    log(`\n== categories`);
    const cats = backup.channels.filter((c) => c.type === "GuildCategory");
    for (const c of cats) await restoreChannel(c);

    log(`\n== channels`);
    for (const c of backup.channels.filter((c) => c.type !== "GuildCategory")) await restoreChannel(c);

    async function restoreChannel(c: BackupChannel) {
      let ch = guild.channels.cache.get(c.id);
      if (!ch) {
        log(`  recreate ${c.type === "GuildCategory" ? "category " : "#"}${c.name} (deleted; comes back empty)`);
        if (!apply) return;
        const parent = resolve(c.parentId);
        const made: GuildBasedChannel = await guild.channels.create({
          name: c.name,
          type: TYPES[c.type] as never,
          parent: parent && guild.channels.cache.has(parent) ? parent : undefined,
          topic: c.topic ?? undefined,
          permissionOverwrites: overwritesOf(c),
          reason: "rollback: recreated from backup",
        } as never);
        idMap.set(c.id, made.id);
        return;
      }
      if (ch.isThread()) return;
      const changes: string[] = [];
      if (ch.name !== c.name) changes.push(`rename → ${c.name}`);
      const parent = resolve(c.parentId);
      if (c.type !== "GuildCategory" && (ch.parentId ?? null) !== parent) changes.push(`move → ${c.parentId ? cats.find((x) => x.id === c.parentId)?.name ?? parent : "top"}`);
      if ("topic" in ch && c.topic !== undefined && (ch.topic ?? null) !== (c.topic ?? null)) changes.push("topic");
      if ("rateLimitPerUser" in ch && c.rateLimitPerUser !== undefined && (ch.rateLimitPerUser ?? 0) !== c.rateLimitPerUser) changes.push("slowmode");
      const perms = !sameOverwrites(ch, c.overwrites ?? []);
      if (perms) changes.push("permissions");
      if (!changes.length) return;
      log(`  ${ch.name}: ${changes.join(", ")}`);
      if (!apply) return;
      if (c.type !== "GuildCategory" && (ch.parentId ?? null) !== parent) await ch.setParent(parent, { lockPermissions: false, reason: "rollback" });
      await ch.edit({
        name: c.name,
        ...("topic" in ch && c.topic !== undefined ? { topic: c.topic } : {}),
        ...("rateLimitPerUser" in ch && c.rateLimitPerUser !== undefined ? { rateLimitPerUser: c.rateLimitPerUser } : {}),
        ...(perms ? { permissionOverwrites: overwritesOf(c) } : {}),
        reason: "rollback",
      } as never);
    }

    log(`\n== positions`);
    const ordered = backup.channels.filter((c) => c.position !== undefined).map((c) => ({ channel: resolve(c.id)!, position: c.position! }));
    const off = ordered.filter((o) => { const ch = guild.channels.cache.get(o.channel); return ch && "position" in ch && ch.position !== o.position; });
    log(`  ${off.length} out of place`);
    if (apply && off.length) await guild.channels.setPositions(ordered.filter((o) => guild.channels.cache.has(o.channel)));

    log(`\n== channels made after the backup`);
    const known = new Set(backup.channels.map((c) => resolve(c.id)));
    const extra = guild.channels.cache.filter((c) => !c.isThread() && !known.has(c.id) && c.name !== ROLLBACK_CAT);
    let rollbackCat = guild.channels.cache.find((c): c is CategoryChannel => c.type === ChannelType.GuildCategory && c.name === ROLLBACK_CAT);
    for (const ch of extra.values()) {
      if (ch.isThread()) continue;
      if (ch.type === ChannelType.GuildCategory) {
        const left = guild.channels.cache.filter((c) => c.parentId === ch.id && !extra.has(c.id));
        log(`  ${left.size ? "keep" : "delete empty"} category ${ch.name}`);
        continue;
      }
      if (rollbackCat && ch.parentId === rollbackCat.id) continue;
      log(`  hide #${ch.name} in ${ROLLBACK_CAT}`);
      if (!apply) continue;
      rollbackCat ??= await guild.channels.create({
        name: ROLLBACK_CAT, type: ChannelType.GuildCategory, position: 999,
        permissionOverwrites: [
          { id: guild.roles.everyone.id, deny: [P.ViewChannel] },
          { id: guild.members.me!.id, type: OverwriteType.Member, allow: [P.ViewChannel, P.ManageChannels] },
        ],
        reason: "rollback",
      });
      await ch.setParent(rollbackCat.id, { lockPermissions: true, reason: "rollback: made by the migration" });
    }
    // Emptied new categories go once their channels are hidden.
    if (apply) {
      await guild.channels.fetch();
      for (const ch of extra.filter((c) => c.type === ChannelType.GuildCategory).values()) {
        if (!guild.channels.cache.some((c) => c.parentId === ch.id)) await ch.delete("rollback: made by the migration, now empty");
      }
    }

    log(`\n== member roles`);
    if (!backup.memberRoles) { log("  ! the backup has no member roles; skipped"); return; }
    const tracked = new Set(
      [...LANGS.flatMap((l) => [LANG_ROLE_NAMES[l].base, LANG_ROLE_NAMES[l].member]), ...NOTIFY_TOPICS.map((t) => NOTIFY_ROLES[t].name)]
        .map((n) => guild.roles.cache.find((r) => r.name === n)?.id)
        .filter((x): x is string => !!x),
    );
    const before = new Map(backup.memberRoles.map((m) => [m.id, new Set(m.roles.filter((r) => tracked.has(r)))]));
    const members = await guild.members.fetch();
    let changed = 0;
    for (const m of members.values()) {
      if (m.user.bot) continue;
      const want = before.get(m.id) ?? new Set<string>();
      const add = [...want].filter((r) => !m.roles.cache.has(r));
      const remove = [...tracked].filter((r) => !want.has(r) && m.roles.cache.has(r));
      if (!add.length && !remove.length) continue;
      changed++;
      if (!apply) continue;
      if (remove.length) await m.roles.remove(remove, "rollback");
      if (add.length) await m.roles.add(add, "rollback");
      if (changed % 50 === 0) log(`  ...${changed} members`);
    }
    log(`  ${changed} members ${apply ? "restored" : "would change"}`);
  } finally {
    await client.destroy();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });
