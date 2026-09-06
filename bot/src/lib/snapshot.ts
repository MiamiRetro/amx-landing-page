import {
  ChannelType,
  PermissionFlagsBits,
  type Guild,
  type GuildBasedChannel,
  type Message,
  type TextChannel,
  type NewsChannel,
} from "discord.js";

export interface ChannelActivity {
  /** Messages seen inside the window (capped by `scanLimit`). */
  messages: number;
  /** Distinct human authors inside the window. */
  humans: number;
  /** Messages from bots or webhooks inside the window. */
  botMessages: number;
  /** ISO time of the newest message, or null if the channel is empty. */
  lastMessageAt: string | null;
  /** True when the scan hit `scanLimit` before reaching the window start. */
  truncated: boolean;
  /** Messages per day inside the window (using the days actually covered). */
  perDay: number;
}

export interface ChannelSnapshot {
  id: string;
  name: string;
  type: string;
  categoryId: string | null;
  position: number;
  topic: string | null;
  nsfw: boolean;
  slowmodeSeconds: number;
  /** Whether @everyone can see the channel after overwrites. */
  publicView: boolean;
  /** Roles explicitly granted ViewChannel via overwrites. */
  viewRoles: string[];
  /** Roles explicitly denied ViewChannel via overwrites. */
  hiddenFromRoles: string[];
  activity: ChannelActivity | null;
  threads: number;
}

export interface CategorySnapshot {
  id: string | null;
  name: string;
  position: number;
  channels: ChannelSnapshot[];
}

export interface RoleSnapshot {
  id: string;
  name: string;
  members: number;
  position: number;
  color: string;
  mentionable: boolean;
  managed: boolean;
}

export interface GuildSnapshot {
  takenAt: string;
  windowDays: number;
  guild: { id: string; name: string; memberCount: number; premiumTier: number; locale: string };
  roles: RoleSnapshot[];
  categories: CategorySnapshot[];
}

type Readable = TextChannel | NewsChannel;

function isReadable(ch: GuildBasedChannel): ch is Readable {
  return ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement;
}

/**
 * Walks message history backwards until the window start or the scan cap.
 * Uses `before` pagination in pages of 100, the Discord maximum.
 */
export async function scanActivity(
  channel: Readable,
  windowDays: number,
  scanLimit: number,
): Promise<ChannelActivity | null> {
  const me = channel.guild.members.me;
  if (me && !channel.permissionsFor(me).has(PermissionFlagsBits.ReadMessageHistory)) return null;

  const cutoff = Date.now() - windowDays * 86_400_000;
  const humans = new Set<string>();
  let messages = 0;
  let botMessages = 0;
  let lastMessageAt: string | null = null;
  let oldest: number | null = null;
  let before: string | undefined;
  let scanned = 0;
  let truncated = false;

  try {
    while (scanned < scanLimit) {
      const page = await channel.messages.fetch({ limit: 100, before });
      if (page.size === 0) break;
      let reachedCutoff = false;
      for (const msg of page.values() as Iterable<Message>) {
        scanned++;
        if (!lastMessageAt) lastMessageAt = msg.createdAt.toISOString();
        if (msg.createdTimestamp < cutoff) {
          reachedCutoff = true;
          break;
        }
        messages++;
        oldest = msg.createdTimestamp;
        if (msg.author.bot || msg.webhookId) botMessages++;
        else humans.add(msg.author.id);
      }
      if (reachedCutoff || page.size < 100) break;
      before = page.last()!.id;
    }
    if (scanned >= scanLimit) truncated = true;
  } catch {
    // Missing access or a deleted channel between fetches: report what we have.
    if (messages === 0 && !lastMessageAt) return null;
  }

  const coveredDays = oldest ? Math.max(1, (Date.now() - oldest) / 86_400_000) : windowDays;
  return {
    messages,
    humans: humans.size,
    botMessages,
    lastMessageAt,
    truncated,
    perDay: Math.round((messages / Math.min(coveredDays, windowDays)) * 10) / 10,
  };
}

function viewOverwrites(guild: Guild, ch: GuildBasedChannel) {
  const everyone = guild.roles.everyone;
  const publicView = ch.permissionsFor(everyone).has(PermissionFlagsBits.ViewChannel);
  const viewRoles: string[] = [];
  const hiddenFromRoles: string[] = [];
  if ("permissionOverwrites" in ch) {
    for (const ow of ch.permissionOverwrites.cache.values()) {
      const role = guild.roles.cache.get(ow.id);
      if (!role || role.id === everyone.id) continue;
      if (ow.allow.has(PermissionFlagsBits.ViewChannel)) viewRoles.push(role.name);
      if (ow.deny.has(PermissionFlagsBits.ViewChannel)) hiddenFromRoles.push(role.name);
    }
  }
  return { publicView, viewRoles, hiddenFromRoles };
}

