import type { AffiliateLookup, AffiliateProvider, ExchangeId } from "../types.js";

/**
 * Stands in for an exchange while credentials are missing, so the whole flow
 * can be exercised against the live server. `VERIFY_MOCK_UIDS` is a
 * comma-separated allowlist; every other UID comes back as not referred.
 */
export class MockAffiliate implements AffiliateProvider {
  readonly label: string;
  readonly live = false;
  private allow: Set<string>;

  constructor(readonly id: ExchangeId, label: string, allow = process.env.VERIFY_MOCK_UIDS ?? "") {
    this.label = label;
    this.allow = new Set(allow.split(",").map((s) => s.trim()).filter(Boolean));
  }

  configured() {
    return true;
  }

  async lookup(uid: string): Promise<AffiliateLookup> {
    return { referred: this.allow.has(uid), detail: { mock: true } };
  }
}
