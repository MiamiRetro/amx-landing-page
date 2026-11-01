/**
 * Retires the legacy VIPs role: every holder gets VIP 1 (or keeps a higher
 * tier), every VIP tier gets the channel rights VIPs had, then VIPs is deleted.
 *
 *   railway run npx tsx scripts/vip-merge.ts            # dry run, writes the backup
 *   railway run npx tsx scripts/vip-merge.ts --apply
 */
import { writeFileSync } from "node:fs";
import { PermissionsBitField, type GuildMember, type Role } from "discord.js";
import { connect } from "../src/lib/client.js";

const apply = process.argv.includes("--apply");
const TIERS = ["VIP 1", "VIP 2", "VIP 3", "VIP 4"];
const reason = "Retire the legacy VIPs role";
const { client, guild } = await connect();
try {
  await guild.roles.fetch();
  await guild.members.fetch();
  const old = guild.roles.cache.find((r) => r.name === "VIPs");
  if (!old) throw new Error("no VIPs role: already retired?");
  const tiers = TIERS.map((n) => guild.roles.cache.find((r) => r.name === n));
  if (tiers.some((r) => !r)) throw new Error("a VIP tier role is missing");
  const channels = [...guild.channels.cache.values()].filter((c) => !c.isThread() && "permissionOverwrites" in c && c.permissionOverwrites.cache.has(old.id));
  const backup = {
    at: new Date().toISOString(),
    role: { id: old.id, name: old.name, color: old.color, hoist: old.hoist, position: old.position, mentionable: old.mentionable, icon: old.icon, permissions: String(old.permissions.bitfield) },
    tiers: tiers.map((r) => ({ id: r!.id, name: r!.name, color: r!.color, hoist: r!.hoist, position: r!.position, members: r!.members.size })),
    holders: old.members.map((m) => ({ id: m.id, tag: m.user.tag })),
    overwrites: channels.map((c: any) => ({ channel: c.id, name: c.name, allow: String(c.permissionOverwrites.cache.get(old.id).allow.bitfield), deny: String(c.permissionOverwrites.cache.get(old.id).deny.bitfield) })),
  };
  writeFileSync(`backups/live-pre-vip-merge-${backup.at.slice(0, 10)}.json`, JSON.stringify(backup, null, 2));
  console.log(`VIPs: ${old.members.size} holders, colour ${old.hexColor}, hoist ${old.hoist}, position ${old.position}, icon ${!!old.icon}`);
  for (const r of tiers) console.log(`${r!.name}: colour ${r!.hexColor}, hoist ${r!.hoist}, position ${r!.position}, ${r!.members.size} members`);
  const me = guild.members.me!;
  console.log(`bot: Administrator ${me.permissions.has("Administrator")}, ManageRoles ${me.permissions.has("ManageRoles")}, top position ${me.roles.highest.position}`);

  // A bot can only set overwrites it holds itself, so anything else stays out; the check below says if that costs a VIP anything.
  for (const c of channels as any[]) {
    const o = c.permissionOverwrites.cache.get(old.id);
    const held = c.permissionsFor(me).bitfield;
    const missing = new PermissionsBitField(o.allow.bitfield & ~held).toArray();
    const allow = new PermissionsBitField(o.allow.bitfield & held).toArray();
    console.log(`#${c.name}: copy ${allow.length} allows to the tiers${missing.length ? `; skipped, bot lacks: ${missing.join(",")}` : ""}`);
    if (apply) for (const r of tiers) await c.permissionOverwrites.edit(r!.id, Object.fromEntries(allow.map((p: string) => [p, true])), { reason });
  }
  let give = 0;
  for (const m of old.members.values()) {
    if (tiers.some((r) => m.roles.cache.has(r!.id))) continue;
    give++;
    if (apply) await m.roles.add(tiers[0]!, reason);
  }
  console.log(`${apply ? "gave" : "would give"} VIP 1 to ${give} of ${old.members.size} holders`);
  // What each holder keeps in these channels with VIP 1 in place of VIPs.
  const effective = (m: GuildMember, c: any, roles: Role[]) => {
    const ow = c.permissionOverwrites.cache;
    let p = roles.reduce((a, r) => a | r.permissions.bitfield, guild.roles.everyone.permissions.bitfield);
    const e = ow.get(guild.id);
    if (e) p = (p & ~e.deny.bitfield) | e.allow.bitfield;
    let a = 0n, d = 0n;
    for (const r of roles) { const o = ow.get(r.id); if (o) { a |= o.allow.bitfield; d |= o.deny.bitfield; } }
    p = (p & ~d) | a;
    const u = ow.get(m.id);
    if (u) p = (p & ~u.deny.bitfield) | u.allow.bitfield;
    return p;
  };
  await guild.channels.fetch();
  const lost = new Map<string, number>();
  for (const c of channels as any[]) {
    const fresh: any = guild.channels.cache.get(c.id);
    for (const m of old.members.values()) {
      const rest = [...m.roles.cache.values()].filter((r) => r.id !== old.id && r.id !== guild.id);
      const after = rest.some((r) => tiers.some((t) => t!.id === r.id)) ? rest : [...rest, tiers[0]!];
      const gone = effective(m, fresh, [...m.roles.cache.values()].filter((r) => r.id !== guild.id)) & ~effective(m, fresh, after);
      for (const p of new PermissionsBitField(gone).toArray()) lost.set(`#${fresh.name} ${p}`, (lost.get(`#${fresh.name} ${p}`) ?? 0) + 1);
    }
  }
  console.log(lost.size ? `holders would lose: ${[...lost].map(([k, n]) => `${k} (${n})`).join(", ")}` : "no holder loses anything in these channels");
  const CORE = /ViewChannel|SendMessages|ReadMessageHistory|EmbedLinks|AttachFiles|AddReactions/;
  if (apply && [...lost.keys()].some((k) => CORE.test(k))) throw new Error("holders would lose core access; VIPs not deleted");
  if (apply) {
    await guild.members.fetch();
    const left = old.members.filter((m) => !tiers.some((r) => m.roles.cache.has(r!.id)));
    if (left.size) throw new Error(`${left.size} holders have no tier yet; VIPs not deleted`);
    await old.delete(reason);
    console.log("VIPs deleted");
  }
} finally { await client.destroy(); }
