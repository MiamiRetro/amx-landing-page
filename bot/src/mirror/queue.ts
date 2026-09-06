/** Strict FIFO per key (source channel), so mirrors appear in the original order. */
export class KeyedQueue {
  private chains = new Map<string, Promise<void>>();
  private depth = new Map<string, number>();

  run(key: string, task: () => Promise<void>): Promise<void> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    this.depth.set(key, (this.depth.get(key) ?? 0) + 1);
    const next = prev
      .catch(() => {})
      .then(task)
      .finally(() => {
        const d = (this.depth.get(key) ?? 1) - 1;
        if (d <= 0) {
          this.depth.delete(key);
          if (this.chains.get(key) === next) this.chains.delete(key);
        } else this.depth.set(key, d);
      });
    this.chains.set(key, next);
    return next;
  }

  get pending(): number {
    let n = 0;
    for (const d of this.depth.values()) n += d;
    return n;
  }
}

/** Simple counting semaphore used to cap concurrent translation requests. */
export class Semaphore {
  private waiting: (() => void)[] = [];
  private active = 0;

  constructor(private max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}
