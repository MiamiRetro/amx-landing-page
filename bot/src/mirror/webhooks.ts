import { WebhookClient, type Guild, type TextChannel, type NewsChannel } from "discord.js";
import type { Db, GroupMember } from "../db/index.js";

const WEBHOOK_NAME = "AMX Mirror";

/** Names Discord rejects for webhooks. */
export function sanitizeUsername(name: string): string {
  let n = name.replace(/clyde/gi, "c1yde").replace(/discord/gi, "d1scord").trim();
  if (n.length === 0) n = "Member";
  return n.slice(0, 80);
}

/**
 * Caches WebhookClient instances per channel, creating the webhook on first
 * use and persisting id/token so restarts reuse it.
 */
export class WebhookPool {
  private clients = new Map<string, WebhookClient>();

  constructor(private guild: Guild, private db: Db) {}

  async ensure(member: GroupMember): Promise<WebhookClient> {
    const cached = this.clients.get(member.channel_id);
    if (cached) return cached;

    let id = member.webhook_id;
    let token = member.webhook_token;
    if (!id || !token) {
      const channel = await this.guild.channels.fetch(member.channel_id);
      if (!channel || !("createWebhook" in channel)) throw new Error(`channel ${member.channel_id} cannot host webhooks`);
      const ch = channel as TextChannel | NewsChannel;
      const existing = (await ch.fetchWebhooks()).find((w) => w.name === WEBHOOK_NAME && w.token);
      const hook = existing ?? (await ch.createWebhook({ name: WEBHOOK_NAME, reason: "AMX mirror bot" }));
      if (!hook.token) throw new Error(`webhook ${hook.id} has no token`);
      id = hook.id;
      token = hook.token;
      await this.db.upsertMember({ ...member, webhook_id: id, webhook_token: token });
      member.webhook_id = id;
      member.webhook_token = token;
    }
    const client = new WebhookClient({ id, token });
    this.clients.set(member.channel_id, client);
    return client;
  }

  forget(channelId: string) {
    this.clients.get(channelId)?.destroy();
    this.clients.delete(channelId);
  }
}
