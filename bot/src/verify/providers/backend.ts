import { EXCHANGE_LABELS, ProviderError, type AffiliateLookup, type AffiliateProvider, type ExchangeId } from "../types.js";

/**
 * UID checks through the BLKBöX app API instead of each exchange's affiliate
 * API, so Discord and app.blkbox.pro share one check and one record of which
 * Discord account holds which UID.
 *
 *   POST {VERIFY_BACKEND_URL}   x-api-key: {VERIFY_BACKEND_KEY}
 *   { discordUserId, exchangeId, exchangeUserId }
 *   → { success, data: { verified }, error?: { type, code, message }, meta }
 *
 * Only main-account UIDs verify; a sub-account UID comes back verified: false.
 * 409 means the UID is already linked to someone else; 403 is a refusal with a
 * code saying why; exchange outages carry EXCHANGE_UNREACHABLE / EXCHANGE_ERROR.
 */

interface BackendReply {
  success: boolean;
  data?: { verified: boolean };
  error?: { type: string; code: string; message: string };
  meta?: { requestId?: string };
}

/** The UID is held by another member (here or in the app). */
export class UidClaimedError extends ProviderError {
  constructor(readonly code: string, message: string) {
    super(message, 409);
    this.name = "UidClaimedError";
  }
}

/** Codes that mean "not one of ours" rather than "couldn't check". */
const NOT_REFERRED = new Set(["NOT_PARTNER_ACCOUNT", "ACCOUNT_REVOKED", "UNSUPPORTED_ACCOUNT_TYPE"]);
const CLAIMED = new Set(["UID_LINKED_TO_OTHER_USER", "UID_VERIFIED_ON_DISCORD", "ACCOUNT_ALREADY_CONNECTED", "DIFFERENT_EXCHANGE_ACCOUNT"]);

export class BackendVerifier implements AffiliateProvider {
  readonly live = true;
  readonly label: string;
  private url = process.env.VERIFY_BACKEND_URL?.trim() ?? "";
  private key = process.env.VERIFY_BACKEND_KEY?.trim() ?? "";

  constructor(readonly id: ExchangeId) {
    this.label = EXCHANGE_LABELS[id];
  }

  configured() {
    return Boolean(this.url && this.key);
  }

  async lookup(uid: string, ctx?: { discordUserId?: string }): Promise<AffiliateLookup> {
    if (!this.configured()) throw new ProviderError("VERIFY_BACKEND_URL / VERIFY_BACKEND_KEY are not set");
    if (!ctx?.discordUserId) throw new ProviderError("the backend check needs the member's Discord id");
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 20_000);
    let res: Response;
    try {
      res = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": this.key },
        body: JSON.stringify({ discordUserId: ctx.discordUserId, exchangeId: this.id, exchangeUserId: uid }),
        signal: ac.signal,
      });
    } catch (e) {
      throw new ProviderError(e instanceof Error && e.name === "AbortError" ? "BLKBöX API timed out" : `network error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let body: BackendReply | null = null;
    try { body = JSON.parse(text) as BackendReply; } catch { /* handled below */ }
    const code = body?.error?.code ?? "";
    const why = `${res.status}${code ? ` ${code}` : ""}: ${body?.error?.message ?? text.slice(0, 200)} (request ${body?.meta?.requestId ?? "?"})`;

    if (res.ok && body?.success && body.data) {
      return { referred: body.data.verified, detail: { via: "blkbox-api", requestId: body.meta?.requestId } };
    }
    if (res.status === 409 || CLAIMED.has(code)) throw new UidClaimedError(code || "CONFLICT", `UID already linked: ${why}`);
    if (NOT_REFERRED.has(code)) return { referred: false, detail: { code, message: body?.error?.message } };
    // A 403 without a known code is our key being refused, not the member's UID.
    throw new ProviderError(`BLKBöX API ${why}`, res.status, text.slice(0, 500));
  }
}

/** Every exchange checked through the app API when VERIFY_BACKEND_URL is set; otherwise null. */
export function buildBackendVerifiers(exchanges: readonly ExchangeId[]): Map<ExchangeId, AffiliateProvider> | null {
  if (!process.env.VERIFY_BACKEND_URL?.trim()) return null;
  return new Map(exchanges.map((id) => [id, new BackendVerifier(id)]));
}
