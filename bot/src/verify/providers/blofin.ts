import { randomUUID } from "node:crypto";
import { cred, hmacHexThenBase64, query } from "../sign.js";
import { requestJson } from "./http.js";
import { ProviderError, type AffiliateLookup, type AffiliateProvider } from "../types.js";

/**
 * Blofin affiliate lookup.
 *
 * Blofin signs like OKX: base64(hex(HMAC-SHA256(path + METHOD + timestamp + nonce + body)))
 * with ACCESS-KEY, ACCESS-SIGN, ACCESS-TIMESTAMP, ACCESS-NONCE and
 * ACCESS-PASSPHRASE headers. `code === "0"` with a non-empty data array means
 * the UID is one of our invitees.
 */
interface BlofinResponse {
  code: string;
  msg: string;
  data?: unknown;
}

export class BlofinAffiliate implements AffiliateProvider {
  readonly id = "blofin" as const;
  readonly label = "Blofin";
  readonly live = true;
  private base = process.env.BLOFIN_API_BASE ?? "https://openapi.blofin.com";
  private path = process.env.BLOFIN_AFFILIATE_PATH ?? "/api/v1/affiliate/invitees";
  private key = cred("BLOFIN_API_KEY");
  private secret = cred("BLOFIN_API_SECRET");
  private passphrase = cred("BLOFIN_API_PASSPHRASE");

  configured() {
    return Boolean(this.key && this.secret && this.passphrase);
  }

  async lookup(uid: string): Promise<AffiliateLookup> {
    if (!this.configured()) throw new ProviderError("Blofin API credentials are not set");
    const qs = query({ uid });
    const requestPath = `${this.path}?${qs}`;
    const ts = Date.now().toString();
    const nonce = randomUUID();
    const sign = hmacHexThenBase64(this.secret, requestPath + "GET" + ts + nonce);
    const body = await requestJson<BlofinResponse>(`${this.base}${requestPath}`, {
      headers: {
        "ACCESS-KEY": this.key,
        "ACCESS-SIGN": sign,
        "ACCESS-TIMESTAMP": ts,
        "ACCESS-NONCE": nonce,
        "ACCESS-PASSPHRASE": this.passphrase,
        "Content-Type": "application/json",
      },
    });
    if (body.code !== "0") throw new ProviderError(`Blofin error ${body.code}: ${body.msg}`);
    const rows = Array.isArray(body.data) ? body.data : body.data ? [body.data] : [];
    if (rows.length === 0) return { referred: false, detail: { code: body.code } };
    return { referred: true, detail: { rows: rows.length, first: rows[0] } };
  }
}
