/**
 * Translates tutorial infographics on the Mac Studio, so no image reading or
 * rendering happens in the cloud. The bot (Railway) mirrors forum posts with
 * the original images straight away; this worker then finds new tutorial posts
 * with images, reads them with the local vision model (INFOGRAPHIC_VLM_URL),
 * renders each language with local Chromium, and swaps the images in every
 * copy through the mirror's own webhooks.
 *
 *   railway run env INFOGRAPHIC_VLM_URL=http://127.0.0.1:8189/v1 INFOGRAPHIC_GUILDS=<id,id> npx tsx scripts/infographic-worker.ts [--once]
 *
 * Runs as LaunchAgent com.lloyde.blkbox-infographics. Progress lives in the
 * infographic_done table, so a restart picks up where it stopped.
 */
import { REST } from "@discordjs/rest";
import { Routes, type APIMessage } from "discord-api-types/v10";
import { WebhookClient } from "discord.js";
import { config, type Lang } from "../src/config.js";
import { Db } from "../src/db/index.js";
import { chooseFiles, InfographicLocalizer, pickCandidates, type FileLike } from "../src/infographic/index.js";
import { log, errInfo } from "../src/log.js";
import { Semaphore } from "../src/mirror/queue.js";
import { providerFromSpec, Translator } from "../src/translate/index.js";

const POLL_MS = 60_000;
const LOOKBACK_MS = 3 * 86_400_000;

const db = new Db();
const rest = new REST().setToken(config.discordToken());
const limiter = new Semaphore(2);
const translator = new Translator({
  primary: providerFromSpec(config.translationProvider()),
  fallbacks: config.translationFallbacks().map(providerFromSpec),
  db,
  limiter: (fn) => limiter.run(fn),
  timeoutMs: config.translationTimeoutSec() * 1000,
});
const localizer = new InfographicLocalizer({ translator });

interface Member { channel_id: string; group_id: string; lang: Lang; webhook_id: string | null; webhook_token: string | null }

async function pass(guildId: string) {
  const { data: groups } = await db.sb.from("channel_groups").select("id, name").eq("guild_id", guildId);
  const groupName = new Map((groups ?? []).map((g) => [g.id as string, g.name as string]));
  const { data: members } = await db.sb.from("channel_group_members").select("channel_id, group_id, lang, webhook_id, webhook_token").in("group_id", [...groupName.keys()]);
  const byChannel = new Map((members as Member[] ?? []).map((m) => [m.channel_id, m]));

  const { data: rows } = await db.sb.from("message_map").select("*").not("source_thread_id", "is", null).gte("created_at", new Date(Date.now() - LOOKBACK_MS).toISOString());
  const bySource = new Map<string, NonNullable<typeof rows>>();
  for (const r of rows ?? []) {
    if (!byChannel.has(r.source_channel_id)) continue; // another server's forum
    bySource.set(r.source_message_id, [...(bySource.get(r.source_message_id) ?? []), r]);
  }
  if (bySource.size === 0) return;
  const { data: done } = await db.sb.from("infographic_done").select("source_message_id").in("source_message_id", [...bySource.keys()]);
  const finished = new Set((done ?? []).map((d) => d.source_message_id));
  const { data: glossary } = await db.sb.from("glossary").select("term, note").eq("guild_id", guildId);

  for (const [sourceId, copies] of bySource) {
    if (finished.has(sourceId)) continue;
    const mark = (outcome: string) => db.sb.from("infographic_done").upsert({ source_message_id: sourceId, guild_id: guildId, outcome });
    const origin = byChannel.get(copies[0].source_channel_id)!;
    const group = groupName.get(origin.group_id) ?? "";
    try {
      const msg = (await rest.get(Routes.channelMessage(copies[0].source_thread_id!, sourceId))) as APIMessage;
      const names = msg.attachments.map((a) => a.filename);
      if (pickCandidates(group, names).length === 0) { await mark("no images"); continue; }
      const files: FileLike[] = [];
      for (const a of msg.attachments) files.push({ attachment: Buffer.from(await (await fetch(a.url)).arrayBuffer()), name: a.filename });

      const targets = [...new Set(copies.map((c) => c.lang as Lang))];
      const localized = await localizer.localize(group, files, origin.lang, targets, (glossary ?? []) as { term: string; note: string | null }[]);
      if (localized.size === 0) { await mark("not an infographic"); continue; }

      // Images ride on the last chunk of a long message: edit the newest copy per target.
      const last = new Map<string, (typeof copies)[number]>();
      for (const c of copies) if (!last.has(c.target_channel_id) || BigInt(c.mirror_message_id) > BigInt(last.get(c.target_channel_id)!.mirror_message_id)) last.set(c.target_channel_id, c);
      let swapped = 0;
      for (const c of last.values()) {
        const per = localized.get(c.lang as Lang);
        const target = byChannel.get(c.target_channel_id);
        if (!per || !target?.webhook_id || !target.webhook_token) continue;
        const hook = new WebhookClient({ id: target.webhook_id, token: target.webhook_token });
        await hook.editMessage(c.mirror_message_id, { threadId: c.target_thread_id!, files: chooseFiles(files, per), attachments: [] });
        hook.destroy();
        swapped++;
      }
      await mark(`translated ${swapped}`);
      log.info("infographics swapped", { source: sourceId, group, copies: swapped });
    } catch (e) {
      log.warn("infographic worker failed for message", { source: sourceId, ...errInfo(e) });
      if (/Unknown (Message|Channel)/.test(String(e))) await mark("source gone");
    }
  }
}

async function main() {
  const guilds = (process.env.INFOGRAPHIC_GUILDS ?? config.guildId()).split(",").map((s) => s.trim()).filter(Boolean);
  if (!process.env.INFOGRAPHIC_VLM_URL) log.warn("INFOGRAPHIC_VLM_URL is not set: images will be read by Claude, not locally");
  log.info("infographic worker started", { guilds });
  for (;;) {
    for (const g of guilds) await pass(g).catch((e) => log.warn("infographic pass failed", { guild: g, ...errInfo(e) }));
    if (process.argv.includes("--once")) break;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  await localizer.renderer.close?.();
}
main().catch((e) => { log.error("infographic worker crashed", errInfo(e)); process.exit(1); });
