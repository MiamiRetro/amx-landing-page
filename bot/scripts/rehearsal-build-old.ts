/**
 * Rehearsal helper, TEST server only: rebuilds the live server's old layout
 * from a scripts/backup.ts snapshot of live: roles by name, then categories and
 * channels with their names, types, topics, order and permission overwrites
 * (role overwrites matched by role name; the live bot's own overwrite goes to
 * this bot). Tickets and server logs are skipped. No messages, no members.
 *
 *   railway run -e test -- env DISCORD_GUILD_ID=<test id> npx tsx scripts/rehearsal-build-old.ts --from backups/<live backup> [--apply]
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ChannelType, OverwriteType, type GuildChannelCreateOptions, type OverwriteResolvable } from "discord.js";
import { connect } from "../src/lib/client.js";

const LIVE = "935681399095169035";
const LIVE_BOT = "1546071825211985982";
const SKIP_CATEGORIES = ["Created Tickets", "Claimed Tickets", "Closed Tickets", "server logs"];
const TYPES: Record<string, ChannelType> = { GuildCategory: ChannelType.GuildCategory, GuildText: ChannelType.GuildText, GuildVoice: ChannelType.GuildVoice, GuildAnnouncement: ChannelType.GuildAnnouncement, GuildForum: ChannelType.GuildForum };

const i = process.argv.indexOf("--from");
const from = i >= 0 ? process.argv[i + 1] : undefined;
if (!from) throw new Error("--from <live backup dir> is required");
const apply = process.argv.includes("--apply");
type Ow = { id: string; type: "role" | "member"; allow: string; deny: string };
type Ch = { id: string; name: string; type: string; parentId: string | null; position?: number; topic?: string | null; rateLimitPerUser?: number; overwrites?: Ow[] };
const b = JSON.parse(readFileSync(join(from, "structure.json"), "utf8")) as { guild: { id: string }; roles: { id: string; name: string; managed?: boolean }[]; channels: Ch[] };

const { client, guild } = await connect();
try {
  if (guild.id === LIVE) throw new Error("refusing to run against the live server");
  if (b.guild.id !== LIVE) throw new Error("the backup is not of the live server");
  const me = guild.members.me ?? (await guild.members.fetchMe());
  const liveRole = new Map(b.roles.map((r) => [r.id, r]));
  const testRole = (liveId: string) => {
    if (liveId === b.guild.id) return guild.roles.everyone.id;
    const r = liveRole.get(liveId);
    return r ? guild.roles.cache.find((x) => x.name === r.name)?.id : undefined;
  };
  // Roles the overwrites name, by name; bot-managed roles can't be made, their overwrites are dropped.
  for (const r of b.roles) {
    if (r.id === b.guild.id || r.managed || guild.roles.cache.some((x) => x.name === r.name)) continue;
    console.log(`  create role ${r.name}`);
    if (apply) await guild.roles.create({ name: r.name, permissions: [], reason: "rehearsal: live roles" });
  }
  const ows = (list: Ow[] = []): OverwriteResolvable[] => list.flatMap((o) => {
    if (o.type === "member") return o.id === LIVE_BOT ? [{ id: me.id, type: OverwriteType.Member, allow: BigInt(o.allow), deny: BigInt(o.deny) }] : [];
    const id = testRole(o.id);
    return id ? [{ id, type: OverwriteType.Role, allow: BigInt(o.allow), deny: BigInt(o.deny) }] : [];
  });
  const cats = b.channels.filter((c) => c.type === "GuildCategory" && !SKIP_CATEGORIES.includes(c.name)).sort((x, y) => ((x as { rawPosition?: number }).rawPosition ?? x.position ?? 0) - ((y as { rawPosition?: number }).rawPosition ?? y.position ?? 0));
  const made = new Map<string, string>();
  for (const c of cats) {
    console.log(`  create category ${c.name}`);
    if (!apply) continue;
    const cat = await guild.channels.create({ name: c.name, type: ChannelType.GuildCategory, permissionOverwrites: ows(c.overwrites), reason: "rehearsal: live layout" });
    made.set(c.id, cat.id);
  }
  const skipCat = new Set(b.channels.filter((c) => c.type === "GuildCategory" && SKIP_CATEGORIES.includes(c.name)).map((c) => c.id));
  const chans = b.channels.filter((c) => c.type !== "GuildCategory" && !(c.parentId && skipCat.has(c.parentId)) && TYPES[c.type] !== undefined).sort((x, y) => ((x as { rawPosition?: number }).rawPosition ?? x.position ?? 0) - ((y as { rawPosition?: number }).rawPosition ?? y.position ?? 0));
  for (const c of chans) {
    console.log(`  create ${c.type} #${c.name}${c.parentId ? ` in ${b.channels.find((x) => x.id === c.parentId)?.name}` : ""}`);
    if (!apply) continue;
    const opts: GuildChannelCreateOptions = { name: c.name, type: TYPES[c.type] as never, permissionOverwrites: ows(c.overwrites), reason: "rehearsal: live layout" };
    if (c.parentId && made.get(c.parentId)) opts.parent = made.get(c.parentId);
    if (c.topic && TYPES[c.type] !== ChannelType.GuildVoice) opts.topic = c.topic;
    if (c.rateLimitPerUser) opts.rateLimitPerUser = c.rateLimitPerUser;
    await guild.channels.create(opts);
  }
  console.log(`${apply ? "built" : "would build"} ${cats.length} categories and ${chans.length} channels`);
} finally {
  await client.destroy();
}
