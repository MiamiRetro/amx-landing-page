/**
 * Full structural backup of a server, taken before any migration or cleanup.
 * Read-only: it never changes anything in Discord.
 *
 *   npx tsx scripts/backup.ts                                  # structure only
 *   npx tsx scripts/backup.ts --messages "#language-test,1234" # plus full message history of those channels
 *   npx tsx scripts/backup.ts --out backups/live-2026-10-27
 *
 * Writes into the --out folder (default backups/<server>-<timestamp>):
 *   structure.json   every role (permissions, colour, position, flags), every
 *                    category and channel with its full permission overwrites,
 *                    topic, slowmode and position, plus each member's roles
 *   messages/<channel id>.jsonl and attachments/, for each --messages channel
 *                    (threads and forum posts included)
 *   SUMMARY.md       a readable overview
 *
 * Enough to put names, positions, permissions and member roles back by hand
 * or by script. Discord keeps no copy of deleted messages, so export a channel
 * with --messages before deleting it.
 */
import { mkdirSync, writeFileSync, createWriteStream } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  ChannelType,
  type AnyThreadChannel,
  type Guild,
  type GuildBasedChannel,
  type Message,
} from "discord.js";
import { connect } from "../src/lib/client.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : undefined;
}

function channelRecord(c: GuildBasedChannel) {
  const base: Record<string, unknown> = {
    id: c.id,
    name: c.name,
    type: ChannelType[c.type],
    parentId: c.parentId ?? null,
  };
  if ("position" in c) base.position = c.position;
  if ("rawPosition" in c) base.rawPosition = c.rawPosition;
  if ("topic" in c) base.topic = c.topic ?? null;
  if ("nsfw" in c) base.nsfw = c.nsfw;
  if ("rateLimitPerUser" in c) base.rateLimitPerUser = c.rateLimitPerUser ?? 0;
  if ("permissionOverwrites" in c) {
    base.overwrites = [...c.permissionOverwrites.cache.values()].map((o) => ({
      id: o.id,
      type: o.type === 0 ? "role" : "member",
      name: o.type === 0 ? c.guild.roles.cache.get(o.id)?.name ?? null : null,
      allow: o.allow.bitfield.toString(),
      deny: o.deny.bitfield.toString(),
      allowNames: o.allow.toArray(),
      denyNames: o.deny.toArray(),
    }));
  }
  if (c.type === ChannelType.GuildForum) {
    base.availableTags = c.availableTags.map((t) => ({ id: t.id, name: t.name, emoji: t.emoji }));
    base.defaultReactionEmoji = c.defaultReactionEmoji;
  }
  return base;
}

function messageRecord(m: Message) {
  return {
    id: m.id,
    at: m.createdAt.toISOString(),
    editedAt: m.editedAt?.toISOString() ?? null,
    author: { id: m.author.id, username: m.author.username, displayName: m.member?.displayName ?? m.author.displayName, bot: m.author.bot },
    webhookId: m.webhookId ?? null,
    pinned: m.pinned,
    replyTo: m.reference?.messageId ?? null,
    content: m.content,
    embeds: m.embeds.map((e) => e.toJSON()),
    components: m.components.map((r) => r.toJSON()),
    attachments: [...m.attachments.values()].map((a) => ({ id: a.id, name: a.name, url: a.url, size: a.size })),
    reactions: [...m.reactions.cache.values()].map((r) => ({ emoji: r.emoji.toString(), count: r.count })),
  };
}

async function allMessages(ch: { messages: { fetch(o: { limit: number; before?: string }): Promise<Map<string, Message>> } }) {
  const out: Message[] = [];
  let before: string | undefined;
  for (;;) {
    const page = await ch.messages.fetch({ limit: 100, before });
    if (page.size === 0) break;
    out.push(...page.values());
    before = [...page.keys()].reduce((a, b) => (BigInt(a) < BigInt(b) ? a : b));
    if (page.size < 100) break;
  }
  return out.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
}

async function download(url: string, file: string) {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(file));
}

async function exportChannel(guild: Guild, ch: GuildBasedChannel, dir: string) {
  const lines: string[] = [];
  let files = 0;
  const attDir = join(dir, "attachments", ch.id);
  const write = async (msgs: Message[], thread?: AnyThreadChannel) => {
    for (const m of msgs) {
      const rec = { ...messageRecord(m), thread: thread ? { id: thread.id, name: thread.name } : null };
      lines.push(JSON.stringify(rec));
      for (const a of m.attachments.values()) {
        mkdirSync(attDir, { recursive: true });
        await download(a.url, join(attDir, `${a.id}-${a.name}`)).then(() => files++, (e) => console.warn(`  ! attachment ${a.name}: ${e.message}`));
      }
    }
  };
  if (ch.isTextBased() && !ch.isThread() && "messages" in ch) await write(await allMessages(ch as never));
  if ("threads" in ch) {
    const active = await guild.channels.fetchActiveThreads().then((r) => [...r.threads.values()].filter((t) => t.parentId === ch.id));
    const archived = await ch.threads
      .fetchArchived({ limit: 100 })
      .then((r) => [...r.threads.values()])
      .catch((): AnyThreadChannel[] => []);
    for (const t of new Map([...active, ...archived].map((t) => [t.id, t])).values()) await write(await allMessages(t as never), t);
  }
  writeFileSync(join(dir, "messages", `${ch.id}.jsonl`), lines.join("\n") + (lines.length ? "\n" : ""));
  return { messages: lines.length, files };
}

