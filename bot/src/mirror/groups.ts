import type { Lang } from "../config.js";
import type { Db, Group, GroupMember } from "../db/index.js";

/** In-memory index over channel groups, rebuilt from the database on demand. */
export class GroupIndex {
  private byChannel = new Map<string, { group: Group; member: GroupMember }>();
  private webhookIds = new Set<string>();
  groups: Group[] = [];

  constructor(private db: Db, private guildId: string) {}

  async reload() {
    const groups = await this.db.loadGroups(this.guildId);
    const byChannel = new Map<string, { group: Group; member: GroupMember }>();
    const webhookIds = new Set<string>();
    for (const group of groups) {
      for (const member of group.members) {
        byChannel.set(member.channel_id, { group, member });
        if (member.webhook_id) webhookIds.add(member.webhook_id);
      }
    }
    this.groups = groups;
    this.byChannel = byChannel;
    this.webhookIds = webhookIds;
  }

  lookup(channelId: string) {
    return this.byChannel.get(channelId) ?? null;
  }

  isOurWebhook(webhookId: string | null | undefined) {
    return !!webhookId && this.webhookIds.has(webhookId);
  }

  /** Targets for a source channel: every other member of its group. */
  targetsOf(channelId: string): GroupMember[] {
    const hit = this.byChannel.get(channelId);
    if (!hit) return [];
    return hit.group.members.filter((m) => m.channel_id !== channelId);
  }

  /** Same-language twin of `channelId` inside `channelId`'s group for `lang`, or null. */
  twin(channelId: string, lang: Lang): string | null {
    const hit = this.byChannel.get(channelId);
    if (!hit) return null;
    return hit.group.members.find((m) => m.lang === lang)?.channel_id ?? null;
  }

  allChannelIds(): string[] {
    return [...this.byChannel.keys()];
  }
}
