import { ChannelType, PermissionFlagsBits } from "discord.js";
import { connect } from "../src/lib/client.js";
async function main() {
  const { client, guild } = await connect();
  try {
    const me = guild.members.me ?? (await guild.members.fetchMe());
    console.log("roles:", me.roles.cache.map((r) => r.name).join(", "));
    const want = { View: PermissionFlagsBits.ViewChannel, History: PermissionFlagsBits.ReadMessageHistory, Send: PermissionFlagsBits.SendMessages, Webhooks: PermissionFlagsBits.ManageWebhooks, ManageMsgs: PermissionFlagsBits.ManageMessages };
    const names = ["general", "trader-chat", "help-desk", "trade-alerts", "announcements", "bitcoin", "memes", "vip-chat"];
    for (const ch of guild.channels.cache.filter((c) => (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement) && names.some((n) => c.name.includes(n))).values()) {
      const p = ch.permissionsFor(me);
      const row = Object.entries(want).map(([k, v]) => `${k}=${p.has(v) ? "✓" : "✗"}`).join(" ");
      console.log(`${ch.name.padEnd(24)} ${row}`);
    }
  } finally { await client.destroy(); }
}
main();
