import { execFile } from "node:child_process";
import { log, errInfo } from "../log.js";

/**
 * Telegram warning when translation falls back off the primary provider, sent through
 * Hermes (`hermes send`, which reuses Hermes's own Telegram credentials).
 * Opt-in: set FALLBACK_ALERT_TELEGRAM to a `hermes send --to` target, e.g. "telegram:1102023288".
 * Only the Mac test bot sets it; Railway has no Hermes, so the live bot never alerts.
 *
 * Rate limit: the first fallback alerts right away; while it keeps happening, at most one
 * summary per ALERT_INTERVAL_MS with a count; one "back on primary" note once it recovers.
 */
const ALERT_INTERVAL_MS = 10 * 60 * 1000;

export class FallbackAlerter {
  private degraded = false;
  private lastSent = 0;
  private pending = 0;
  private lastReason = "";

  constructor(private target = process.env.FALLBACK_ALERT_TELEGRAM?.trim() ?? "", private send = hermesSend) {}

  get enabled(): boolean {
    return this.target !== "";
  }

  /** Called when a fallback provider served the request because the primary failed. */
  fellBack(primary: string, used: string, reason: string, targets: string[]): void {
    if (!this.enabled) return;
    this.lastReason = reason;
    const now = Date.now();
    if (!this.degraded) {
      this.degraded = true;
      this.lastSent = now;
      this.pending = 0;
      this.send(this.target, `⚠️ Translator fell back: ${primary} failed (${reason}), ${used} handled it [${targets.join(", ")}].`);
      return;
    }
    this.pending++;
    if (now - this.lastSent >= ALERT_INTERVAL_MS) {
      this.send(this.target, `⚠️ Translator still on fallback: ${this.pending} more fallback(s) in the last ${Math.round((now - this.lastSent) / 60000)} min. Last error: ${this.lastReason}.`);
      this.lastSent = now;
      this.pending = 0;
    }
  }

  /** Called when the primary served a request; sends one recovery note after an outage. */
  primaryOk(primary: string): void {
    if (!this.enabled || !this.degraded) return;
    this.degraded = false;
    const extra = this.pending ? ` (${this.pending} more fallback(s) since the last alert)` : "";
    this.pending = 0;
    this.send(this.target, `✅ Translator back on ${primary}${extra}.`);
  }
}

function hermesSend(target: string, text: string): void {
  execFile("hermes", ["send", "--to", target, "-q", text], { timeout: 30_000 }, (err) => {
    if (err) log.warn("fallback alert send failed", errInfo(err));
  });
}
