import type { Collection, Guild, Invite } from "discord.js";
import { LANG_NAMES, type Lang } from "./config.js";
import type { Db } from "./db/index.js";
import { log, errInfo } from "./log.js";

/**
 * Onboarding funnel: join → pick a language → open verify → verified.
 * One row per step in `funnel_events`. Writes are fire-and-forget, so a slow
 * or missing table never gets in the way of someone joining.
 */
export type FunnelEvent = "join" | "leave" | "language_picked" | "verify_opened" | "verify_result" | "verified" | "language_changed_by_mod" | "language_changed_in_support";

export interface FunnelRow {
  discord_user_id: string;
  event: FunnelEvent | string;
  lang: string | null;
  invite_code: string | null;
  created_at?: string;
}

export class Funnel {
  constructor(private db: Db, private guildId: string) {}

  record(userId: string, event: FunnelEvent, extra: { lang?: Lang | null; detail?: Record<string, unknown>; inviteCode?: string | null } = {}) {
    const row = { guild_id: this.guildId, discord_user_id: userId, event, lang: extra.lang ?? null, detail: extra.detail ?? null, invite_code: extra.inviteCode ?? null };
    void Promise.resolve(this.db.sb.from("funnel_events").insert(row))
      .then((r) => r.error && log.warn("funnel write failed", { event, error: r.error.message }))
      .catch((e) => log.warn("funnel write failed", { event, ...errInfo(e) }));
  }

  /** Rows since `since`, paged past Supabase's 1000-row cap. */
  async rows(since: Date): Promise<FunnelRow[]> {
    const out: FunnelRow[] = [];
    for (let from = 0; ; from += 1000) {
      const r = await this.db.sb
        .from("funnel_events")
        .select("discord_user_id,event,lang,invite_code,created_at")
        .eq("guild_id", this.guildId)
        .gte("created_at", since.toISOString())
        .order("id")
        .range(from, from + 999);
      if (r.error) throw new Error(`funnel rows: ${r.error.message}`);
      out.push(...(r.data as FunnelRow[]));
      if (r.data.length < 1000) return out;
    }
  }
}

/**
 * Works out which invite a new member came through by diffing use counts
 * against the last snapshot. Two codes moving at once (or none, as with the
 * vanity URL or missing Manage Server) gives null rather than a guess.
 */
export class InviteTracker {
  private uses = new Map<string, number>();

  constructor(private guild: Guild) {}

  async refresh() {
    this.uses = snapshot(await this.guild.invites.fetch());
  }

  async attribute(): Promise<string | null> {
    try {
      const now = snapshot(await this.guild.invites.fetch());
      const used = [...now].filter(([code, n]) => n > (this.uses.get(code) ?? 0)).map(([code]) => code);
      this.uses = now;
      return used.length === 1 ? used[0] : null;
    } catch (e) {
      log.warn("invite attribution failed", errInfo(e));
      return null;
    }
  }

  onCreate(code: string, uses: number | null) {
    this.uses.set(code, uses ?? 0);
  }

  onDelete(code: string) {
    this.uses.delete(code);
  }
}

function snapshot(invites: Collection<string, Invite>) {
  return new Map(invites.map((inv) => [inv.code, inv.uses ?? 0]));
}

// Report --------------------------------------------------------------------

const STEPS = [
  ["join", "Joined"],
  ["language_picked", "Picked language"],
  ["verify_opened", "Opened verify"],
  ["verified", "Verified"],
] as const;

export interface FunnelReport {
  /** Distinct members per step, per language ("none" = no language yet). */
  byLang: Map<string, number[]>;
  total: number[];
  topJoins: [string, number][];
  topVerified: [string, number][];
}

/**
 * Distinct members reaching each step. A member's language is the last one
 * seen on any of their events, so a join counts under the language they went
 * on to pick. Steps are counted independently, so someone whose join fell
 * before the window still counts as picked/verified inside it.
 */
export function buildReport(rows: FunnelRow[], opts: { lang?: string | null } = {}): FunnelReport {
  const langOf = new Map<string, string>();
  const inviteOf = new Map<string, string>();
  const reached = STEPS.map(() => new Set<string>());
  for (const r of rows) {
    if (r.lang) langOf.set(r.discord_user_id, r.lang);
    if (r.event === "join" && r.invite_code) inviteOf.set(r.discord_user_id, r.invite_code);
    const k = STEPS.findIndex(([e]) => e === r.event);
    if (k >= 0) reached[k].add(r.discord_user_id);
  }

  const byLang = new Map<string, number[]>();
  const total = STEPS.map(() => 0);
  const joins = new Map<string, number>();
  const verified = new Map<string, number>();
  reached.forEach((users, k) => {
    for (const u of users) {
      const lang = langOf.get(u) ?? "none";
      if (opts.lang && lang !== opts.lang) continue;
      if (!byLang.has(lang)) byLang.set(lang, STEPS.map(() => 0));
      byLang.get(lang)![k]++;
      total[k]++;
      const code = inviteOf.get(u);
      if (code && k === 0) joins.set(code, (joins.get(code) ?? 0) + 1);
      if (code && k === STEPS.length - 1) verified.set(code, (verified.get(code) ?? 0) + 1);
    }
  });
  const top = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5);
  return { byLang, total, topJoins: top(joins), topVerified: top(verified) };
}

/** Share of the previous step, as "45%", or "–" when the previous step is empty. */
export function pct(n: number, of: number) {
  return of > 0 ? `${Math.round((n / of) * 100)}%` : "–";
}

const line = (counts: number[]) => counts.map((n, k) => (k === 0 ? `${n}` : `${n} (${pct(n, counts[k - 1])})`)).join(" → ");

export function formatReport(rep: FunnelReport, days: number, lang?: string | null): string {
  const out = [`**Onboarding funnel, last ${days} days${lang ? ` · ${lang}` : ""}**`, `-# ${STEPS.map(([, l]) => l).join(" → ")}`];
  if (rep.total.every((n) => n === 0)) return [...out, "No onboarding events in this window."].join("\n");
  out.push(`**All:** ${line(rep.total)}`);
  const langs = [...rep.byLang].sort((a, b) => b[1][0] - a[1][0] || b[1][1] - a[1][1]);
  for (const [l, counts] of langs.slice(0, 12)) out.push(`${LANG_NAMES[l as Lang] ?? l}: ${line(counts)}`);
  const codes = (xs: [string, number][]) => (xs.length ? xs.map(([c, n]) => `\`${c}\` ${n}`).join(" · ") : "none attributed");
  out.push("", `**Top invites by joins:** ${codes(rep.topJoins)}`, `**Top invites by verified:** ${codes(rep.topVerified)}`);
  return out.join("\n").slice(0, 1900);
}
