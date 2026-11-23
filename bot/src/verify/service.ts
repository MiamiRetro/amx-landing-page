import type { Db } from "../db/index.js";
import { ProviderError, type AffiliateProvider, type ExchangeId } from "./types.js";
import { UidClaimedError, UidInvalidError, UidRevokedError } from "./providers/backend.js";

export type Outcome =
  | "verified"
  | "already_member"
  | "already_claimed"
  | "not_referred"
  | "not_configured"
  | "bad_uid"
  | "revoked"
  | "rate_limited"
  | "provider_error"
  /** Adding: the member already has this UID on file. */
  | "already_yours"
  /** Adding: the member holds the most UIDs one account may link. */
  | "too_many"
  /** Adding: the BLKBöX app refused a second account on this exchange for this member. */
  | "app_one_per_exchange";

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

const MAX_ATTEMPTS = Number(process.env.VERIFY_MAX_ATTEMPTS ?? 10);
const WINDOW_MIN = Number(process.env.VERIFY_WINDOW_MIN ?? 15);
/** How many UIDs one Discord account may link, across all exchanges. */
export const MAX_UIDS = Number(process.env.VERIFY_MAX_UIDS ?? 10);
/** App API codes that mean "this member already has an account on that exchange", not "someone else owns the UID". */
const ONE_PER_EXCHANGE = new Set(["ACCOUNT_ALREADY_CONNECTED", "DIFFERENT_EXCHANGE_ACCOUNT"]);
/** Exchange UIDs are short numeric or alphanumeric ids; anything else is a typo or a probe. */
export const UID_RE = /^[A-Za-z0-9_-]{4,32}$/;

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
    /**
     * The provider keeps the record of who holds which UID (the BLKBöX app API),
     * so it decides "already linked", not our own table: a UID released there
     * must be usable here straight away.
     */
    private providerOwnsUids = false,
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
    if (held && held.discord_user_id !== args.userId && !this.providerOwnsUids) {
      await record("already_claimed");
      return { ...base, outcome: "already_claimed", claimedBy: held.discord_user_id, remaining };
    }

    const provider = this.providers.get(args.exchange);
    // A stand-in rejects every UID. Saying "we cannot see that UID" would send
    // a member off to re-open an exchange account over nothing.
    if (provider && !provider.live) {
      await record("not_configured");
      return { ...base, outcome: "not_configured", remaining };
    }
    if (!provider) {
      await record("provider_error", "no provider configured");
      return { ...base, outcome: "provider_error", error: "no provider configured", remaining };
    }

    try {
      const res = await provider.lookup(uid, { discordUserId: args.userId });
      if (!res.referred) {
        await record("not_referred");
        return { ...base, outcome: "not_referred", remaining };
      }
      // The same person may already hold this UID from another server sharing
      // the database (the test server); one row per UID, so keep theirs.
      // The API gave this UID to this member. Our row for it, if another member in this
      // server held it, moves across; a row from another server sharing the table is left alone.
      if (held && held.discord_user_id !== args.userId && this.providerOwnsUids && held.guild_id === this.guildId) {
        await this.db.removeVerification(held.guild_id, held.discord_user_id);
      }
      const keep = held && (held.discord_user_id === args.userId || held.guild_id !== this.guildId);
      if (!keep) await this.db.saveVerification({
        guild_id: this.guildId,
        discord_user_id: args.userId,
        exchange: args.exchange,
        uid,
        detail: res.detail ?? null,
      });
      await record("verified");
      return { ...base, outcome: "verified", remaining };
    } catch (e) {
      // The app API keeps its own record of who holds which UID, across Discord and the app.
      if (e instanceof UidClaimedError) {
        await record("already_claimed", e.message);
        return { ...base, outcome: "already_claimed", remaining };
      }
      if (e instanceof UidRevokedError) {
        await record("revoked", e.message);
        return { ...base, outcome: "revoked", remaining };
      }
      if (e instanceof UidInvalidError) {
        await record("bad_uid", e.message);
        return { ...base, outcome: "bad_uid", remaining };
      }
      const error = e instanceof ProviderError ? e.message : e instanceof Error ? e.message : String(e);
      await record("provider_error", error);
      return { ...base, outcome: "provider_error", error, remaining };
    }
  }
  /**
   * Links one more UID to a member who is already in, so commission on every
   * account they trade on counts toward VIP tiers and competitions. Same checks
   * as verifying (referred through our links, not held by anyone else, rate
   * limit); it never grants or removes a role.
   */
  async addUid(args: { userId: string; exchange: ExchangeId; uid: string }): Promise<VerifyResult> {
    const started = Date.now();
    const uid = normaliseUid(args.uid);
    const base = { exchange: args.exchange, uid };
    const record = async (outcome: Outcome, error?: string) => {
      await this.db
        .logAttempt({ guild_id: this.guildId, discord_user_id: args.userId, exchange: args.exchange, uid, outcome: `add:${outcome}`, ms: Date.now() - started, error })
        .catch(() => {});
    };

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
    if (held && held.discord_user_id === args.userId) {
      await record("already_yours");
      return { ...base, outcome: "already_yours", remaining };
    }
    if (held && !this.providerOwnsUids) {
      await record("already_claimed");
      return { ...base, outcome: "already_claimed", claimedBy: held.discord_user_id, remaining };
    }
    const mine = await this.db.uidsOf(this.guildId, args.userId);
    if (mine.length >= MAX_UIDS) {
      await record("too_many");
      return { ...base, outcome: "too_many", remaining };
    }

    const provider = this.providers.get(args.exchange);
    if (provider && !provider.live) {
      await record("not_configured");
      return { ...base, outcome: "not_configured", remaining };
    }
    if (!provider) {
      await record("provider_error", "no provider configured");
      return { ...base, outcome: "provider_error", error: "no provider configured", remaining };
    }

    try {
      const res = await provider.lookup(uid, { discordUserId: args.userId });
      if (!res.referred) {
        await record("not_referred");
        return { ...base, outcome: "not_referred", remaining };
      }
      // The app API gave this UID to this member: a stale row for someone else in this server moves across.
      if (held && held.guild_id !== this.guildId) {
        await record("already_claimed", "held in another server");
        return { ...base, outcome: "already_claimed", remaining };
      }
      if (held) await this.db.releaseUid(args.exchange, uid);
      await this.db.addUid({ guild_id: this.guildId, discord_user_id: args.userId, exchange: args.exchange, uid, detail: res.detail ?? null });
      await record("verified");
      return { ...base, outcome: "verified", remaining };
    } catch (e) {
      if (e instanceof UidClaimedError && ONE_PER_EXCHANGE.has(e.code)) {
        await record("app_one_per_exchange", e.message);
        return { ...base, outcome: "app_one_per_exchange", remaining };
      }
      if (e instanceof UidClaimedError) {
        await record("already_claimed", e.message);
        return { ...base, outcome: "already_claimed", remaining };
      }
      if (e instanceof UidRevokedError) {
        await record("revoked", e.message);
        return { ...base, outcome: "revoked", remaining };
      }
      if (e instanceof UidInvalidError) {
        await record("bad_uid", e.message);
        return { ...base, outcome: "bad_uid", remaining };
      }
      const error = e instanceof ProviderError ? e.message : e instanceof Error ? e.message : String(e);
      await record("provider_error", error);
      return { ...base, outcome: "provider_error", error, remaining };
    }
  }
}
