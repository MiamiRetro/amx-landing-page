import { WebhookClient, type Guild, type TextChannel } from "discord.js";
import type { Lang } from "../config.js";
import type { Db } from "../db/index.js";
import { WEBHOOK_NAME } from "../mirror/webhooks.js";

export interface GroupTarget { lang: Lang; channelId: string; hook: WebhookClient }

/**
 * A webhook in every channel of a mirror group, English first, for posts the bot
 * writes itself in each language. They are the mirror's own webhooks, so the
 * mirror leaves the posts alone instead of copying the English one into every
 * language. The English channel has no mirror webhook; one named like the
 * mirror's is found or made there, which the mirror skips too.
 */
export async function groupTargets(guild: Guild, db: Db, groupName: string, reason: string): Promise<GroupTarget[]> {
  const group = (await db.loadGroups(guild.id)).find((g) => g.name === groupName);
  if (!group) throw new Error(`no ${groupName} mirror group`);
  const out: GroupTarget[] = [];
  for (const m of group.members) {
    if (m.lang === "en" || !m.webhook_id || !m.webhook_token) {
      const ch = (await guild.channels.fetch(m.channel_id)) as TextChannel;
      const me = guild.client.user!.id;
      const hook = (await ch.fetchWebhooks()).find((w) => w.name === WEBHOOK_NAME && w.owner?.id === me && w.token)
        ?? (await ch.createWebhook({ name: WEBHOOK_NAME, reason }));
      // A language channel's webhook is the mirror's own: record it so the mirror reuses it.
      if (m.lang !== "en") await db.upsertMember({ channel_id: m.channel_id, group_id: m.group_id, lang: m.lang, webhook_id: hook.id, webhook_token: hook.token! });
      out.push({ lang: m.lang as Lang, channelId: m.channel_id, hook: new WebhookClient({ id: hook.id, token: hook.token! }) });
    } else {
      out.push({ lang: m.lang as Lang, channelId: m.channel_id, hook: new WebhookClient({ id: m.webhook_id, token: m.webhook_token }) });
    }
  }
  return out.sort((a, b) => (a.lang === "en" ? -1 : b.lang === "en" ? 1 : 0));
}
