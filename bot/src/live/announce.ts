import type { Guild } from "discord.js";
import type { Lang } from "../config.js";
import type { Db } from "../db/index.js";
import { groupTargets } from "../lib/groupHooks.js";
import { errInfo, log } from "../log.js";
import { notifyRole } from "../notify.js";
import { checkLive, PLATFORM_LABEL, PLATFORMS, type WatchPlatform } from "./detect.js";

/** Where go-live alerts go: every language's announcements channel. */
export const LIVE_GROUP = "announcements";
const WATCHES = "live:watches";
const seenKey = (w: Watch) => `live:seen:${w.platform}:${w.channel.toLowerCase()}`;
const lastKey = (who: string) => `live:last:${who.toLowerCase()}`;
/** A stream that drops and comes back, or a manual alert followed by the watcher's, posts once. */
const COOLDOWN_MS = 2 * 60 * 60_000;

export interface Watch { who: string; platform: WatchPlatform; channel: string }
export interface Stream { who: string; platform: string; url: string; title?: string }

/** "LIVE NOW" and the words before the link, per language. Names, titles and platforms stay as they are. */
export const LIVE_TEXT: Record<Lang, { live: string; join: string }> = {
  en: { live: "LIVE NOW", join: "Join the stream:" },
  zh: { live: "正在直播", join: "点击观看直播：" },
  ko: { live: "지금 라이브", join: "라이브 보러 가기:" },
  id: { live: "LIVE SEKARANG", join: "Tonton streamingnya:" },
  vi: { live: "ĐANG LIVE", join: "Xem livestream:" },
  es: { live: "EN VIVO AHORA", join: "Únete al directo:" },
  pt: { live: "AO VIVO AGORA", join: "Entre na live:" },
  tr: { live: "ŞU AN CANLI", join: "Yayına katıl:" },
  ru: { live: "СЕЙЧАС В ЭФИРЕ", join: "Смотреть стрим:" },
  ja: { live: "ライブ配信中", join: "配信はこちら：" },
};

/** One language's alert. The link stays bare so Discord shows the player under it. */
export function liveMessage(lang: Lang, s: Stream, roleId?: string): string {
  const t = LIVE_TEXT[lang] ?? LIVE_TEXT.en;
  const where = s.platform ? ` · ${s.platform}` : "";
  const title = s.title?.trim() ? `\n> ${s.title.trim().replace(/\s+/g, " ").slice(0, 200)}` : "";
  return `${roleId ? `<@&${roleId}> ` : ""}🔴 **${t.live}** · **${s.who}**${where}${title}\n${t.join} ${s.url}`;
}

export class LiveAnnouncer {
  private busy = false;

  constructor(private guild: Guild, private db: Db) {}

  /** Posts the alert in every language's announcements channel, pinging 🔔 Videos & Streams. Returns the channels. */
  async announce(s: Stream): Promise<string[]> {
    const role = await notifyRole(this.guild, this.db, "videos");
    if (!role) log.warn("live alert without a role: no 🔔 Videos & Streams role");
    const targets = await groupTargets(this.guild, this.db, LIVE_GROUP, "go-live alerts");
    const avatarURL = this.guild.client.user?.displayAvatarURL({ extension: "png", size: 256 });
    const posted: string[] = [];
    for (const t of targets) {
      try {
        await t.hook.send({
          content: liveMessage(t.lang, s, role?.id),
          username: "BLKBöX Live",
          avatarURL,
          allowedMentions: { parse: [], roles: role ? [role.id] : [] },
        });
        posted.push(t.channelId);
      } catch (e) {
        log.warn("live alert failed", { channel: t.channelId, lang: t.lang, ...errInfo(e) });
      }
    }
    await this.db.setSetting(this.guild.id, lastKey(s.who), String(Date.now()));
    log.info("live alert posted", { who: s.who, platform: s.platform, url: s.url, channels: posted.length });
    return posted;
  }

  async watches(): Promise<Watch[]> {
    const raw = await this.db.getSetting(this.guild.id, WATCHES);
    return raw ? (JSON.parse(raw) as Watch[]) : [];
  }

  async watch(w: Watch) {
    const all = (await this.watches()).filter((x) => !(x.who.toLowerCase() === w.who.toLowerCase() && x.platform === w.platform));
    all.push(w);
    await this.db.setSetting(this.guild.id, WATCHES, JSON.stringify(all));
  }

  async unwatch(who: string, platform: WatchPlatform): Promise<boolean> {
    const all = await this.watches();
    const left = all.filter((x) => !(x.who.toLowerCase() === who.toLowerCase() && x.platform === platform));
    await this.db.setSetting(this.guild.id, WATCHES, JSON.stringify(left));
    return left.length !== all.length;
  }

  /** Looks at every watched channel once; a new broadcast gets one alert. */
  async check() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const w of await this.watches()) {
        if (!PLATFORMS.includes(w.platform)) continue;
        const live = await checkLive(w.platform, w.channel).catch((e) => { log.warn("live check failed", { ...w, ...errInfo(e) }); return null; });
        if (!live) continue;
        if ((await this.db.getSetting(this.guild.id, seenKey(w))) === live.id) continue;
        await this.db.setSetting(this.guild.id, seenKey(w), live.id);
        const last = Number((await this.db.getSetting(this.guild.id, lastKey(w.who))) ?? 0);
        if (Date.now() - last < COOLDOWN_MS) { log.info("live alert skipped: posted recently", { who: w.who, id: live.id }); continue; }
        await this.announce({ who: w.who, platform: PLATFORM_LABEL[w.platform], url: live.url, title: live.title });
      }
    } finally {
      this.busy = false;
    }
  }

  start(minutes = 2) {
    const run = () => void this.check().catch((e) => log.warn("live watch failed", errInfo(e)));
    run();
    setInterval(run, minutes * 60_000).unref();
  }
}