async function main() {
  const { client, guild } = await connect();
  try {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
    const dir = arg("out") ?? join("backups", `${guild.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${stamp}`);
    mkdirSync(join(dir, "messages"), { recursive: true });
    console.log(`Backing up ${guild.name} (${guild.id}) into ${dir}`);

    const members = await guild.members.fetch().catch((e) => {
      console.warn(`  ! could not list members (${e.message}); member roles will be missing`);
      return null;
    });
    const roles = [...guild.roles.cache.values()]
      .sort((a, b) => b.position - a.position)
      .map((r) => ({
        id: r.id,
        name: r.name,
        position: r.position,
        color: r.hexColor,
        hoist: r.hoist,
        mentionable: r.mentionable,
        managed: r.managed,
        permissions: r.permissions.bitfield.toString(),
        permissionNames: r.permissions.toArray(),
        icon: r.iconURL(),
        unicodeEmoji: r.unicodeEmoji,
        members: members ? members.filter((m) => m.roles.cache.has(r.id)).size : null,
      }));
    const channels = [...guild.channels.cache.values()].filter((c) => !c.isThread()).map(channelRecord);
    const memberRoles = members
      ? [...members.values()].map((m) => ({ id: m.id, username: m.user.username, bot: m.user.bot, joinedAt: m.joinedAt?.toISOString() ?? null, roles: m.roles.cache.filter((r) => r.id !== guild.id).map((r) => r.id) }))
      : null;
    const structure = {
      takenAt: new Date().toISOString(),
      guild: {
        id: guild.id,
        name: guild.name,
        memberCount: guild.memberCount,
        rulesChannelId: guild.rulesChannelId,
        systemChannelId: guild.systemChannelId,
        publicUpdatesChannelId: guild.publicUpdatesChannelId,
        afkChannelId: guild.afkChannelId,
        features: guild.features,
        verificationLevel: guild.verificationLevel,
      },
      roles,
      channels,
      memberRoles,
    };
    writeFileSync(join(dir, "structure.json"), JSON.stringify(structure, null, 1));
    console.log(`  ${roles.length} roles, ${channels.length} channels, ${memberRoles?.length ?? "?"} members`);

    const exported: string[] = [];
    const wanted = (arg("messages") ?? "").split(",").map((s) => s.trim().replace(/^#/, "")).filter(Boolean);
    for (const w of wanted) {
      const ch = guild.channels.cache.get(w) ?? guild.channels.cache.find((c) => c.name === w);
      if (!ch) { console.warn(`  ! no channel ${w}`); continue; }
      const r = await exportChannel(guild, ch, dir).catch((e) => { console.warn(`  ! #${ch.name}: ${e.message}`); return null; });
      if (r) { exported.push(`- #${ch.name} (${ch.id}): ${r.messages} messages, ${r.files} attachments`); console.log(`  exported #${ch.name}: ${r.messages} messages, ${r.files} attachments`); }
    }

    const byParent = new Map<string | null, typeof channels>();
    for (const c of channels.filter((c) => c.type !== "GuildCategory")) {
      const k = (c.parentId as string | null) ?? null;
      byParent.set(k, [...(byParent.get(k) ?? []), c]);
    }
    const md = [
      `# Backup of ${guild.name}`,
      ``,
      `Taken ${structure.takenAt.slice(0, 16).replace("T", " ")} UTC · ${guild.memberCount} members · ${roles.length} roles · ${channels.length} channels`,
      ``,
      `## Roles (top to bottom)`,
      ...roles.map((r) => `- ${r.name} · ${r.members ?? "?"} members${r.managed ? " · managed" : ""}${r.permissionNames.includes("Administrator") ? " · ADMIN" : ""}`),
      ``,
      `## Channels`,
      ...[null, ...channels.filter((c) => c.type === "GuildCategory").sort((a, b) => (a.position as number) - (b.position as number)).map((c) => c.id as string)].flatMap((cat) => [
        `### ${cat ? channels.find((c) => c.id === cat)!.name : "(no category)"}`,
        ...(byParent.get(cat) ?? []).sort((a, b) => (a.position as number) - (b.position as number)).map((c) => `- #${c.name} · ${String(c.type).replace("Guild", "")} · ${c.id}`),
      ]),
      ``,
      `## Message exports`,
      ...(exported.length ? exported : ["(none)"]),
      ``,
    ].join("\n");
    writeFileSync(join(dir, "SUMMARY.md"), md);
    console.log(`Done: ${dir}`);
  } finally {
    await client.destroy();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });
