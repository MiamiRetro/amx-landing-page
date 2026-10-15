import type { Guild, Role } from "discord.js";
import type { Db } from "../db/index.js";
import { log, errInfo } from "../log.js";
import type { AffiliateProvider, ExchangeId } from "../verify/types.js";
import { bitgetCommission, blofinCommission, bybitCommission, Prices, type Commission } from "./commission.js";

/**
 * VIP tiers from what we earn per member: once a week, every member with a
 * linked exchange UID gets their last-30-days commission totalled across
 * exchanges, stored as a snapshot, and the matching VIP role. Thresholds are
 * USD per 30 days, lowest first, in the `vip_tiers` setting.
 */
export const DEFAULT_TIERS = [1000, 2500, 5000, 10000];
const WEEK = 7 * 86_400_000;

/** 0 = no VIP, 1..n = VIP n. */
export function tierFor(usd: number, thresholds: number[]): number {
  let tier = 0;
  thresholds.forEach((t, i) => { if (usd >= t) tier = i + 1; });
  return tier;
}

export interface VipRow {
  userId: string;
  usd: number;
  tier: number;
  previous: number;
  parts: { exchange: ExchangeId; usd: number; method: Commission["method"] }[];
  errors: string[];
}

export class VipTracker {
  private running = false;

  constructor(private guild: Guild, private db: Db, private providers: Map<ExchangeId, AffiliateProvider>) {}

  async thresholds(): Promise<number[]> {
    const raw = await this.db.getSetting(this.guild.id, "vip_tiers");
    try {
      const t = raw ? (JSON.parse(raw) as number[]) : DEFAULT_TIERS;
      return Array.isArray(t) && t.every((n) => typeof n === "number") ? [...t].sort((a, b) => a - b) : DEFAULT_TIERS;
    } catch {
      return DEFAULT_TIERS;
    }
  }

  /** VIP 1..n roles, created when missing. */
  private async roles(n: number): Promise<Role[]> {
    await this.guild.roles.fetch();
    const out: Role[] = [];
    for (let i = 1; i <= n; i++) {
      const name = `VIP ${i}`;
      out.push(this.guild.roles.cache.find((r) => r.name === name) ?? (await this.guild.roles.create({ name, permissions: [], reason: "VIP tiers" })));
    }
    return out;
  }

  /** Blofin only reports lifetime commission; the snapshot from about four weeks ago turns it into 30 days. */
  private async lifetimeFromAMonthAgo(uid: string): Promise<number | null> {
    const now = Date.now();
    const r = await this.db.sb
      .from("commission_snapshots")
      .select("lifetime_usd, taken_at")
      .eq("exchange", "blofin")
      .eq("uid", uid)
      .lte("taken_at", new Date(now - 26 * 86_400_000).toISOString())
      .gte("taken_at", new Date(now - 40 * 86_400_000).toISOString())
      .not("lifetime_usd", "is", null)
      .order("taken_at", { ascending: false })
      .limit(1);
    return r.data?.[0]?.lifetime_usd != null ? Number(r.data[0].lifetime_usd) : null;
  }

  private async fetch(exchange: ExchangeId, uid: string, prices: Prices): Promise<Commission> {
    if (exchange === "bybit") return bybitCommission(this.providers.get("bybit")!, uid, prices);
    if (exchange === "bitget") return bitgetCommission(uid, prices);
    return blofinCommission(uid, await this.lifetimeFromAMonthAgo(uid));
  }

  /** One weekly pass. `apply` false computes and reports without storing or touching roles. */
  async run(opts: { apply: boolean } = { apply: true }): Promise<VipRow[]> {
    if (this.running) throw new Error("a VIP run is already in progress");
    this.running = true;
    try {
      const thresholds = await this.thresholds();
      const vipRoles = await this.roles(thresholds.length);
      const { data: links, error } = await this.db.sb.from("verifications").select("discord_user_id, exchange, uid").eq("guild_id", this.guild.id);
      if (error) throw new Error(`load verifications: ${error.message}`);
      const prices = new Prices();
      const members = await this.guild.members.fetch();
      const byUser = new Map<string, VipRow>();

      for (const l of links ?? []) {
        const row: VipRow = byUser.get(l.discord_user_id) ?? { userId: l.discord_user_id, usd: 0, tier: 0, previous: 0, parts: [], errors: [] };
        byUser.set(l.discord_user_id, row);
        try {
          const c = await this.fetch(l.exchange as ExchangeId, l.uid, prices);
          row.usd += c.usd;
          row.parts.push({ exchange: l.exchange as ExchangeId, usd: c.usd, method: c.method });
          if (opts.apply) {
            await this.db.sb.from("commission_snapshots").insert({
              guild_id: this.guild.id, discord_user_id: l.discord_user_id, exchange: l.exchange, uid: l.uid,
              commission_30d_usd: c.usd, method: c.method, lifetime_usd: c.lifetimeUsd ?? null, raw: c.raw ?? null,
            });
          }
        } catch (e) {
          row.errors.push(`${l.exchange}: ${e instanceof Error ? e.message : String(e)}`);
          log.warn("commission fetch failed", { user: l.discord_user_id, exchange: l.exchange, ...errInfo(e) });
        }
        await new Promise((r) => setTimeout(r, 250)); // stay well inside exchange rate limits
      }

      for (const row of byUser.values()) {
        const m = members.get(row.userId);
        row.previous = m ? vipRoles.findIndex((r) => m.roles.cache.has(r.id)) + 1 : 0;
        // A failed lookup keeps the member where they were rather than demoting on our error.
        row.tier = row.errors.length && row.parts.length === 0 ? row.previous : tierFor(row.usd, thresholds);
        if (!opts.apply || !m || row.tier === row.previous) continue;
        const want = row.tier ? vipRoles[row.tier - 1] : null;
        const remove = vipRoles.filter((r) => r !== want && m.roles.cache.has(r.id));
        if (remove.length) await m.roles.remove(remove, `VIP: $${row.usd.toFixed(0)} commission in 30 days`).catch((e) => log.warn("vip role remove failed", errInfo(e)));
        if (want) await m.roles.add(want, `VIP: $${row.usd.toFixed(0)} commission in 30 days`).catch((e) => log.warn("vip role add failed", errInfo(e)));
      }

      const rows = [...byUser.values()].sort((a, b) => b.usd - a.usd);
      if (opts.apply) {
        await this.db.setSetting(this.guild.id, "vip:last_run", new Date().toISOString());
        await this.report(rows, thresholds);
      }
      log.info("vip run", { members: rows.length, vips: rows.filter((r) => r.tier).length, apply: opts.apply });
      return rows;
    } finally {
      this.running = false;
    }
  }

  /** Posts the weekly summary to the staff channel in the `vip_report_channel` setting. */
  private async report(rows: VipRow[], thresholds: number[]) {
    const id = await this.db.getSetting(this.guild.id, "vip_report_channel");
    const ch = id ? await this.guild.channels.fetch(id).catch(() => null) : null;
    if (!ch?.isTextBased() || !("send" in ch)) return;
    const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
    const total = rows.reduce((a, r) => a + r.usd, 0);
    const counts = thresholds.map((_, i) => rows.filter((r) => r.tier === i + 1).length);
    const moves = rows.filter((r) => r.tier !== r.previous);
    const failed = rows.filter((r) => r.errors.length);
    const lines = [
      `## Weekly VIP report`,
      `**${usd(total)}** commission in the last 30 days from **${rows.length}** linked members.`,
      thresholds.map((t, i) => `VIP ${i + 1} (≥ ${usd(t)}): **${counts[i]}**`).join(" · "),
      "",
      "**Top 10**",
      ...rows.slice(0, 10).map((r, i) => `${i + 1}. <@${r.userId}>  ${usd(r.usd)}${r.tier ? `  · VIP ${r.tier}` : ""}${r.parts.some((p) => p.method === "volume_estimate") ? "  *(est.)*" : ""}`),
      ...(moves.length ? ["", "**Tier changes**", ...moves.slice(0, 20).map((r) => `<@${r.userId}>  ${r.previous ? `VIP ${r.previous}` : "none"} → ${r.tier ? `VIP ${r.tier}` : "none"}  (${usd(r.usd)})`)] : []),
      ...(failed.length ? ["", `-# ${failed.length} lookups failed and kept their tier: ${[...new Set(failed.flatMap((r) => r.errors.map((e) => e.split(":")[0])))].join(", ")}`] : []),
      "-# *(est.)* = Blofin estimate from volume until four weeks of history exist.",
    ];
    await ch.send({ content: lines.join("\n").slice(0, 3900), allowedMentions: { parse: [] } });
  }

  /** Checks hourly and runs once a week has passed since the last run. */
  schedule() {
    const tick = async () => {
      const last = await this.db.getSetting(this.guild.id, "vip:last_run");
      if (last && Date.now() - Date.parse(last) < WEEK) return;
      await this.run().catch((e) => log.error("vip run failed", errInfo(e)));
    };
    setInterval(() => void tick(), 3_600_000).unref();
  }
}
