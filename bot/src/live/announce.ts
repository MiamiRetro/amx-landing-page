import type { Guild } from "discord.js";
import type { Lang } from "../config.js";
import type { Db } from "../db/index.js";
import { groupTargets } from "../lib/groupHooks.js";
import { errInfo, log } from "../log.js";
import { notifyRole } from "../notify.js";
import { checkLive, PLATFORM_LABEL, PLATFORMS, youtubeApiLive, youtubeChannelId, youtubeLiveProbe, youtubeLongUploads, youtubeStreamCandidates, youtubeVideoProbe, type LiveNow, type Upcoming, type WatchPlatform } from "./detect.js";

/** Where go-live alerts go: every language's announcements channel. */
export const LIVE_GROUP = "announcements";
const WATCHES = "live:watches";
const seenKey = (w: Watch) => `live:seen:${w.platform}:${w.channel.toLowerCase()}`;
const lastKey = (who: string) => `live:last:${who.toLowerCase()}`;
/** A stream that drops and comes back, or a manual alert followed by the watcher's, posts once. */
const COOLDOWN_MS = 2 * 60 * 60_000;

export interface Watch { who: string; platform: WatchPlatform; channel: string }
export interface Stream { who: string; platform: string; url: string; title?: string; kind?: "live" | "video" | "soon"; startsAt?: string }

const soonKey = (id: string) => `live:soon:${id}`;
/** A scheduled stream gets its heads-up this long before it starts. */
const HEADS_UP_MS = 10 * 60_000;

const channelIdKey = (handle: string) => `live:ytid:${handle.toLowerCase()}`;
const videosKey = (channelId: string) => `live:videos:${channelId}`;
/** A video older than this is history, not news: a feed that reshuffles never posts it. */
const VIDEO_MAX_AGE_MS = 24 * 60 * 60_000;

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

/** "NEW VIDEO" and the words before the link, per language. */
export const VIDEO_TEXT: Record<Lang, { video: string; watch: string }> = {
  en: { video: "NEW VIDEO", watch: "Watch now:" },
  zh: { video: "新视频", watch: "立即观看：" },
  ko: { video: "새 영상", watch: "지금 보기:" },
  id: { video: "VIDEO BARU", watch: "Tonton sekarang:" },
  vi: { video: "VIDEO MỚI", watch: "Xem ngay:" },
  es: { video: "NUEVO VIDEO", watch: "Míralo ya:" },
  pt: { video: "VÍDEO NOVO", watch: "Assista agora:" },
  tr: { video: "YENİ VİDEO", watch: "Hemen izle:" },
  ru: { video: "НОВОЕ ВИДЕО", watch: "Смотреть:" },
  ja: { video: "新着動画", watch: "今すぐ見る：" },
};

/** "STARTING SOON" and the words before the start time, per language. The time is a Discord timestamp, shown in each reader's own language and time zone. */
export const SOON_TEXT: Record<Lang, { soon: string; starts: string }> = {
  en: { soon: "STARTING SOON", starts: "Starts" },
  zh: { soon: "即将开播", starts: "开播时间" },
  ko: { soon: "곧 시작", starts: "시작" },
  id: { soon: "SEGERA MULAI", starts: "Mulai" },
  vi: { soon: "SẮP BẮT ĐẦU", starts: "Bắt đầu" },
  es: { soon: "EMPIEZA PRONTO", starts: "Empieza" },
  pt: { soon: "COMEÇA EM BREVE", starts: "Começa" },
  tr: { soon: "BİRAZDAN BAŞLIYOR", starts: "Başlangıç" },
  ru: { soon: "СКОРО НАЧАЛО", starts: "Начало" },
  ja: { soon: "まもなく配信開始", starts: "開始" },
};

/** One language's alert. The link stays bare so Discord shows the player under it. */
export function liveMessage(lang: Lang, s: Stream, roleId?: string): string {
  const unix = s.startsAt ? Math.floor(Date.parse(s.startsAt) / 1000) : 0;
  const [icon, head, cta] = s.kind === "video"
    ? ["🎬", (VIDEO_TEXT[lang] ?? VIDEO_TEXT.en).video, (VIDEO_TEXT[lang] ?? VIDEO_TEXT.en).watch]
    : s.kind === "soon"
      ? ["⏰", (SOON_TEXT[lang] ?? SOON_TEXT.en).soon, `${(SOON_TEXT[lang] ?? SOON_TEXT.en).starts} <t:${unix}:R> (<t:${unix}:t>):`]
      : ["🔴", (LIVE_TEXT[lang] ?? LIVE_TEXT.en).live, (LIVE_TEXT[lang] ?? LIVE_TEXT.en).join];
  const where = s.platform ? ` · ${s.platform}` : "";
  const title = s.title?.trim() ? `\n> ${s.title.trim().replace(/\s+/g, " ").slice(0, 200)}` : "";
  return `${roleId ? `<@&${roleId}> ` : ""}${icon} **${head}** · **${s.who}**${where}${title}\n${cta} ${s.url}`;
}

