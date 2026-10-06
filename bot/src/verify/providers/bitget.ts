import { cred, hmacBase64 } from "../sign.js";
import { requestJson } from "./http.js";
import { ProviderError, type AffiliateLookup, type AffiliateProvider } from "../types.js";

/**
 * Bitget affiliate (agent) lookup.
 *
 * The API key must come from the affiliate account and have the broker/agent
 * permission, and Bitget keys carry a passphrase. Signing is
 * base64(HMAC-SHA256(timestamp + METHOD + requestPath + body)).
 *
 * `POST /api/v2/broker/customer-list` with `{ uid }` answers for one UID
 * across every customer ever referred, traded or not, and works for an
 * affiliate in Unified Account mode (the v1 agent API refuses those with
 * 40085). A referral comes back as a row whose uid matches; anyone else is an
 * empty list.
 *
 * Matching the uid matters: a blank uid returns the first page of all our
 * customers, and customer-commissions returns `{ endId, commissionList }`
 * for any UID at all, so "the answer is non-empty" would let anyone in.
 * Never send startTime/endTime either: they filter on registration time.
 */
interface BitgetResponse {
  code: string;
  msg: string;
  data?: unknown;
}

/** Bitget UIDs are numeric. Anything else gets a 40020 error rather than a clean no. */
const BITGET_UID = /^\d+$/;

export function bitgetReferred(uid: string, data: unknown): boolean {
  return Array.isArray(data) && data.some((r) => r && typeof r === "object" && String((r as { uid?: unknown }).uid) === uid);
}

export class BitgetAffiliate implements AffiliateProvider {
  readonly id = "bitget" as const;
  readonly label = "Bitget";
  readonly live = true;
  private base = process.env.BITGET_API_BASE ?? "https://api.bitget.com";
  private path = process.env.BITGET_AFFILIATE_PATH ?? "/api/v2/broker/customer-list";
  private key = cred("BITGET_API_KEY");
  private secret = cred("BITGET_API_SECRET");
  private passphrase = cred("BITGET_API_PASSPHRASE");

  configured() {
    return Boolean(this.key && this.secret && this.passphrase);
  }

  async lookup(uid: string): Promise<AffiliateLookup> {
    if (!this.configured()) throw new ProviderError("Bitget API credentials are not set");
    if (!BITGET_UID.test(uid)) return { referred: false, detail: { reason: "not a Bitget UID" } };
    const body = JSON.stringify({ uid });
    const ts = Date.now().toString();
    const sign = hmacBase64(this.secret, ts + "POST" + this.path + body);
    const res = await requestJson<BitgetResponse>(`${this.base}${this.path}`, {
      method: "POST",
      body,
      headers: {
        "ACCESS-KEY": this.key,
        "ACCESS-SIGN": sign,
        "ACCESS-TIMESTAMP": ts,
        "ACCESS-PASSPHRASE": this.passphrase,
        locale: "en-US",
        "Content-Type": "application/json",
      },
    });
    if (res.code !== "00000") throw new ProviderError(`Bitget error ${res.code}: ${res.msg}`);
    if (!bitgetReferred(uid, res.data)) return { referred: false, detail: { code: res.code } };
    const row = (res.data as Record<string, unknown>[]).find((r) => String(r.uid) === uid);
    return { referred: true, detail: { ...row } };
  }
}
