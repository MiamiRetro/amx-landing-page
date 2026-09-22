/** The exchanges a member can verify against. */
export const EXCHANGES = ["bitget", "blofin", "bybit"] as const;
export type ExchangeId = (typeof EXCHANGES)[number];

export const EXCHANGE_LABELS: Record<ExchangeId, string> = {
  bitget: "Bitget",
  blofin: "Blofin",
  bybit: "Bybit",
};

/** Where a member signs up so their UID lands under our affiliate. */
export const EXCHANGE_SIGNUP: Record<ExchangeId, string> = {
  bitget: "https://partner.bitget.com/bg/G91HYQ",
  blofin: "https://partner.blofin.com/d/BLKBox",
  bybit: "https://partner.bybit.com/b/90136",
};

export function isExchange(x: string): x is ExchangeId {
  return (EXCHANGES as readonly string[]).includes(x);
}

export interface AffiliateLookup {
  /** True when the exchange confirms this UID registered under our affiliate. */
  referred: boolean;
  /** Anything worth keeping for the audit trail: registration time, tier, raw ids. */
  detail?: Record<string, unknown>;
}

export interface AffiliateProvider {
  readonly id: ExchangeId;
  readonly label: string;
  /** False when credentials are missing, so the exchange can be hidden from the picker. */
  configured(): boolean;
  /**
   * Asks the exchange whether this UID is one of ours.
   * Throws on transport or auth failures; a clean "not our customer" answer
   * must come back as `{ referred: false }` so the member gets the right message.
   */
  lookup(uid: string): Promise<AffiliateLookup>;
}

/** Thrown when the exchange could not answer, as opposed to answering "no". */
export class ProviderError extends Error {
  constructor(message: string, readonly status?: number, readonly body?: string) {
    super(message);
    this.name = "ProviderError";
  }
}
