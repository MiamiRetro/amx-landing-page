import { hmacHex, query } from "../sign.js";
import { requestJson } from "./http.js";
import { ProviderError, type AffiliateLookup, type AffiliateProvider } from "../types.js";

/**
 * Bybit V5 affiliate lookup.
 *
 * The API key must belong to the affiliate master account and carry the
 * "Affiliate" permission. `GET /v5/user/aff-customer-info` answers for a single
 * UID: retCode 0 means the UID sits under our affiliate, and Bybit's
 * "not an affiliate customer" codes come back as a clean no.
 *
 * Endpoint and the codes that mean "no" are overridable, because Bybit has
 * renamed affiliate endpoints before.
 */
const NOT_OURS = new Set(
  (process.env.BYBIT_NOT_REFERRED_CODES ?? "131228,181002,10001").split(",").map((s) => s.trim()).filter(Boolean),
);

interface BybitResponse {
  retCode: number;
  retMsg: string;
  result?: Record<string, unknown>;
}

export class BybitAffiliate implements AffiliateProvider {
  readonly id = "bybit" as const;
  readonly label = "Bybit";
  private base = process.env.BYBIT_API_BASE ?? "https://api.bybit.com";
  private path = process.env.BYBIT_AFFILIATE_PATH ?? "/v5/user/aff-customer-info";
  private key = process.env.BYBIT_API_KEY ?? "";
  private secret = process.env.BYBIT_API_SECRET ?? "";

  configured() {
    return Boolean(this.key && this.secret);
  }

  async lookup(uid: string): Promise<AffiliateLookup> {
    if (!this.configured()) throw new ProviderError("Bybit API credentials are not set");
    const qs = query({ uid });
    const ts = Date.now().toString();
    const recv = "10000";
    const sign = hmacHex(this.secret, ts + this.key + recv + qs);
    const body = await requestJson<BybitResponse>(`${this.base}${this.path}?${qs}`, {
      headers: {
        "X-BAPI-API-KEY": this.key,
        "X-BAPI-TIMESTAMP": ts,
        "X-BAPI-RECV-WINDOW": recv,
        "X-BAPI-SIGN": sign,
      },
    });
    if (body.retCode === 0) return { referred: true, detail: body.result ?? {} };
    if (NOT_OURS.has(String(body.retCode))) return { referred: false, detail: { retCode: body.retCode, retMsg: body.retMsg } };
    throw new ProviderError(`Bybit error ${body.retCode}: ${body.retMsg}`);
  }
}