export class LiveAnnouncer {
  private busy = false;
  private videoBusy = false;
  /** Videos known not to be on air for good: finished streams, plain uploads, shorts. */
  private done = new Set<string>();
  /** What each channel's /live page showed last, so a change gets one log line. */
  private lastShown = new Map<string, string>();

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
          username: s.kind === "video" ? "BLKBöX Videos" : "BLKBöX Live",
          avatarURL,
          allowedMentions: { parse: [], roles: role ? [role.id] : [] },
        });
        posted.push(t.channelId);
      } catch (e) {
        log.warn("live alert failed", { channel: t.channelId, lang: t.lang, ...errInfo(e) });
      }
    }
    if (!s.kind || s.kind === "live") await this.db.setSetting(this.guild.id, lastKey(s.who), String(Date.now()));
    log.info("live alert posted", { kind: s.kind ?? "live", who: s.who, platform: s.platform, url: s.url, channels: posted.length });
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
  /** Looks at every watched channel once, all at the same time; a new broadcast gets one alert. */
  async check() {
    if (this.busy) return;
    this.busy = true;
    try {
      const watches = (await this.watches()).filter((w) => PLATFORMS.includes(w.platform));
      await Promise.all(watches.map((w) => this.checkOne(w).catch((e) => log.warn("live check failed", { ...w, ...errInfo(e) }))));
    } finally {
      this.busy = false;
    }
  }

  private async checkOne(w: Watch) {
    if (w.platform !== "youtube") {
      const live = await checkLive(w.platform, w.channel);
      if (live) await this.onAir(w, live);
      return;
    }
    // 1. The channel's /live page: usually the stream on air.
    const probe = await youtubeLiveProbe(w.channel).catch((e) => { log.warn("live page check failed", { ...w, ...errInfo(e) }); return null; });
    if (probe?.live) return this.onAir(w, probe.live);
    if (probe?.upcoming && probe.videoId && probe.scheduledAt) {
      await this.headsUp(w, { id: probe.videoId, url: `https://www.youtube.com/watch?v=${probe.videoId}`, title: "", scheduledAt: probe.scheduledAt });
    }
    const shows = probe ? `${probe.videoId ?? "-"}:${probe.player ? "" : "noplayer:"}${probe.upcoming ? "upcoming" : probe.ended ? "ended" : "idle"}` : "error";
    if (this.lastShown.get(w.channel) !== shows) { this.lastShown.set(w.channel, shows); log.info("live page shows no stream on air", { who: w.who, shows }); }
    // 2. The /live page can show a scheduled stream while another is on air: check the newest broadcasts one by one.
    const channelId = await this.channelId(w);
    const seen = await this.db.getSetting(this.guild.id, seenKey(w));
    const ids = (await youtubeStreamCandidates(channelId)).map((u) => u.id).filter((id) => id !== seen && !this.done.has(id));
    if (!ids.length) return;
    const api = await youtubeApiLive(ids).catch((e) => { log.warn("youtube api check failed", { ...w, ...errInfo(e) }); return null; });
    if (api) {
      api.done.forEach((id) => this.done.add(id));
      for (const u of api.upcoming) await this.headsUp(w, u);
      if (api.live[0]) await this.onAir(w, api.live[0], "api");
      return;
    }
    for (const id of ids) {
      const p = await youtubeVideoProbe(id);
      if (p.live) return this.onAir(w, p.live, "watch page");
      if (p.upcoming && p.scheduledAt) await this.headsUp(w, { id, url: `https://www.youtube.com/watch?v=${id}`, title: "", scheduledAt: p.scheduledAt });
      if (!p.player) { log.warn("youtube served no player data", { who: w.who, id }); return; }
      if (p.ended || !p.stream) this.done.add(id);
    }
  }

  /**
   * A scheduled stream gets one "starting soon" alert once it is due within 10
   * minutes. A stream that starts without a schedule only gets the live alert.
   */
  private async headsUp(w: Watch, u: Upcoming) {
    const due = Date.parse(u.scheduledAt) - Date.now();
    if (!(due > 0 && due <= HEADS_UP_MS)) return;
    if (await this.db.getSetting(this.guild.id, soonKey(u.id))) return;
    await this.db.setSetting(this.guild.id, soonKey(u.id), u.scheduledAt);
    log.info("scheduled stream heads-up", { who: w.who, id: u.id, scheduledAt: u.scheduledAt });
    await this.announce({ who: w.who, platform: PLATFORM_LABEL[w.platform], url: u.url, title: u.title, kind: "soon", startsAt: u.scheduledAt });
  }

  private async channelId(w: Watch): Promise<string> {
    let id = await this.db.getSetting(this.guild.id, channelIdKey(w.channel));
    if (!id) {
      id = await youtubeChannelId(w.channel);
      await this.db.setSetting(this.guild.id, channelIdKey(w.channel), id);
    }
    return id;
  }

  /** A broadcast is on air: one alert per broadcast, none within the cooldown. */
  private async onAir(w: Watch, live: LiveNow, via = "live page") {
    if ((await this.db.getSetting(this.guild.id, seenKey(w))) === live.id) return;
    await this.db.setSetting(this.guild.id, seenKey(w), live.id);
    // How long after the stream started we noticed it, to keep an eye on the delay.
    const lagSec = live.startedAt ? Math.round((Date.now() - Date.parse(live.startedAt)) / 1000) : null;
    log.info("live stream detected", { who: w.who, id: live.id, via, startedAt: live.startedAt, lagSec });
    const last = Number((await this.db.getSetting(this.guild.id, lastKey(w.who))) ?? 0);
    if (Date.now() - last < COOLDOWN_MS) { log.info("live alert skipped: posted recently", { who: w.who, id: live.id }); return; }
    await this.announce({ who: w.who, platform: PLATFORM_LABEL[w.platform], url: live.url, title: live.title });
  }

  async checkAllVideos() {
    if (this.videoBusy) return;
    this.videoBusy = true;
    try {
      for (const w of (await this.watches()).filter((x) => x.platform === "youtube")) {
        await this.checkVideos(w).catch((e) => log.warn("video check failed", { ...w, ...errInfo(e) }));
      }
    } finally {
      this.videoBusy = false;
    }
  }

  /**
   * New full-length uploads (never shorts) get a "new video" alert. The first
   * look at a channel only records what is already there.
   */
  async checkVideos(w: Watch) {
    const channelId = await this.channelId(w);
    const uploads = await youtubeLongUploads(channelId);
    const raw = await this.db.getSetting(this.guild.id, videosKey(channelId));
    const seen = new Set<string>(raw ? (JSON.parse(raw) as string[]) : []);
    const fresh = raw === null ? [] : uploads.filter((u) => !seen.has(u.id) && Date.now() - Date.parse(u.published) < VIDEO_MAX_AGE_MS);
    if (raw === null || fresh.length) {
      const keep = [...new Set([...uploads.map((u) => u.id), ...seen])].slice(0, 50);
      await this.db.setSetting(this.guild.id, videosKey(channelId), JSON.stringify(keep));
    }
    if (raw === null) { log.info("video watch baseline", { who: w.who, channelId, videos: uploads.length }); return; }
    for (const u of fresh.reverse()) await this.announce({ who: w.who, platform: "YouTube", url: u.url, title: u.title, kind: "video" });
  }

  /**
   * Live checks run every LIVE_POLL_SEC seconds (default 30) so an alert lands
   * within about half a minute of YouTube showing the stream; new-video checks
   * are less urgent and run every 3 minutes.
   */
  start() {
    const liveSec = Math.max(15, Number(process.env.LIVE_POLL_SEC ?? 30));
    const live = () => void this.check().catch((e) => log.warn("live watch failed", errInfo(e)));
    live();
    setInterval(live, liveSec * 1000).unref();
    if (process.env.VIDEO_ALERTS !== "off") {
      const videos = () => void this.checkAllVideos().catch((e) => log.warn("video watch failed", errInfo(e)));
      videos();
      setInterval(videos, 3 * 60_000).unref();
    }
    log.info("live watch on", { liveSec });
  }

}
