import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Guild } from "discord.js";
import type { Db } from "./db/index.js";
import { log, errInfo } from "./log.js";

/**
 * Keeps the AlphanumetriX channel's icon in line with the BTC strategy card on
 * the new dashboard (blkbox-frontend, src/overview/market-regimes.ts
 * btcStrategyScale): count how many of the latest weekly_diamond,
 * three_day_cross and wave_flip events are bullish.
 *
 *   3 → Strong Bull Trend  🟢🟢
 *   2 → Leaning Bullish    🟡🟢
 *   1 → Leaning Bearish    🔴🟡
 *   0 → Strong Bear Trend  🔴🔴
 *
 * It reads blkbox.tradingview_signal_events through SignalSource (the
 * public.signal_feed RPC). /flagship still sets it by hand and
 * wins until the signals next change.
 */
export type FlagshipState = "strong-bull" | "lean-bull" | "lean-bear" | "strong-bear";
export const ICONS: Record<FlagshipState, string> = { "strong-bull": "🟢🟢", "lean-bull": "🟡🟢", "lean-bear": "🔴🟡", "strong-bear": "🔴🔴" };
export const LABELS: Record<FlagshipState, string> = { "strong-bull": "Strong Bull Trend", "lean-bull": "Leaning Bullish", "lean-bear": "Leaning Bearish", "strong-bear": "Strong Bear Trend" };
const BY_COUNT: FlagshipState[] = ["strong-bear", "lean-bear", "lean-bull", "strong-bull"];
/** Any state prefix, old single-emoji ones included, so channels migrate on the first update; behind the ┣/┗ branch of the folder-style layout when there is one. */
export const STATE_PREFIX = /^([┣┗]?)[🟢🟡🔴]{1,2}・/u;

interface Event { signal: string; direction: string; fired_at: string }

/** Bullish signals among the latest event per signal. A signal that never fired counts as bearish. */
export function bullishCount(events: Event[]): number {
  const latest = new Map<string, Event>();
  for (const e of events) {
    const cur = latest.get(e.signal);
    if (!cur || Date.parse(e.fired_at) > Date.parse(cur.fired_at)) latest.set(e.signal, e);
  }
  return ["weekly_diamond", "three_day_cross", "wave_flip"].filter((s) => latest.get(s)?.direction === "bullish").length;
}

export function stateOf(events: Event[]): FlagshipState {
  return BY_COUNT[bullishCount(events)];
}

/** Renames every language's AlphanumetriX channel to lead with `state`. Returns how many changed. */
export async function applyFlagship(guild: Guild, state: FlagshipState, reason: string): Promise<{ changed: number; total: number; failed: string[] }> {
  const icon = ICONS[state];
  const channels = guild.channels.cache.filter((c) => STATE_PREFIX.test(c.name) && c.name.endsWith("・alphanumetrix"));
  let changed = 0;
  const failed: string[] = [];
  for (const c of channels.values()) {
    const name = c.name.replace(STATE_PREFIX, `$1${icon}・`);
    if (name === c.name) continue;
    try {
      await c.setName(name, reason);
      changed++;
    } catch (e) {
      failed.push(e instanceof Error ? e.message : String(e)); // two renames per channel per 10 min
    }
  }
  return { changed, total: channels.size, failed };
}

/** A row of blkbox.tradingview_signal_events as public.signal_feed returns it (never the raw payload). */
export interface SignalRow { id: number; symbol: string; signal: string; direction: string; fired_at: string; price: string | number | null; received_at: string }

/**
 * Read-only access to the dashboard's signal log through the public.signal_feed
 * RPC: the publishable key plus a feed token whose hash the database holds, so
 * the bot never needs the service-role key or sees the webhook secret.
 */
export class SignalSource {
  private sb: SupabaseClient<any, any, any>;

  constructor(url: string, key: string, private token: string) {
    this.sb = createClient(url, key, { auth: { persistSession: false } });
  }

  /** FLAGSHIP_SUPABASE_URL, FLAGSHIP_SUPABASE_KEY (publishable) and SIGNAL_FEED_TOKEN, or null when any is missing. */
  static fromEnv(): SignalSource | null {
    const url = process.env.FLAGSHIP_SUPABASE_URL?.trim(), key = process.env.FLAGSHIP_SUPABASE_KEY?.trim(), token = process.env.SIGNAL_FEED_TOKEN?.trim();
    return url && key && token ? new SignalSource(url, key, token) : null;
  }

  /** Every row after `afterId`, oldest first. */
  async read(afterId = 0): Promise<SignalRow[]> {
    const out: SignalRow[] = [];
    for (;;) {
      const { data, error } = await this.sb.rpc("signal_feed", { p_token: this.token, p_after_id: out.at(-1)?.id ?? afterId, p_limit: 100 });
      if (error) throw new Error(`signal feed: ${error.message}`);
      const rows = (data ?? []) as SignalRow[];
      out.push(...rows);
      if (rows.length < 100) return out;
    }
  }
}

export class FlagshipWatch {
  private source = SignalSource.fromEnv();

  constructor(private guild: Guild, private db: Db) {}

  get enabled() {
    return this.source !== null;
  }

  /** The read access to the dashboard's signals, shared with the signal feed. */
  get signals() {
    return this.source;
  }

  async check() {
    if (!this.source) return;
    const state = stateOf((await this.source.read()).filter((r) => r.symbol === "BTC"));
    // Only act on a change of the signals' own reading, so a manual /flagship holds until the signals move.
    const last = await this.db.getSetting(this.guild.id, "flagship:signals");
    if (last === state) return;
    const r = await applyFlagship(this.guild, state, `AlphanumetriX: ${LABELS[state]}`);
    await this.db.setSetting(this.guild.id, "flagship:signals", state);
    await this.db.setSetting(this.guild.id, "flagship:state", state);
    log.info("flagship state from signals", { state, ...r, failed: r.failed.length });
  }

  start(minutes = 15) {
    if (!this.source) return;
    const run = () => void this.check().catch((e) => log.warn("flagship check failed", errInfo(e)));
    run();
    setInterval(run, minutes * 60_000).unref();
  }
}
