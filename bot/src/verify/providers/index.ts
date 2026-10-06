import { BitgetAffiliate } from "./bitget.js";
import { BlofinAffiliate } from "./blofin.js";
import { BybitAffiliate } from "./bybit.js";
import { MockAffiliate } from "./mock.js";
import { EXCHANGES, EXCHANGE_LABELS, type AffiliateProvider, type ExchangeId } from "../types.js";

/**
 * One provider per exchange. An exchange with no credentials falls back to the
 * mock so the flow still runs end to end; set VERIFY_MOCK=off to hide it from
 * the picker instead.
 */
export function buildProviders(): Map<ExchangeId, AffiliateProvider> {
  const live: AffiliateProvider[] = [new BitgetAffiliate(), new BlofinAffiliate(), new BybitAffiliate()];
  const mockAllowed = (process.env.VERIFY_MOCK ?? "on") !== "off";
  // An exchange we cannot reach is worse than one we do not offer: the member
  // fills the form, waits, and is told to try later with no way forward.
  const disabled = new Set((process.env.VERIFY_DISABLED ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
  const out = new Map<ExchangeId, AffiliateProvider>();
  for (const id of EXCHANGES) {
    if (disabled.has(id)) continue;
    const real = live.find((p) => p.id === id)!;
    if (real.configured()) out.set(id, real);
    else if (mockAllowed) out.set(id, new MockAffiliate(id, EXCHANGE_LABELS[id]));
  }
  return out;
}
