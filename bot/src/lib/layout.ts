import {
  ChannelType,
  PermissionFlagsBits,
  type CategoryChannel,
  type Guild,
  type NonThreadGuildBasedChannel,
  type OverwriteResolvable,
  type Role,
} from "discord.js";

/**
 * A desired server layout. Applying it is idempotent: existing categories,
 * roles and channels are matched by name and left alone unless a field differs.
 */
export interface Layout {
  roles?: Array<{ name: string; color?: string; mentionable?: boolean }>;
  categories: Array<{
    name: string;
    /** Only these roles may view the category and its channels. Omit for public. */
    viewRoles?: string[];
    /** User IDs that can always view the category regardless of role (ops accounts). Merged with OPS_USER_IDS. */
    viewUsers?: string[];
    channels: Array<{
      name: string;
      type?: "text" | "announcement" | "voice" | "forum";
      topic?: string;
      slowmode?: number;
      /** Override the category visibility for this channel. */
      viewRoles?: string[];
      /** Deny SendMessages to everyone (read-only channel). */
      readOnly?: boolean;
    }>;
  }>;
}

export interface Change {
  action: "create-role" | "create-category" | "create-channel" | "update-channel" | "update-overwrites" | "move-channel";
  target: string;
  detail?: string;
}

const channelTypeMap = {
  text: ChannelType.GuildText,
  announcement: ChannelType.GuildAnnouncement,
  voice: ChannelType.GuildVoice,
  forum: ChannelType.GuildForum,
} as const;

function findRole(guild: Guild, name: string): Role | undefined {
  return guild.roles.cache.find((r) => r.name.toLowerCase() === name.toLowerCase());
}

/** Ops accounts that must see every gated channel, from OPS_USER_IDS (comma-separated). */
export function opsUserIds(): string[] {
  return (process.env.OPS_USER_IDS ?? "").split(",").map((s) => s.trim()).filter((s) => /^\d{15,25}$/.test(s));
}

export function buildOverwrites(
  guild: Guild,
  viewRoles: string[] | undefined,
  readOnly: boolean | undefined,
  viewUsers: string[] = [],
): OverwriteResolvable[] {
  const me = guild.members.me;
  const ows: OverwriteResolvable[] = [];
  if (viewRoles && viewRoles.length) {
    ows.push({ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] });
    for (const name of viewRoles) {
      const role = findRole(guild, name);
      if (!role) throw new Error(`Role "${name}" does not exist. Add it under roles: in the layout.`);
      ows.push({ id: role.id, allow: [PermissionFlagsBits.ViewChannel] });
    }
    for (const id of new Set([...viewUsers, ...opsUserIds()])) {
      ows.push({ id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
    }
    if (me) ows.push({ id: me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageWebhooks, PermissionFlagsBits.ManageMessages] });
  }
  if (readOnly) {
    const existing = ows.find((o) => o.id === guild.roles.everyone.id) as { deny?: bigint[] } | undefined;
    if (existing) existing.deny = [...(existing.deny ?? []), PermissionFlagsBits.SendMessages];
    else ows.push({ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.SendMessages] });
  }
  return ows;
}

export async function applyLayout(guild: Guild, layout: Layout, dryRun: boolean): Promise<Change[]> {
  const changes: Change[] = [];

  for (const r of layout.roles ?? []) {
    if (findRole(guild, r.name)) continue;
    changes.push({ action: "create-role", target: r.name });
    if (!dryRun) {
      await guild.roles.create({ name: r.name, color: r.color as never, mentionable: r.mentionable ?? false, reason: "channel-manager apply" });
    }
  }

  for (const cat of layout.categories) {
    let category = guild.channels.cache.find(
      (c): c is CategoryChannel => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === cat.name.toLowerCase(),
    );
    const catOws = buildOverwrites(guild, cat.viewRoles, undefined, cat.viewUsers);
    if (!category) {
      changes.push({ action: "create-category", target: cat.name, detail: cat.viewRoles ? `visible to ${cat.viewRoles.join(", ")}` : "public" });
      if (!dryRun) {
        category = await guild.channels.create({ name: cat.name, type: ChannelType.GuildCategory, permissionOverwrites: catOws, reason: "channel-manager apply" });
      }
    } else if (cat.viewRoles) {
      changes.push({ action: "update-overwrites", target: cat.name, detail: `visible to ${cat.viewRoles.join(", ")}` });
      if (!dryRun) await category.permissionOverwrites.set(catOws, "channel-manager apply");
    }

    for (const ch of cat.channels) {
      const type = channelTypeMap[ch.type ?? "text"];
      const existing = guild.channels.cache.find(
        (c): c is NonThreadGuildBasedChannel => !c.isThread() && c.type === type && c.name.toLowerCase() === ch.name.toLowerCase(),
      );
      const ows = ch.viewRoles || ch.readOnly ? buildOverwrites(guild, ch.viewRoles ?? cat.viewRoles, ch.readOnly, cat.viewUsers) : undefined;

      if (!existing) {
        changes.push({ action: "create-channel", target: `${cat.name} / #${ch.name}` });
        if (!dryRun && category) {
          await guild.channels.create({
            name: ch.name,
            type: type as ChannelType.GuildText,
            parent: category.id,
            topic: ch.topic,
            rateLimitPerUser: ch.slowmode,
            permissionOverwrites: ows,
            reason: "channel-manager apply",
          });
        }
        continue;
      }

      if (category && existing.parentId !== category.id) {
        changes.push({ action: "move-channel", target: `#${ch.name}`, detail: `→ ${cat.name}` });
        if (!dryRun) await existing.setParent(category.id, { lockPermissions: !ows, reason: "channel-manager apply" });
      }
      const wantsTopic = ch.topic !== undefined && "topic" in existing && (existing.topic ?? "") !== ch.topic;
      const wantsSlow = ch.slowmode !== undefined && "rateLimitPerUser" in existing && (existing.rateLimitPerUser ?? 0) !== ch.slowmode;
      if (wantsTopic || wantsSlow) {
        changes.push({ action: "update-channel", target: `#${ch.name}`, detail: [wantsTopic && "topic", wantsSlow && "slowmode"].filter(Boolean).join(", ") });
        if (!dryRun) {
          await existing.edit({ topic: wantsTopic ? ch.topic : undefined, rateLimitPerUser: wantsSlow ? ch.slowmode : undefined, reason: "channel-manager apply" });
        }
      }
      if (ows) {
        changes.push({ action: "update-overwrites", target: `#${ch.name}` });
        if (!dryRun) await existing.permissionOverwrites.set(ows, "channel-manager apply");
      }
    }
  }
  return changes;
}
