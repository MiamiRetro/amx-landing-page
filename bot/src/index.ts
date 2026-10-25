import { createServer } from "node:http";
import { Client, Events, GatewayIntentBits, Partials } from "discord.js";
import { config } from "./config.js";
import { commandDefinitions, handleCommand } from "./commands/index.js";
import { Db } from "./db/index.js";
import { log, setLogLevel, errInfo } from "./log.js";
import { GroupIndex } from "./mirror/groups.js";
import { Mirror } from "./mirror/mirror.js";
import { Semaphore } from "./mirror/queue.js";
import { Funnel, InviteTracker } from "./funnel.js";
import { LanguageRoles } from "./roles.js";
import { handlePickerButton, PICKER_PREFIX } from "./picker.js";
import { providerFromSpec, Translator } from "./translate/index.js";
import { InfographicLocalizer, infographicsEnabled } from "./infographic/index.js";
import { buildProviders } from "./verify/providers/index.js";
import { buildBackendVerifiers } from "./verify/providers/backend.js";
import { VerifyService } from "./verify/service.js";
import { handleVerifyButton, handleVerifySubmit, VERIFY_BUTTON, VERIFY_MODAL } from "./verify/panel.js";
import { checkProviders, HealthWatch } from "./verify/health.js";
import { VipTracker } from "./vip/tracker.js";
import { FlagshipWatch } from "./flagship.js";
import { SignalFeed } from "./signals/feed.js";
import { SupportAssistant } from "./support/assistant.js";
import { SupportDesk, SUPPORT_PREFIX } from "./support/desk.js";
import { SupportReview } from "./support/review.js";
import { NotifyCenter, NOTIFY_OPEN, NOTIFY_SET } from "./notify.js";

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

  const infographics = infographicsEnabled() ? new InfographicLocalizer({ translator }) : undefined;
  if (infographics) log.info("infographic translation enabled");

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildInvites],
    partials: [Partials.Message, Partials.Channel],
  });

  let mirror: Mirror | null = null;
  let groups: GroupIndex | null = null;
  let roles: LanguageRoles | null = null;
  let verify: VerifyService | null = null;
  let vip: VipTracker | null = null;
  let invites: InviteTracker | null = null;
  let support: SupportDesk | null = null;
  let review: SupportReview | null = null;
  let notify: NotifyCenter | null = null;
  const funnel = new Funnel(db, guildId);

  client.once(Events.ClientReady, async (c) => {
    try {
      const guild = await c.guilds.fetch(guildId);
      await guild.channels.fetch();
      await guild.roles.fetch();
      groups = new GroupIndex(db, guildId);
      await groups.reload();
      mirror = new Mirror({ guild, db, groups, translator, botUserId: c.user.id, applicationId: c.application.id, infographics });
      mirror.paused = groups.groups.length > 0 && groups.groups.every((g) => g.paused);

      roles = new LanguageRoles(guild, db, funnel);
      await roles.load();

      // Help-desk threads. Without an Anthropic key every thread goes straight to a moderator.
      const assistant = process.env.ANTHROPIC_API_KEY && process.env.SUPPORT_ASSISTANT !== "off" ? new SupportAssistant() : null;
      notify = new NotifyCenter(guild, db, roles);
      support = new SupportDesk(guild, db, roles, c.user.id, assistant);
      log.info("support desk ready", { assistant: assistant?.model ?? "off" });
      if (SupportReview.enabled()) {
        const desk = support;
        review = new SupportReview(guild, db, c.user.id, assistant, (m) => desk.isMod(m));
        const learned = await review.loadLearned().catch((e) => { log.warn("learned faq load failed", errInfo(e)); return 0; });
        review.schedule();
        log.info("support review scheduled", { learned });
      }

      // Invite use counts, so a join can be traced to the link it came through.
      // Without Manage Server this stays empty and joins go unattributed.
      invites = new InviteTracker(guild);
      await invites.refresh().catch((e) => log.warn("invite cache failed", errInfo(e)));

      const affiliates = buildProviders();
      // UID checks go through the BLKBöX app API when it's configured; the exchange keys stay for health checks and VIP tiers.
      const backend = buildBackendVerifiers([...affiliates.keys()]);
      verify = new VerifyService(db, guildId, backend ?? affiliates, !!backend);
      if (backend) log.info("uid checks via BLKBöX API", { url: process.env.VERIFY_BACKEND_URL, keySet: [...backend.values()].every((p) => p.configured()) });
      vip = new VipTracker(guild, db, affiliates);
      // The weekly check needs Bybit, which blocks some hosting regions. It runs
      // from the Mac Studio (scripts/vip-run.ts under launchd) unless VIP_SCHEDULE=1.
      if (process.env.VIP_SCHEDULE === "1") vip.schedule();
      const flagship = new FlagshipWatch(guild, db);
      if (flagship.enabled) { flagship.start(); log.info("flagship follows the AlphanumetriX dashboard"); }
      // New signals become cards in every language's AlphanumetriX channel, and the pinned board follows.
      // Opt-in per environment, since the live server has no such channels yet.
      if (flagship.client && process.env.SIGNAL_FEED === "1") { new SignalFeed(guild, db, translator, flagship.client).start(); log.info("signal feed on"); }
      log.info("uid verification ready", { exchanges: [...affiliates.values()].map((p) => `${p.id}:${p.live ? "live" : "stand-in"}`) });

      // Affiliate keys die quietly: Bybit expires an unbound key after 90 days,
      // and a revoked permission looks the same. Probing a UID that cannot
      // exist tells us the key still works before a member has to report it.
      const watch = new HealthWatch();
      const alertChannelId = process.env.VERIFY_ALERT_CHANNEL_ID?.trim();
      const runHealth = async () => {
        const results = await checkProviders(affiliates.values());
        for (const c of watch.diff(results)) {
          const text = c.ok
            ? `✅ ${c.exchange} affiliate checks are working again.`
            : `⚠️ ${c.exchange} affiliate checks are failing: ${c.error}\nUID verification for ${c.exchange} is down until the API key is fixed.`;
          c.ok ? log.info("affiliate credentials recovered", { exchange: c.exchange }) : log.error("affiliate credentials failing", { exchange: c.exchange, error: c.error });
          if (!alertChannelId) continue;
          const ch = await guild.channels.fetch(alertChannelId).catch(() => null);
          if (ch?.isTextBased() && "send" in ch) await ch.send(text).catch((e) => log.warn("health alert send failed", errInfo(e)));
        }
      };
      void runHealth().catch((e) => log.warn("affiliate health check failed", errInfo(e)));
      const healthHours = Number(process.env.VERIFY_HEALTH_HOURS ?? 12);
      setInterval(() => void runHealth().catch((e) => log.warn("affiliate health check failed", errInfo(e))), healthHours * 3_600_000).unref();

      await guild.commands.set(commandDefinitions);
      log.info("ready", { guild: guild.name, groups: groups.groups.length, provider: primary.id, fallbacks: fallbacks.map((f) => f.id) });
      await mirror.backfill(config.backfillLimit());

      // Pick up groups linked outside the bot (scripts, another admin) and keep language roles honest.
      const g = groups, r = roles;
      setInterval(() => void g.reload().catch((e) => log.warn("group reload failed", errInfo(e))), 60_000).unref();
      setInterval(() => void r.sweep().catch((e) => log.warn("role sweep failed", errInfo(e))), 10 * 60_000).unref();

      // Forum edits and deletes reach the translated copies once a day.
      const m = mirror;
      const forumSync = async () => {
        const last = Number((await db.getSetting(guildId, "forum_sync:last_run")) ?? 0);
        if (Date.now() - last < 86_400_000) return;
        const started = Date.now();
        await m.syncForums(last || started - 86_400_000);
        await db.setSetting(guildId, "forum_sync:last_run", String(started));
      };
      void forumSync().catch((e) => log.warn("forum sync failed", errInfo(e)));
      setInterval(() => void forumSync().catch((e) => log.warn("forum sync failed", errInfo(e))), 3_600_000).unref();
    } catch (e) {
      log.error("startup failed", errInfo(e));
      process.exit(1);
    }
  });

  client.on(Events.MessageCreate, (m) => {
    mirror?.onCreate(m);
    void support?.onMessage(m).catch((e) => log.error("support message failed", errInfo(e)));
    void review?.onMessage(m).catch((e) => log.error("support review reply failed", errInfo(e)));
  });
  client.on(Events.MessageUpdate, (_old, m) => mirror?.onUpdate(m));
  client.on(Events.MessageDelete, (m) => mirror?.onDelete(m));
  client.on(Events.MessageBulkDelete, (ms) => ms.forEach((m) => mirror?.onDelete(m)));
  client.on(Events.InteractionCreate, (i) => {
    // The bot sits in more than one server (a test server too); each running copy serves only its own.
    if (i.guildId !== guildId) return;
    if (!mirror || !groups || !roles || !verify) return;
    if (i.isButton() && i.customId.startsWith(PICKER_PREFIX)) return void handlePickerButton(i, roles);
    if (i.isButton() && i.customId === NOTIFY_OPEN && i.inCachedGuild() && notify) {
      return void notify.onButton(i).catch((e) => log.error("notify button failed", errInfo(e)));
    }
    if (i.isStringSelectMenu() && i.customId === NOTIFY_SET && i.inCachedGuild() && notify) {
      return void notify.onSelect(i).catch((e) => log.error("notify select failed", errInfo(e)));
    }
    if (i.isButton() && i.customId.startsWith(SUPPORT_PREFIX) && i.inCachedGuild() && support) {
      return void support.onButton(i).catch((e) => log.error("support button failed", errInfo(e)));
    }
    if (verify) {
      const v = verify, r = roles;
      if (i.isButton() && i.customId === VERIFY_BUTTON) {
        return void handleVerifyButton(i, { verify: v, roles: r, funnel }).catch((e) => log.error("verify button failed", errInfo(e)));
      }
      if (i.isModalSubmit() && i.customId === VERIFY_MODAL) {
        return void handleVerifySubmit(i, { verify: v, roles: r, memberRoleId: r.memberRoleId(), funnel }).catch((e) => log.error("verify modal failed", errInfo(e)));
      }
    }
    if (!i.isChatInputCommand()) return;
    void handleCommand(i, { guild: mirror.guild, db, groups, mirror, providerId: primary.id, roles, verify, vip: vip!, funnel });
  });
  client.on(Events.GuildMemberUpdate, (before, after) => {
    if (after.guild.id !== guildId) return;
    if (!roles || before.roles.cache.size === after.roles.cache.size) return;
    void roles.sync(after).catch((e) => log.warn("language tier sync failed", errInfo(e)));
  });
  client.on(Events.GuildMemberAdd, (m) => {
    if (m.guild.id !== guildId || m.user.bot) return;
    const inv = invites;
    void (inv ? inv.attribute() : Promise.resolve(null)).then((inviteCode) => funnel.record(m.id, "join", { inviteCode }));
  });
  client.on(Events.GuildMemberRemove, (m) => {
    if (m.guild.id !== guildId || m.user?.bot) return;
    funnel.record(m.id, "leave", { lang: roles && !m.partial ? roles.langOf(m) : null });
  });
  client.on(Events.InviteCreate, (inv) => {
    if (inv.guild?.id === guildId) invites?.onCreate(inv.code, inv.uses);
  });
  client.on(Events.InviteDelete, (inv) => {
    if (inv.guild?.id === guildId) invites?.onDelete(inv.code);
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

  // Dead-man's switch for an outside monitor (e.g. healthchecks.io): ping while
  // connected, and the monitor alerts when the pings stop. A crash loop, a lost
  // gateway or a Railway outage are all things the bot cannot report itself.
  const heartbeatUrl = process.env.HEARTBEAT_URL?.trim();
  if (heartbeatUrl) {
    const beat = () => {
      if (!client.isReady()) return;
      fetch(heartbeatUrl, { signal: AbortSignal.timeout(10_000) }).catch((e) => log.warn("heartbeat failed", errInfo(e)));
    };
    setInterval(beat, Number(process.env.HEARTBEAT_MIN ?? 5) * 60_000).unref();
  }

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