export async function takeSnapshot(
  guild: Guild,
  opts: { windowDays: number; scanLimit: number; activity: boolean; log?: (s: string) => void },
): Promise<GuildSnapshot> {
  const log = opts.log ?? (() => {});
  const members = await guild.members.fetch().catch(() => null);

  const roles: RoleSnapshot[] = [...guild.roles.cache.values()]
    .sort((a, b) => b.position - a.position)
    .map((r) => ({
      id: r.id,
      name: r.name,
      members: members ? members.filter((m) => m.roles.cache.has(r.id)).size : r.members.size,
      position: r.position,
      color: r.hexColor,
      mentionable: r.mentionable,
      managed: r.managed,
    }));

  const all = [...guild.channels.cache.values()];
  const categories = all
    .filter((c) => c.type === ChannelType.GuildCategory)
    .sort((a, b) => a.position - b.position);

  const buckets = new Map<string | null, CategorySnapshot>();
  buckets.set(null, { id: null, name: "(no category)", position: -1, channels: [] });
  for (const cat of categories) {
    buckets.set(cat.id, { id: cat.id, name: cat.name, position: cat.position, channels: [] });
  }

  const nonCategory = all
    .filter((c) => c.type !== ChannelType.GuildCategory && !c.isThread())
    .sort((a, b) => ("position" in a && "position" in b ? a.position - b.position : 0));

  for (const ch of nonCategory) {
    log(`  scanning #${ch.name}`);
    const snap: ChannelSnapshot = {
      id: ch.id,
      name: ch.name,
      type: ChannelType[ch.type],
      categoryId: ch.parentId,
      position: "position" in ch ? ch.position : 0,
      topic: "topic" in ch ? (ch.topic ?? null) : null,
      nsfw: "nsfw" in ch ? ch.nsfw : false,
      slowmodeSeconds: "rateLimitPerUser" in ch ? (ch.rateLimitPerUser ?? 0) : 0,
      ...viewOverwrites(guild, ch),
      activity: opts.activity && isReadable(ch) ? await scanActivity(ch, opts.windowDays, opts.scanLimit) : null,
      threads: "threads" in ch ? ch.threads.cache.size : 0,
    };
    (buckets.get(ch.parentId) ?? buckets.get(null)!).channels.push(snap);
  }

  const out = [...buckets.values()].filter((b) => b.channels.length > 0 || b.id !== null);
  return {
    takenAt: new Date().toISOString(),
    windowDays: opts.windowDays,
    guild: {
      id: guild.id,
      name: guild.name,
      memberCount: guild.memberCount,
      premiumTier: guild.premiumTier,
      locale: guild.preferredLocale,
    },
    roles,
    categories: out.sort((a, b) => a.position - b.position),
  };
}

function ago(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - Date.parse(iso);
  const d = Math.floor(ms / 86_400_000);
  if (d === 0) return "today";
  if (d === 1) return "1d ago";
  if (d < 60) return `${d}d ago`;
  return `${Math.floor(d / 30)}mo ago`;
}

export function renderMarkdown(s: GuildSnapshot): string {
  const lines: string[] = [];
  lines.push(`# ${s.guild.name} — channel snapshot`);
  lines.push("");
  lines.push(`Taken ${s.takenAt.slice(0, 16).replace("T", " ")} UTC · ${s.guild.memberCount} members · boost tier ${s.guild.premiumTier} · activity window ${s.windowDays} days`);
  lines.push("");
  lines.push("## Roles");
  lines.push("");
  lines.push("| Role | Members | Mentionable | Managed |");
  lines.push("|---|---:|---|---|");
  for (const r of s.roles) {
    lines.push(`| ${r.name} | ${r.members} | ${r.mentionable ? "yes" : ""} | ${r.managed ? "bot/integration" : ""} |`);
  }
  lines.push("");
  lines.push("## Channels");
  lines.push("");
  for (const cat of s.categories) {
    lines.push(`### ${cat.name}`);
    lines.push("");
    lines.push("| Channel | Type | Visibility | Msgs/day | Msgs (window) | Humans | Bot msgs | Last msg | Slowmode | Topic |");
    lines.push("|---|---|---|---:|---:|---:|---:|---|---|---|");
    for (const ch of cat.channels) {
      const vis = ch.publicView
        ? "public"
        : ch.viewRoles.length
          ? `only: ${ch.viewRoles.join(", ")}`
          : "private";
      const a = ch.activity;
      const cells = [
        `#${ch.name}`,
        ch.type.replace("Guild", ""),
        vis,
        a ? String(a.perDay) : "",
        a ? `${a.messages}${a.truncated ? "+" : ""}` : "",
        a ? String(a.humans) : "",
        a ? String(a.botMessages) : "",
        a ? ago(a.lastMessageAt) : "",
        ch.slowmodeSeconds ? `${ch.slowmodeSeconds}s` : "",
        (ch.topic ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 80),
      ];
      lines.push(`| ${cells.join(" | ")} |`);
    }
    lines.push("");
  }
  lines.push("_Msgs (window) marked with + hit the scan cap; real count is higher._");
  return lines.join("\n");
}
