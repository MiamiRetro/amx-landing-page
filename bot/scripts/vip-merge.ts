/**
 * Retires the legacy VIPs role: every holder gets VIP 1 (or keeps a higher
 * tier), every VIP tier gets the channel rights VIPs had, then VIPs is deleted.
 *
 *   railway run npx tsx scripts/vip-merge.ts            # dry run, writes the backup
 *   railway run npx tsx scripts/vip-merge.ts --apply
 */
import { writeFileSync } from "node:fs";
import { PermissionsBitField } from "discord.js";
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

  for (const c of channels as any[]) {
    const o = c.permissionOverwrites.cache.get(old.id);
    const missing = new PermissionsBitField(o.allow.bitfield & ~c.permissionsFor(me).bitfield).toArray();
    console.log(`#${c.name}: copy ${o.allow.toArray().length} allows to the tiers${missing.length ? `; BOT LACKS ${missing.join(",")}` : ""}`);
    if (apply) for (const r of tiers) await c.permissionOverwrites.edit(r!.id, Object.fromEntries([...o.allow.toArray().map((p: string) => [p, true]), ...o.deny.toArray().map((p: string) => [p, false])]), { reason });
  }
  let give = 0;
  for (const m of old.members.values()) {
    if (tiers.some((r) => m.roles.cache.has(r!.id))) continue;
    give++;
    if (apply) await m.roles.add(tiers[0]!, reason);
  }
  console.log(`${apply ? "gave" : "would give"} VIP 1 to ${give} of ${old.members.size} holders`);
  if (apply) {
    await guild.members.fetch();
    const left = old.members.filter((m) => !tiers.some((r) => m.roles.cache.has(r!.id)));
    if (left.size) throw new Error(`${left.size} holders have no tier yet; VIPs not deleted`);
    await old.delete(reason);
    console.log("VIPs deleted");
  }
} finally { await client.destroy(); }
