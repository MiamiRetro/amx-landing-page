import type { Db } from "../db/index.js";
import { ProviderError, type AffiliateProvider, type ExchangeId } from "./types.js";

export type Outcome =
  | "verified"
  | "already_member"
  | "already_claimed"
  | "not_referred"
  | "bad_uid"
  | "rate_limited"
  | "provider_error";

export interface VerifyResult {
  outcome: Outcome;
  exchange: ExchangeId;
  uid: string;
  /** Set when the UID is already held by a different Discord account. */
  claimedBy?: string;
  /** Set on provider_error, for the ops log rather than the member. */
  error?: string;
  /** Attempts left in the window after this one. */
  remaining?: number;
}

const MAX_ATTEMPTS = Number(process.env.VERIFY_MAX_ATTEMPTS ?? 5);
const WINDOW_MIN = Number(process.env.VERIFY_WINDOW_MIN ?? 15);
/** Exchange UIDs are short numeric or alphanumeric ids; anything else is a typo or a probe. */
const UID_RE = /^[A-Za-z0-9_-]{4,32}$/;

export function normaliseUid(raw: string): string {
  return raw.trim().replace(/\s+/g, "");
}

/**
 * Decides whether a member may be let in, and records the attempt.
 *
 * Deliberately knows nothing about Discord: the caller passes whether the
 * member already holds a membership role and applies the role on success.
 */
export class VerifyService {
  constructor(
    private db: Db,
    private guildId: string,
    private providers: Map<ExchangeId, AffiliateProvider>,
  ) {}

  provider(exchange: ExchangeId) {
    return this.providers.get(exchange);
  }

  get exchanges(): ExchangeId[] {
    return [...this.providers.keys()];
  }

  async verify(args: { userId: string; alreadyMember: boolean; exchange: ExchangeId; uid: string }): Promise<VerifyResult> {
    const started = Date.now();
    const uid = normaliseUid(args.uid);
    const base = { exchange: args.exchange, uid };
    const record = async (outcome: Outcome, error?: string) => {
      await this.db
        .logAttempt({ guild_id: this.guildId, discord_user_id: args.userId, exchange: args.exchange, uid, outcome, ms: Date.now() - started, error })
        .catch(() => {});
    };

    // A member who is already in does not need the popup, and re-running it
    // would let them swap the UID on file for one they do not own.
    if (args.alreadyMember) {
      await record("already_member");
      return { ...base, outcome: "already_member" };
    }

    if (!UID_RE.test(uid)) {
      await record("bad_uid");
      return { ...base, outcome: "bad_uid" };
    }

    const since = new Date(Date.now() - WINDOW_MIN * 60_000);
    const used = await this.db.attemptsSince(this.guildId, args.userId, since);
    if (used >= MAX_ATTEMPTS) {
      await record("rate_limited");
      return { ...base, outcome: "rate_limited" };
    }
    const remaining = Math.max(0, MAX_ATTEMPTS - used - 1);

    const held = await this.db.verificationByUid(args.exchange, uid);
    if (held && held.discord_user_id !== args.userId) {
      await record("already_claimed");
      return { ...base, outcome: "already_claimed", claimedBy: held.discord_user_id, remaining };
    }

    const provider = this.providers.get(args.exchange);
    if (!provider) {
      await record("provider_error", "no provider configured");
      return { ...base, outcome: "provider_error", error: "no provider configured", remaining };
    }

    try {
      const res = await provider.lookup(uid);
      if (!res.referred) {
        await record("not_referred");
        return { ...base, outcome: "not_referred", remaining };
      }
      await this.db.saveVerification({
        guild_id: this.guildId,
        discord_user_id: args.userId,
        exchange: args.exchange,
        uid,
        detail: res.detail ?? null,
      });
      await record("verified");
      return { ...base, outcome: "verified", remaining };
    } catch (e) {
      const error = e instanceof ProviderError ? e.message : e instanceof Error ? e.message : String(e);
      await record("provider_error", error);
      return { ...base, outcome: "provider_error", error, remaining };
    }
  }
}
