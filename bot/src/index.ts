import { createServer } from "node:http";
import { Client, Events, GatewayIntentBits, Partials } from "discord.js";
import { config } from "./config.js";
import { commandDefinitions, handleCommand } from "./commands/index.js";
import { Db } from "./db/index.js";
import { log, setLogLevel, errInfo } from "./log.js";
import { GroupIndex } from "./mirror/groups.js";
import { Mirror } from "./mirror/mirror.js";
import { Semaphore } from "./mirror/queue.js";
import { providerFromSpec, Translator } from "./translate/index.js";

async function main() {
  setLogLevel(config.logLevel());
  const startedAt = Date.now();
  const db = new Db();
  const guildId = config.guildId();

  const primary = providerFromSpec(config.translationProvider());
  const fallbacks = config.translationFallbacks().map(providerFromSpec);
  const limiter = new Semaphore(config.translationConcurrency());
  const translator = new Translator({
    primary,
    fallbacks,
    db,
    limiter: (fn) => limiter.run(fn),
    timeoutMs: config.translationTimeoutSec() * 1000,
  });

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers],
    partials: [Partials.Message, Partials.Channel],
  });

  let mirror: Mirror | null = null;
  let groups: GroupIndex | null = null;

  client.once(Events.ClientReady, async (c) => {
    try {
      const guild = await c.guilds.fetch(guildId);
      await guild.channels.fetch();
      await guild.roles.fetch();
      groups = new GroupIndex(db, guildId);
      await groups.reload();
      mirror = new Mirror({ guild, db, groups, translator, botUserId: c.user.id });
      mirror.paused = groups.groups.length > 0 && groups.groups.every((g) => g.paused);

      await guild.commands.set(commandDefinitions);
      log.info("ready", { guild: guild.name, groups: groups.groups.length, provider: primary.id, fallbacks: fallbacks.map((f) => f.id) });
      await mirror.backfill(config.backfillLimit());
    } catch (e) {
      log.error("startup failed", errInfo(e));
      process.exit(1);
    }
  });

  client.on(Events.MessageCreate, (m) => mirror?.onCreate(m));
  client.on(Events.MessageUpdate, (_old, m) => mirror?.onUpdate(m));
  client.on(Events.MessageDelete, (m) => mirror?.onDelete(m));
  client.on(Events.MessageBulkDelete, (ms) => ms.forEach((m) => mirror?.onDelete(m)));
  client.on(Events.InteractionCreate, (i) => {
    if (!i.isChatInputCommand() || !mirror || !groups) return;
    void handleCommand(i, { guild: mirror.guild, db, groups, mirror, providerId: primary.id });
  });
  client.on(Events.Error, (e) => log.error("client error", errInfo(e)));
  client.on(Events.Warn, (w) => log.warn("client warning", { warning: w }));

  // Railway health check
  createServer((req, res) => {
    if (req.url === "/health") {
      const body = { ok: client.isReady(), uptimeSec: Math.round((Date.now() - startedAt) / 1000), queue: mirror?.queue.pending ?? 0, paused: mirror?.paused ?? null };
      res.writeHead(client.isReady() ? 200 : 503, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    } else {
      res.writeHead(404);
      res.end();
    }
  }).listen(config.port(), () => log.info("health server listening", { port: config.port() }));

  const shutdown = async (signal: string) => {
    log.info("shutting down", { signal });
    await client.destroy();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await client.login(config.discordToken());
}

main().catch((e) => {
  log.error("fatal", errInfo(e));
  process.exit(1);
});
