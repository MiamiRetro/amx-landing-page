import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Guild } from "discord.js";
import type { Db } from "./db/index.js";
import { log, errInfo } from "./log.js";

/**
 * Keeps the AlphanumetriX channel's 🟢/🟡/🔴 in line with the dashboard's
 * headline for BTC. The dashboard (blkbox-platform, apps/api/src/services/
 * alphanumetrics/copy.ts) takes the latest weekly_diamond, three_day_cross and
 * wave_flip events and maps them:
 *
 *   diamond green + cross bull + sar bull   → max-bull   🟢
 *   diamond neutral + cross bull + sar bull → bull       🟡
 *   diamond neutral + cross bear + sar bear → max-bear   🔴
 *   anything else                            → mixed      🟡
 *
 * It reads blkbox.tradingview_signal_events from the platform's Supabase with
 * FLAGSHIP_SUPABASE_URL / FLAGSHIP_SUPABASE_KEY (service role; the table's RLS
 * denies anon). /flagship still sets it by hand and wins until the next change.
 */
export type Severity = "max-bull" | "bull" | "mixed" | "bear" | "max-bear";
export type FlagshipState = "bullish" | "caution" | "bearish";
export const ICONS: Record<FlagshipState, string> = { bullish: "🟢", caution: "🟡", bearish: "🔴" };

interface Event { signal: string; direction: string; fired_at: string }

/** The dashboard's rule, ported as-is. A signal that never fired counts as bearish. */
export function severityOf(events: Event[]): Severity {
  const latest = new Map<string, Event>();
  for (const e of events) {
    const cur = latest.get(e.signal);
    if (!cur || Date.parse(e.fired_at) > Date.parse(cur.fired_at)) latest.set(e.signal, e);
  }
  const diamond = latest.get("weekly_diamond")?.direction === "bullish" ? "green" : "neutral";
  const cross = latest.get("three_day_cross")?.direction === "bullish" ? "bull" : "bear";
  const sar = latest.get("wave_flip")?.direction === "bullish" ? "bull" : "bear";
  if (diamond === "green" && cross === "bull" && sar === "bull") return "max-bull";
  if (diamond === "neutral" && cross === "bull" && sar === "bull") return "bull";
  if (diamond === "neutral" && cross === "bear" && sar === "bear") return "max-bear";
  return "mixed";
}

export function stateOf(sev: Severity): FlagshipState {
  return sev === "max-bull" ? "bullish" : sev === "bear" || sev === "max-bear" ? "bearish" : "caution";
}

/** Renames every language's AlphanumetriX channel to lead with `state`. Returns how many changed. */
export async function applyFlagship(guild: Guild, state: FlagshipState, reason: string): Promise<{ changed: number; total: number; failed: string[] }> {
  const icon = ICONS[state];
  const channels = guild.channels.cache.filter((c) => /^(🟢|🟡|🔴)・alphanumetrix$/.test(c.name));
  let changed = 0;
  const failed: string[] = [];
  for (const c of channels.values()) {
    const name = c.name.replace(/^(🟢|🟡|🔴)/, icon);
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
    const sev = severityOf((data ?? []) as Event[]);
    const state = stateOf(sev);
    // Only act on a change of the dashboard's own reading, so a manual /flagship holds until the signals move.
    const last = await this.db.getSetting(this.guild.id, "flagship:severity");
    if (last === sev) return;
    const r = await applyFlagship(this.guild, state, `AlphanumetriX dashboard: ${sev}`);
    await this.db.setSetting(this.guild.id, "flagship:severity", sev);
    await this.db.setSetting(this.guild.id, "flagship:state", state);
    log.info("flagship state from dashboard", { severity: sev, state, ...r, failed: r.failed.length });
  }

  start(minutes = 15) {
    if (!this.sb) return;
    const run = () => void this.check().catch((e) => log.warn("flagship check failed", errInfo(e)));
    run();
    setInterval(run, minutes * 60_000).unref();
  }
}
