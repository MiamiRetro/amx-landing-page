import { hmacBase64, query } from "../sign.js";
import { requestJson } from "./http.js";
import { ProviderError, type AffiliateLookup, type AffiliateProvider } from "../types.js";

/**
 * Bitget affiliate (agent) lookup.
 *
 * The API key must come from the affiliate account and have the broker/agent
 * permission, and Bitget keys carry a passphrase. Signing is
 * base64(HMAC-SHA256(timestamp + METHOD + requestPath + body)).
 *
 * `code === "00000"` with a non-empty list means the UID is one of ours.
 */
interface BitgetResponse {
  code: string;
  msg: string;
  data?: unknown;
}

export class BitgetAffiliate implements AffiliateProvider {
  readonly id = "bitget" as const;
  readonly label = "Bitget";
  private base = process.env.BITGET_API_BASE ?? "https://api.bitget.com";
  private path = process.env.BITGET_AFFILIATE_PATH ?? "/api/v2/broker/customer-commissions";
  private key = process.env.BITGET_API_KEY ?? "";
  private secret = process.env.BITGET_API_SECRET ?? "";
  private passphrase = process.env.BITGET_API_PASSPHRASE ?? "";

  configured() {
    return Boolean(this.key && this.secret && this.passphrase);
  }

  async lookup(uid: string): Promise<AffiliateLookup> {
    if (!this.configured()) throw new ProviderError("Bitget API credentials are not set");
    const qs = query({ uid });
    const requestPath = `${this.path}?${qs}`;
    const ts = Date.now().toString();
    const sign = hmacBase64(this.secret, ts + "GET" + requestPath);
    const body = await requestJson<BitgetResponse>(`${this.base}${requestPath}`, {
      headers: {
        "ACCESS-KEY": this.key,
        "ACCESS-SIGN": sign,
        "ACCESS-TIMESTAMP": ts,
        "ACCESS-PASSPHRASE": this.passphrase,
        locale: "en-US",
        "Content-Type": "application/json",
      },
    });
    if (body.code !== "00000") throw new ProviderError(`Bitget error ${body.code}: ${body.msg}`);
    const rows = Array.isArray(body.data) ? body.data : body.data ? [body.data] : [];
    if (rows.length === 0) return { referred: false, detail: { code: body.code } };
    return { referred: true, detail: { rows: rows.length, first: rows[0] } };
  }
}
