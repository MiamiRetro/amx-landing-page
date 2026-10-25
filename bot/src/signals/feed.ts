import { WebhookClient, type APIEmbed, type Guild, type TextChannel } from "discord.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Lang } from "../config.js";
import type { Db } from "../db/index.js";
import { log, errInfo } from "../log.js";
import { detokenize, tokenize } from "../mirror/placeholders.js";
import { WEBHOOK_NAME } from "../mirror/webhooks.js";
import type { Translator } from "../translate/index.js";
import { boardEmbed, boardSpec, cardSpec, signalEmbed, toEvents, type EventRow, type SignalEvent } from "./model.js";
import { renderSignalImage } from "./render.js";

export const GROUP = "alphanumetrix";
const LAST = "signals:last_id";
const boardKey = (channelId: string) => `signals:board:${channelId}`;
const AVATAR_KEY = "signals:avatar";

interface Target { lang: Lang; channelId: string; hook: WebhookClient }

/** The translatable strings of an embed, in a fixed order, and the way back. */
function strings(e: APIEmbed): string[] {
  return [e.title!, e.description!, ...(e.fields ?? []).flatMap((f) => [f.name, f.value]), e.footer!.text];
}
function rebuild(e: APIEmbed, s: string[]): APIEmbed {
  let i = 2;
  return { ...e, title: s[0], description: s[1], fields: e.fields?.map((f) => ({ ...f, name: s[i++], value: s[i++] })), footer: { text: s[i] } };
}

/**
 * Posts to every language's AlphanumetriX channel in its own language, through
 * the mirror's own webhooks so the mirror leaves the posts alone. The English
 * channel has no mirror webhook; one named like the mirror's is skipped too.
 */
export class SignalPoster {
  constructor(private guild: Guild, private db: Db, private translator: Translator) {}

  async targets(): Promise<Target[]> {
    const group = (await this.db.loadGroups(this.guild.id)).find((g) => g.name === GROUP);
    if (!group) throw new Error(`no ${GROUP} mirror group`);
    const out: Target[] = [];
    for (const m of group.members) {
      if (m.lang === "en" || !m.webhook_id || !m.webhook_token) {
        const ch = (await this.guild.channels.fetch(m.channel_id)) as TextChannel;
        const me = this.guild.client.user!.id;
        const hook = (await ch.fetchWebhooks()).find((w) => w.name === WEBHOOK_NAME && w.owner?.id === me && w.token)
          ?? (await ch.createWebhook({ name: WEBHOOK_NAME, reason: "AlphanumetriX signals" }));
        out.push({ lang: m.lang as Lang, channelId: m.channel_id, hook: new WebhookClient({ id: hook.id, token: hook.token! }) });
      } else {
        out.push({ lang: m.lang as Lang, channelId: m.channel_id, hook: new WebhookClient({ id: m.webhook_id, token: m.webhook_token }) });
      }
    }
    return out.sort((a, b) => (a.lang === "en" ? -1 : b.lang === "en" ? 1 : 0));
  }

  /** The English embed in each target language, one language per call so long cards fit. */
  async localize(embed: APIEmbed, langs: Lang[]): Promise<Map<Lang, APIEmbed>> {
    const out = new Map<Lang, APIEmbed>([["en" as Lang, embed]]);
    const glossary = await this.db.glossary(this.guild.id);
    const tok = strings(embed).map(tokenize);
    for (const l of langs.filter((l) => l !== "en")) {
      const r = await this.translator.translate(tok.map((x) => x.text), tok.map((x) => x.entities), "en" as Lang, [l], glossary);
      out.set(l, r.translated ? rebuild(embed, r.translations[l].map((s, i) => detokenize(s, tok[i].entities))) : embed);
    }
    return out;
  }

  private async avatarURL(): Promise<string | undefined> {
    return (await this.db.getSetting(this.guild.id, AVATAR_KEY)) ?? undefined;
  }

  /** Posts one card everywhere. Returns the message id per channel. */
  async post(embed: APIEmbed, image: Buffer, file: string, targets?: Target[]): Promise<Map<string, string>> {
    const ts = targets ?? (await this.targets());
    const local = await this.localize(embed, ts.map((t) => t.lang));
    const avatarURL = await this.avatarURL();
    const ids = new Map<string, string>();
    for (const t of ts) {
      const msg = await t.hook.send({
        username: "AlphanumetriX", avatarURL,
        embeds: [{ ...local.get(t.lang)!, image: { url: `attachment://${file}` } }],
        files: [{ attachment: image, name: file }],
        allowedMentions: { parse: [] },
      });
      ids.set(t.channelId, msg.id);
    }
    return ids;
  }

