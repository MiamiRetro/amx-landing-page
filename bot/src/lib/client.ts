import "dotenv/config";
import { Client, Events, GatewayIntentBits, type Guild } from "discord.js";

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing ${name}. Copy bot/.env.example to bot/.env and fill it in.`);
    process.exit(1);
  }
  return v;
}

/**
 * Logs in and resolves the configured guild with roles and channels cached.
 * The channel manager only needs the Guilds intent; message history is
 * fetched over REST and does not require the Message Content intent.
 */
export async function connect(): Promise<{ client: Client<true>; guild: Guild }> {
  const token = requireEnv("DISCORD_TOKEN");
  const guildId = requireEnv("DISCORD_GUILD_ID");
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  await client.login(token);
  const ready = await new Promise<Client<true>>((resolve) => {
    if (client.isReady()) resolve(client);
    else client.once(Events.ClientReady, resolve);
  });
  const guild = await ready.guilds.fetch(guildId);
  await guild.channels.fetch();
  await guild.roles.fetch();
  return { client: ready, guild };
}
