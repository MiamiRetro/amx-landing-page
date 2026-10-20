import { randomUUID } from "node:crypto";
import { cred, hmacBase64, hmacHexThenBase64, query } from "../verify/sign.js";
import { requestJson } from "../verify/providers/http.js";
import type { AffiliateProvider, ExchangeId } from "../verify/types.js";

/**
 * What we earned from one exchange account over the last 30 days, in USD.
 *
 *   Bybit   reports it: aff-customer-info.commissions30Day, per coin.
 *   Bitget  reports a rebate per member per day: summed over 30 days.
 *   Blofin  reports only lifetime commission, so 30 days is this week's
 *           lifetime minus the lifetime from about four weeks ago. Until that
 *           history exists it is estimated from 30-day maker/taker volume.
 */
export interface Commission {
  usd: number;
  method: "reported" | "lifetime_diff" | "volume_estimate";
  /** Blofin lifetime commission in USD, kept so later weeks can diff it. */
  lifetimeUsd?: number;
  raw?: Record<string, unknown>;
}

/** Our share of fees, used only for Blofin's first-month estimate: 50% of 0.06% taker / 0.02% maker. */
export const SHARE = { taker: 0.5 * 0.0006, maker: 0.5 * 0.0002 };

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** USD prices for the coins commission is paid in. Stablecoins are 1. */
export class Prices {
  private cache = new Map<string, number>([["USDT", 1], ["USDC", 1], ["USD", 1]]);

  async usd(coin: string): Promise<number> {
    const c = coin.toUpperCase();
    const hit = this.cache.get(c);
    if (hit !== undefined) return hit;
    // Bitget's public ticker answers from anywhere; Bybit's is geo-blocked from some regions.
    const r = await requestJson<{ code: string; data?: { lastPr?: string }[] }>(`https://api.bitget.com/api/v2/spot/market/tickers?symbol=${c}USDT`, { headers: {} });
    const price = num(r.data?.[0]?.lastPr);
    if (!price) throw new Error(`no USD price for ${c}`);
    this.cache.set(c, price);
    return price;
  }
}

export async function bybitCommission(provider: AffiliateProvider, uid: string, prices: Prices): Promise<Commission> {
  const r = await provider.lookup(uid);
  if (!r.referred) return { usd: 0, method: "reported", raw: { referred: false } };
  const byCoin = (r.detail?.commissions30Day ?? {}) as Record<string, string>;
  let usd = 0;
  for (const [coin, amount] of Object.entries(byCoin)) {
    const a = num(amount);
    if (a) usd += a * (await prices.usd(coin));
  }
  return { usd, method: "reported", raw: { commissions30Day: byCoin } };
}

export async function bitgetCommission(uid: string, prices: Prices, now = Date.now()): Promise<Commission> {
  const key = cred("BITGET_API_KEY"), secret = cred("BITGET_API_SECRET"), pass = cred("BITGET_API_PASSPHRASE");
  if (!key || !secret || !pass) throw new Error("Bitget API credentials are not set");
  const path = "/api/v2/broker/customer-commissions";
  let usd = 0;
  let rows = 0;
  let idLessThan: string | undefined;
  for (let page = 0; page < 20; page++) {
    const qs = query({ uid, startTime: now - 30 * 86_400_000, endTime: now, limit: 100, idLessThan });
    const ts = Date.now().toString();
    const r = await requestJson<{ code: string; msg: string; data?: { endId?: string; commissionList?: Record<string, string>[] } }>(`https://api.bitget.com${path}?${qs}`, {
      headers: { "ACCESS-KEY": key, "ACCESS-SIGN": hmacBase64(secret, ts + "GET" + path + "?" + qs), "ACCESS-TIMESTAMP": ts, "ACCESS-PASSPHRASE": pass, locale: "en-US" },
    });
    if (r.code !== "00000") throw new Error(`Bitget error ${r.code}: ${r.msg}`);
    // customer-commissions answers for any uid, so only rows that name this uid count.
    const list = (r.data?.commissionList ?? []).filter((x) => String(x.uid) === uid);
    for (const x of list) usd += num(x.rebateAmount) * (await prices.usd(x.coin || "USDT"));
    rows += list.length;
    if (!r.data?.endId || (r.data.commissionList ?? []).length < 100) break;
    idLessThan = r.data.endId;
  }
  return { usd, method: "reported", raw: { rows } };
}

export async function blofinCommission(uid: string, earlierLifetime: number | null): Promise<Commission> {
  const key = cred("BLOFIN_API_KEY"), secret = cred("BLOFIN_API_SECRET"), pass = cred("BLOFIN_API_PASSPHRASE");
  if (!key || !secret || !pass) throw new Error("Blofin API credentials are not set");
  const requestPath = `/api/v1/affiliate/invitees?${query({ uid })}`;
  const ts = Date.now().toString(), nonce = randomUUID();
  const r = await requestJson<{ code: string; msg: string; data?: Record<string, string>[] }>(`https://openapi.blofin.com${requestPath}`, {
    headers: { "ACCESS-KEY": key, "ACCESS-SIGN": hmacHexThenBase64(secret, requestPath + "GET" + ts + nonce), "ACCESS-TIMESTAMP": ts, "ACCESS-NONCE": nonce, "ACCESS-PASSPHRASE": pass },
  });
  if (r.code !== "0") throw new Error(`Blofin error ${r.code}: ${r.msg}`);
  const row = (r.data ?? []).find((x) => String(x.uid) === uid);
  if (!row) return { usd: 0, method: "reported", raw: { referred: false } };
  const lifetime = num(row.totalCommission);
  const raw = { totalCommission: row.totalCommission, takerVol30Day: row.takerVol30Day, makerVol30Day: row.makerVol30Day };
  if (earlierLifetime !== null) return { usd: Math.max(0, lifetime - earlierLifetime), method: "lifetime_diff", lifetimeUsd: lifetime, raw };
  const usd = num(row.takerVol30Day) * SHARE.taker + num(row.makerVol30Day) * SHARE.maker;
  return { usd, method: "volume_estimate", lifetimeUsd: lifetime, raw };
}

export type CommissionFetcher = (exchange: ExchangeId, uid: string) => Promise<Commission>;