  /** Posts the board everywhere, pins it and remembers it so later signals can refresh it in place. */
  async postBoard(embed: APIEmbed, image: Buffer, targets?: Target[]) {
    const ts = targets ?? (await this.targets());
    const ids = await this.post(embed, image, "board.png", ts);
    for (const t of ts) {
      const id = ids.get(t.channelId)!;
      await this.db.setSetting(this.guild.id, boardKey(t.channelId), id);
      const ch = (await this.guild.channels.fetch(t.channelId)) as TextChannel;
      await ch.messages.pin(id).catch((e) => log.warn("board pin failed", { channel: t.channelId, ...errInfo(e) }));
      const notice = (await ch.messages.fetch({ limit: 5 })).find((m) => m.type === 6);
      await notice?.delete().catch(() => {});
    }
  }

  /** Edits each channel's pinned board in place; a channel without one gets a fresh board. */
  async refreshBoard(embed: APIEmbed, image: Buffer, targets?: Target[]) {
    const ts = targets ?? (await this.targets());
    const local = await this.localize(embed, ts.map((t) => t.lang));
    const missing: Target[] = [];
    for (const t of ts) {
      const id = await this.db.getSetting(this.guild.id, boardKey(t.channelId));
      const ok = id && (await t.hook.editMessage(id, {
        embeds: [{ ...local.get(t.lang)!, image: { url: "attachment://board.png" } }],
        files: [{ attachment: image, name: "board.png" }],
        attachments: [],
      }).then(() => true, (e) => { log.warn("board edit failed", { channel: t.channelId, ...errInfo(e) }); return false; }));
      if (!ok) missing.push(t);
    }
    if (missing.length) await this.postBoard(embed, image, missing);
  }

  async setAvatar(url: string) {
    await this.db.setSetting(this.guild.id, AVATAR_KEY, url);
  }
}

/**
 * Watches blkbox.tradingview_signal_events (through the flagship watcher's
 * client) and, for each new BTC signal, posts its card to every language and
 * refreshes the pinned board. The first run only records where the history
 * stands, since scripts/post-signals.ts posts the history itself.
 */
export class SignalFeed {
  private poster: SignalPoster;

  constructor(private guild: Guild, private db: Db, translator: Translator, private sb: SupabaseClient<any, any, any>) {
    this.poster = new SignalPoster(guild, db, translator);
  }

  async events(): Promise<SignalEvent[]> {
    const { data, error } = await this.sb.from("tradingview_signal_events").select("id, symbol, signal, direction, fired_at, price, received_at, raw").eq("symbol", "BTC").order("id");
    if (error) throw new Error(`signal events: ${error.message}`);
    return toEvents((data ?? []) as EventRow[]);
  }

  async check() {
    const events = await this.events();
    if (!events.length) return;
    const lastSetting = await this.db.getSetting(this.guild.id, LAST);
    if (lastSetting === null) {
      await this.db.setSetting(this.guild.id, LAST, String(events.at(-1)!.id));
      log.info("signal feed baseline", { last: events.at(-1)!.id });
      return;
    }
    const fresh = events.map((e, i) => ({ e, i })).filter(({ e }) => e.id > Number(lastSetting));
    if (!fresh.length) return;
    await this.publish(events, fresh.map(({ i }) => i));
  }

  /** Posts the cards for events[indexes] and refreshes the board. Exposed for testing. */
  async publish(events: SignalEvent[], indexes: number[]) {
    const targets = await this.poster.targets();
    for (const i of indexes) {
      const e = events[i];
      await this.poster.post(signalEmbed(events, i), await renderSignalImage(cardSpec(events, i)), `signal-${e.n}.png`, targets);
      await this.db.setSetting(this.guild.id, LAST, String(e.id));
      log.info("signal posted", { id: e.id, signal: e.name, bull: e.bull, channels: targets.length });
    }
    await this.poster.refreshBoard(boardEmbed(events), await renderSignalImage(boardSpec(events)), targets);
  }

  start(minutes = 5) {
    const run = () => void this.check().catch((e) => log.warn("signal feed check failed", errInfo(e)));
    run();
    setInterval(run, minutes * 60_000).unref();
  }
}
