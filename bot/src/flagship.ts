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
 * It reads blkbox.tradingview_signal_events with FLAGSHIP_SUPABASE_URL /
 * FLAGSHIP_SUPABASE_KEY (service role). /flagship still sets it by hand and
 * wins until the signals next change.
 */
export type FlagshipState = "strong-bull" | "lean-bull" | "lean-bear" | "strong-bear";
export const ICONS: Record<FlagshipState, string> = { "strong-bull": "🟢🟢", "lean-bull": "🟡🟢", "lean-bear": "🔴🟡", "strong-bear": "🔴🔴" };
export const LABELS: Record<FlagshipState, string> = { "strong-bull": "Strong Bull Trend", "lean-bull": "Leaning Bullish", "lean-bear": "Leaning Bearish", "strong-bear": "Strong Bear Trend" };
const BY_COUNT: FlagshipState[] = ["strong-bear", "lean-bear", "lean-bull", "strong-bull"];
/** Any state prefix, old single-emoji ones included, so channels migrate on the first update; behind the ┣ branch of the folder-style layout when there is one. */
export const STATE_PREFIX = /^(┣?)[🟢🟡🔴]{1,2}・/u;

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

export class FlagshipWatch {
  private sb: SupabaseClient<any, any, any> | null;

  constructor(private guild: Guild, private db: Db) {
    const url = process.env.FLAGSHIP_SUPABASE_URL?.trim(), key = process.env.FLAGSHIP_SUPABASE_KEY?.trim();
    this.sb = url && key ? createClient(url, key, { auth: { persistSession: false }, db: { schema: "blkbox" } }) : null;
  }

  get enabled() {
    return this.sb !== null;
  }

  async check() {
    if (!this.sb) return;
    const { data, error } = await this.sb.from("tradingview_signal_events").select("signal, direction, fired_at").eq("symbol", "BTC").order("fired_at", { ascending: false }).limit(200);
    if (error) throw new Error(`signal events: ${error.message}`);
    const state = stateOf((data ?? []) as Event[]);
    // Only act on a change of the signals' own reading, so a manual /flagship holds until the signals move.
    const last = await this.db.getSetting(this.guild.id, "flagship:signals");
    if (last === state) return;
    const r = await applyFlagship(this.guild, state, `AlphanumetriX: ${LABELS[state]}`);
    await this.db.setSetting(this.guild.id, "flagship:signals", state);
    await this.db.setSetting(this.guild.id, "flagship:state", state);
    log.info("flagship state from signals", { state, ...r, failed: r.failed.length });
  }

  start(minutes = 15) {
    if (!this.sb) return;
    const run = () => void this.check().catch((e) => log.warn("flagship check failed", errInfo(e)));
    run();
    setInterval(run, minutes * 60_000).unref();
  }
}
