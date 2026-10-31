/**
 * Rehearsal helper, TEST server only: moves every channel out of the way so
 * the live layout can be rebuilt next to it. Each channel is renamed
 * "zz・<name>" and put in a hidden "🅿️ PARKED" category (permissions synced to
 * it); categories are renamed "zz <name>". Nothing is deleted. The rules and
 * community-updates channels are only renamed, as Discord needs them public.
 *
 * Only channels in the given backup of the test server are touched.
 *
 *   railway run -e test -- env DISCORD_GUILD_ID=<test id> npx tsx scripts/rehearsal-park.ts --backup backups/<test backup> [--apply]
 */
import { ChannelType, PermissionFlagsBits as P, type CategoryChannel } from "discord.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { connect } from "../src/lib/client.js";

const LIVE = "935681399095169035";
const PARKED = "🅿️ PARKED";
const apply = process.argv.includes("--apply");
const bi = process.argv.indexOf("--backup");
if (bi < 0) throw new Error("--backup <test backup dir> is required");
const known = new Set((JSON.parse(readFileSync(join(process.argv[bi + 1], "structure.json"), "utf8")) as { channels: { id: string }[] }).channels.map((c) => c.id));
const { client, guild } = await connect();
try {
  if (guild.id === LIVE) throw new Error("refusing to run against the live server");
  const keep = new Set([guild.rulesChannelId, guild.publicUpdatesChannelId, guild.safetyAlertsChannelId].filter(Boolean));
  // A category holds at most 50 channels: "🅿️ PARKED", "🅿️ PARKED 2", ...
  const parkedCats = () => guild.channels.cache.filter((c): c is CategoryChannel => c.type === ChannelType.GuildCategory && c.name.startsWith(PARKED));
  const parkIn = async () => {
    const free = parkedCats().find((c) => c.children.cache.size < 50);
    if (free) return free;
    const n = parkedCats().size;
    return guild.channels.create({ name: n ? `${PARKED} ${n + 1}` : PARKED, type: ChannelType.GuildCategory, position: 999, permissionOverwrites: [{ id: guild.roles.everyone.id, deny: [P.ViewChannel] }] });
  };
  let n = 0;
  for (const ch of guild.channels.cache.values()) {
    if (ch.isThread() || !known.has(ch.id) || (ch.name.startsWith("zz") && (ch.type === ChannelType.GuildCategory || keep.has(ch.id) || ch.parent?.name.startsWith(PARKED)))) continue;
    const base = ch.name.replace(/^zz・/, "");
    const name = ch.type === ChannelType.GuildCategory ? `zz ${ch.name}` : `zz・${base}`;
    n++;
    if (!apply) { console.log(`  park ${ch.name}`); continue; }
    try {
      // Rules and community-updates channels must stay public: renamed only, so the rebuilt layout's own take over.
      if (ch.type === ChannelType.GuildCategory || keep.has(ch.id)) await ch.setName(name.slice(0, 100), "rehearsal: parked");
      else await ch.edit({ name: name.slice(0, 100), parent: (await parkIn()).id, lockPermissions: true, reason: "rehearsal: parked" });
    } catch (e) {
      console.log(`  ! #${ch.name}: ${(e as { rawError?: unknown }).rawError ? JSON.stringify((e as { rawError: unknown }).rawError).slice(0, 300) : e}`);
    }
  }
  console.log(`${apply ? "parked" : "would park"} ${n} channels; kept ${[...keep].map((id) => guild.channels.cache.get(id!)?.name).join(", ")}`);
} finally {
  await client.destroy();
}
