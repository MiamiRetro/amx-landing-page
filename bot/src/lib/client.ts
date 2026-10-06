import "dotenv/config";
import { Client, Events, GatewayIntentBits, PermissionFlagsBits, type Guild } from "discord.js";

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
  // GuildMembers lets `guild.members.fetch()` count role members. It needs
  // "Server Members Intent" switched on in the Developer Portal; if it is off,
  // Discord rejects the connection and we retry without it (counts show 0).
  let client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
  try {
    await client.login(token);
  } catch (err) {
    if (!/disallowed intents/i.test(String(err))) throw err;
    console.warn("Server Members Intent is off in the Developer Portal; role member counts will be 0.");
    client = new Client({ intents: [GatewayIntentBits.Guilds] });
    await client.login(token);
  }
  const ready = await new Promise<Client<true>>((resolve) => {
    if (client.isReady()) resolve(client);
    else client.once(Events.ClientReady, resolve);
  });
  const guild = await ready.guilds.fetch(guildId);
  await guild.channels.fetch();
  await guild.roles.fetch();

  const me = guild.members.me ?? (await guild.members.fetchMe());
  const unreadable = guild.channels.cache.filter(
    (c) => c.isTextBased() && !c.isThread() && !c.permissionsFor(me).has(PermissionFlagsBits.ViewChannel),
  ).size;
  if (unreadable > 0) {
    console.warn(`Bot cannot view ${unreadable} text channels (role overwrites). Activity for those will be blank.`);
    console.warn(`Fix: Server Settings → Roles → "${me.roles.highest.name}" → enable Administrator, or add the bot to the roles that can see those channels.`);
  }
  return { client: ready, guild };
}
