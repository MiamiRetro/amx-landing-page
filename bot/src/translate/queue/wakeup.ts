/**
 * A wakeup that is never lost. signal() while nobody is waiting is remembered,
 * so the next wait() returns at once. This is what lets a single sequential loop
 * (poll, then wait) use Realtime for latency and a timer as the backup without
 * ever running two polls at the same time.
 */
export class Wakeup {
  private pending = false;
  private wake: (() => void) | null = null;

  signal(): void {
    if (this.wake) {
      const w = this.wake;
      this.wake = null;
      w();
    } else this.pending = true;
  }

  /** Resolves after `ms`, on signal(), or when `abort` fires, whichever is first. */
  wait(ms: number, abort?: AbortSignal): Promise<void> {
    if (this.pending) {
      this.pending = false;
      return Promise.resolve();
    }
    if (abort?.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        abort?.removeEventListener("abort", done);
        this.wake = null;
        resolve();
      };
      const timer = setTimeout(done, Math.max(0, ms));
      abort?.addEventListener("abort", done, { once: true });
      this.wake = done;
    });
  }
}
