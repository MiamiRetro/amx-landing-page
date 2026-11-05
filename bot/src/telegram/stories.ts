/**
 * Tone's Telegram stories into Discord general.
 *
 * Bots can't see stories, so this logs in as a plain Telegram account
 * (MTProto, via GramJS) that can view the host's stories, checks every few
 * minutes, and posts each new one through the bridge's webhook under the
 * host's name and picture. The session string comes from
 * `npm run tg:login` and lives only in Railway (TELEGRAM_STORIES_SESSION).
 */
import { Api, TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import type { Db } from "../db/index.js";
import { log, errInfo } from "../log.js";
import { isChannelKey, type ChannelKey } from "./classify.js";
import type { TelegramBridge } from "./bridge.js";

export const STORY_LINE = "-# story via Telegram";

/** Discord's upload cap for a server without boost level 2. */
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

export interface StoryOptions {
  apiId: number;
  apiHash: string;
  session: string;
  /** Telegram usernames whose stories are shared. */
  peers: string[];
  channel: ChannelKey;
  bridge: TelegramBridge;
  db: Db;
  guildId: string;
  pollMs: number;
  maxBytes?: number;
}

export interface StoriesEnv {
  TELEGRAM_STORIES_API_ID?: string;
  TELEGRAM_STORIES_API_HASH?: string;
  TELEGRAM_STORIES_SESSION?: string;
  TELEGRAM_STORIES_FROM?: string;
  TELEGRAM_STORIES_CHANNEL?: string;
  TELEGRAM_STORIES_POLL_MIN?: string;
  TELEGRAM_STORIES_MAX_MB?: string;
}

/** Settings from env, or null when the watcher isn't set up (or is switched off). */
export function storiesConfig(env: StoriesEnv) {
  const apiId = Number(env.TELEGRAM_STORIES_API_ID?.trim());
  const apiHash = env.TELEGRAM_STORIES_API_HASH?.trim();
  const session = env.TELEGRAM_STORIES_SESSION?.trim();
  if (!apiId || !apiHash || !session) return null;
  const peers = (env.TELEGRAM_STORIES_FROM?.trim() || "ToneVays").split(/[\s,]+/).map((p) => p.replace(/^@/, "")).filter(Boolean);
  if (!peers.length || peers[0] === "off") return null;
  const ch = env.TELEGRAM_STORIES_CHANNEL?.trim().toLowerCase() || "general";
  const pollMin = Math.max(1, Number(env.TELEGRAM_STORIES_POLL_MIN) || 5);
  const maxMb = Number(env.TELEGRAM_STORIES_MAX_MB) || DEFAULT_MAX_BYTES / 1024 / 1024;
  return { apiId, apiHash, session, peers, channel: (isChannelKey(ch) ? ch : "general") as ChannelKey, pollMs: pollMin * 60_000, maxBytes: Math.round(maxMb * 1024 * 1024) };
}

/**
 * Stories newer than the last one shared, oldest first. With nothing shared
 * yet the current ones only set the starting point, so turning this on
 * doesn't dump a day of old stories into general.
 */
export function newStoryIds(ids: number[], last: number | null): { post: number[]; last: number | null } {
  const max = ids.length ? Math.max(...ids) : null;
  if (last == null) return { post: [], last: max };
  const post = ids.filter((id) => id > last).sort((a, b) => a - b);
  return { post, last: max != null && max > last ? max : last };
}

/** The text under a story: its caption, then the grey label. */
export function storyText(caption?: string | null): string {
  const c = caption?.trim();
  return c ? `${c}\n${STORY_LINE}` : STORY_LINE;
}

/** The public link to a story, for when the file is too big to upload. */
export function storyLink(peer: string, id: number): string {
  return `https://t.me/${peer}/s/${id}`;
}

interface DocLike {
  size: number | bigint | { toJSNumber?: () => number; toString(): string };
  mimeType: string;
}

function sizeOf(d: DocLike): number {
  const s = d.size as unknown;
  if (typeof s === "number") return s;
  if (typeof s === "bigint") return Number(s);
  return Number(String(s));
}

/** The best video that fits the upload cap: the main file, else the largest smaller copy Telegram keeps. */
export function pickVideo<T extends DocLike>(main: T | undefined, alts: T[] | undefined, maxBytes: number): T | null {
  const all = [main, ...(alts ?? [])].filter((d): d is T => !!d && d.mimeType.startsWith("video/"));
  const fits = all.filter((d) => sizeOf(d) <= maxBytes).sort((a, b) => sizeOf(b) - sizeOf(a));
  return fits[0] ?? null;
}

export class StoryWatcher {
  private client: TelegramClient;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private maxBytes: number;

  constructor(private opts: StoryOptions) {
    this.client = new TelegramClient(new StringSession(opts.session), opts.apiId, opts.apiHash, { connectionRetries: 5 });
    this.client.setLogLevel("error" as never);
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  async start() {
    await this.client.connect();
    if (!(await this.client.checkAuthorization())) throw new Error("TELEGRAM_STORIES_SESSION is not logged in; run npm run tg:login again");
    const me = (await this.client.getMe()) as Api.User;
    log.info("telegram stories on", { as: me.username ?? me.id.toString(), from: this.opts.peers, channel: this.opts.channel, everyMin: this.opts.pollMs / 60_000 });
    await this.tick();
    this.timer = setInterval(() => void this.tick(), this.opts.pollMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    void this.client.disconnect().catch(() => {});
  }

  private async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const peer of this.opts.peers) await this.check(peer).catch((e) => log.warn("telegram stories check failed", { peer, ...errInfo(e) }));
    } finally {
      this.busy = false;
    }
  }

  private key(peer: string) {
    return `tg:story:${peer.toLowerCase()}`;
  }

  private async check(peer: string) {
    const res = await this.client.invoke(new Api.stories.GetPeerStories({ peer }));
    const items = res.stories.stories.filter((s) => !(s instanceof Api.StoryItemDeleted));
    const saved = await this.opts.db.getSetting(this.opts.guildId, this.key(peer));
    const { post, last } = newStoryIds(items.map((s) => s.id), saved ? Number(saved) : null);
    if (!post.length) {
      if (last != null && String(last) !== saved) await this.opts.db.setSetting(this.opts.guildId, this.key(peer), String(last));
      return;
    }
    // Lists can hold "skipped" stubs; fetch those in full.
    const full = new Map<number, Api.StoryItem>();
    for (const s of items) if (s instanceof Api.StoryItem) full.set(s.id, s);
    const missing = post.filter((id) => !full.has(id));
    if (missing.length) {
      const more = await this.client.invoke(new Api.stories.GetStoriesByID({ peer, id: missing }));
      for (const s of more.stories) if (s instanceof Api.StoryItem) full.set(s.id, s);
    }
    for (const id of post) {
      const story = full.get(id);
      if (story) await this.share(peer, story);
      // Saved after each one, so a crash mid-way never posts a story twice.
      await this.opts.db.setSetting(this.opts.guildId, this.key(peer), String(id));
    }
  }

  private async share(peer: string, story: Api.StoryItem) {
    const files: { attachment: Buffer; name: string }[] = [];
    let text = storyText(story.caption);
    const media = story.media;
    if (media instanceof Api.MessageMediaPhoto) {
      const buf = await this.client.downloadMedia(media, {});
      if (Buffer.isBuffer(buf)) files.push({ attachment: buf, name: `story-${story.id}.jpg` });
    } else if (media instanceof Api.MessageMediaDocument) {
      const docs = [media.document, ...(media.altDocuments ?? [])].filter((d): d is Api.Document => d instanceof Api.Document);
      const pick = pickVideo(docs[0], docs.slice(1), this.maxBytes);
      if (pick) {
        const buf = await this.client.downloadFile(
          new Api.InputDocumentFileLocation({ id: pick.id, accessHash: pick.accessHash, fileReference: pick.fileReference, thumbSize: "" }),
          { dcId: pick.dcId, fileSize: pick.size },
        );
        if (Buffer.isBuffer(buf)) files.push({ attachment: buf, name: `story-${story.id}.mp4` });
      }
    }
    // Too big to upload (or nothing to download): link to it instead.
    if (!files.length) text = `${story.caption?.trim() ? `${story.caption.trim()}\n` : ""}${storyLink(peer, story.id)}\n${STORY_LINE}`;
    const id = await this.opts.bridge.postStory(peer, this.opts.channel, text, files);
    log.info("telegram story shared", { peer, story: story.id, discord: id, file: files[0]?.name ?? null });
  }
}
