import { ProviderError, type AffiliateProvider, type ExchangeId } from "./types.js";

/** A UID that should exist nowhere, so a healthy exchange answers "not ours". */
const CANARY = process.env.VERIFY_CANARY_UID ?? "999999999999";

export interface Health {
  exchange: ExchangeId;
  ok: boolean;
  error?: string;
}

/**
 * Asks each live exchange about a UID that cannot exist.
 *
 * A healthy affiliate API answers "not one of ours". An expired key, a revoked
 * permission, an IP allowlist that no longer matches or a moved endpoint all
 * throw instead. That is the difference between the exchange working and the
 * credentials having quietly died, which is otherwise invisible until a member
 * reports it.
 */
export async function checkProviders(providers: Iterable<AffiliateProvider>): Promise<Health[]> {
  const out: Health[] = [];
  for (const p of providers) {
    if (!p.live) continue;
    try {
      await p.lookup(CANARY);
      out.push({ exchange: p.id, ok: true });
    } catch (e) {
      // The status alone rarely says why. The exchange puts the reason in the
      // body, so carry it through to the log.
      const detail = e instanceof ProviderError && e.body ? `${e.message} body=${e.body.slice(0, 300)}` : e instanceof Error ? e.message : String(e);
      out.push({ exchange: p.id, ok: false, error: detail });
    }
  }
  return out;
}

/**
 * Remembers what was already reported so a broken key is announced once, and
 * its recovery is announced once, instead of every cycle.
 */
export class HealthWatch {
  private failing = new Set<ExchangeId>();

  /** Returns only the exchanges whose state changed since the last run. */
  diff(results: Health[]): { exchange: ExchangeId; ok: boolean; error?: string }[] {
    const changed: { exchange: ExchangeId; ok: boolean; error?: string }[] = [];
    for (const r of results) {
      const was = this.failing.has(r.exchange);
      if (!r.ok && !was) {
        this.failing.add(r.exchange);
        changed.push(r);
      } else if (r.ok && was) {
        this.failing.delete(r.exchange);
        changed.push(r);
      }
    }
    return changed;
  }
}
