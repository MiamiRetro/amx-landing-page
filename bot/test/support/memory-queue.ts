import { randomUUID } from "node:crypto";
import type { ClaimedJob, JobState, JobStatus, QueueApi, SubscribeHandlers } from "../../src/translate/queue/api.js";
import type { TranslateRequest } from "../../src/translate/provider.js";

interface Job {
  id: string;
  queue: string;
  status: JobStatus;
  request: unknown;
  result: unknown;
  error: string | null;
  attempts: number;
  claimToken: string | null;
  leaseExpiresAt: number | null;
  deadlineAt: number;
}

/**
 * In-memory model of the rules in db/schema.sql (claim ownership, deadline,
 * cancel, consume-on-read). It exists so the TypeScript on both sides can be
 * tested for races without a database. It is NOT evidence that the SQL behaves
 * this way; scripts/queue-bench.ts exercises the real functions.
 */
export class MemoryQueue implements QueueApi {
  jobs = new Map<string, Job>();
  workers = new Map<string, number>(); // `${queue}/${workerId}` -> heartbeat ms
  handlers: { queue: string; h: SubscribeHandlers }[] = [];
  getCalls = 0;
  getInFlight = 0;
  maxGetInFlight = 0;
  /** Artificial latency for get(), to expose overlapping polls. */
  getLatencyMs = 0;
  /** When false, subscribe() never fires: polling-only. */
  realtime = true;

  async enqueue(queue: string, request: TranslateRequest, opts: { deadlineSec: number; requireWorkerSec?: number }): Promise<string | null> {
    return this.enqueueMs(queue, request, opts.deadlineSec * 1000, opts.requireWorkerSec);
  }

  enqueueMs(queue: string, request: unknown, deadlineMs: number, requireWorkerSec?: number): string | null {
    if (requireWorkerSec !== undefined && !this.workerAlive(queue, requireWorkerSec)) return null;
    const id = randomUUID();
    this.jobs.set(id, {
      id, queue, status: "queued", request, result: null, error: null, attempts: 0,
      claimToken: null, leaseExpiresAt: null, deadlineAt: Date.now() + deadlineMs,
    });
    this.emit(queue, (h) => h.onInsert?.());
    return id;
  }

  workerAlive(queue: string, maxAgeSec: number): boolean {
    for (const [k, t] of this.workers) if (k.startsWith(`${queue}/`) && Date.now() - t < maxAgeSec * 1000) return true;
    return false;
  }

  private emit(queue: string, f: (h: SubscribeHandlers) => void) {
    if (!this.realtime) return;
    for (const s of this.handlers) if (s.queue === queue) f(s.h);
  }

  private finish(j: Job, status: JobStatus, patch: Partial<Job> = {}) {
    Object.assign(j, { status, request: {}, claimToken: null, leaseExpiresAt: null }, patch);
    this.emit(j.queue, (h) => h.onUpdate?.(j.id));
  }

  async get(jobId: string, consume: boolean): Promise<JobState | null> {
    this.getCalls++;
    this.maxGetInFlight = Math.max(this.maxGetInFlight, ++this.getInFlight);
    try {
      if (this.getLatencyMs) await new Promise((r) => setTimeout(r, this.getLatencyMs));
      const j = this.jobs.get(jobId);
      if (!j) return null;
      const live = j.status === "queued" || j.status === "running";
      const status: JobStatus = live && j.deadlineAt <= Date.now() ? "expired" : j.status;
      const out = { status, result: j.result, error: j.error };
      if (consume && status !== "queued" && status !== "running") this.jobs.delete(jobId);
      return out;
    } finally {
      this.getInFlight--;
    }
  }

  async cancel(jobId: string): Promise<boolean> {
    const j = this.jobs.get(jobId);
    if (!j || (j.status !== "queued" && j.status !== "running")) return false;
    this.finish(j, "cancelled", { result: null });
    return true;
  }

  async claim(queue: string, _workerId: string, leaseSec: number): Promise<ClaimedJob | null> {
    const now = Date.now();
    for (const j of this.jobs.values()) {
      if (j.queue === queue && (j.status === "queued" || j.status === "running") && j.deadlineAt <= now) this.finish(j, "expired", { error: "deadline passed" });
      if (j.queue === queue && j.status === "running" && j.leaseExpiresAt! <= now && j.attempts >= 3) this.finish(j, "failed", { error: "attempts exceeded" });
    }
    const next = [...this.jobs.values()].find(
      (j) => j.queue === queue && j.deadlineAt > now && (j.status === "queued" || (j.status === "running" && j.leaseExpiresAt! <= now && j.attempts < 3)),
    );
    if (!next) return null;
    next.status = "running";
    next.attempts++;
    next.claimToken = randomUUID();
    next.leaseExpiresAt = now + leaseSec * 1000;
    return { id: next.id, request: next.request, remainingMs: next.deadlineAt - now, claimToken: next.claimToken, attempts: next.attempts };
  }

  private held(jobId: string, token: string): Job | null {
    const j = this.jobs.get(jobId);
    return j && j.status === "running" && j.claimToken === token ? j : null;
  }

  async renew(jobId: string, token: string, leaseSec: number): Promise<boolean> {
    const j = this.held(jobId, token);
    if (!j || j.deadlineAt <= Date.now()) return false;
    j.leaseExpiresAt = Date.now() + leaseSec * 1000;
    return true;
  }

  async complete(jobId: string, token: string, result: unknown): Promise<boolean> {
    const j = this.held(jobId, token);
    if (!j || j.deadlineAt <= Date.now()) return false;
    this.finish(j, "succeeded", { result });
    return true;
  }

  async fail(jobId: string, token: string, error: string): Promise<boolean> {
    const j = this.held(jobId, token);
    if (!j) return false;
    this.finish(j, "failed", { error });
    return true;
  }

  async heartbeat(queue: string, workerId: string): Promise<void> {
    this.workers.set(`${queue}/${workerId}`, Date.now());
  }

  async workerStop(queue: string, workerId: string): Promise<void> {
    this.workers.delete(`${queue}/${workerId}`);
  }

  async purge(): Promise<number> {
    return 0;
  }

  subscribe(queue: string, h: SubscribeHandlers): () => Promise<void> {
    const entry = { queue, h };
    this.handlers.push(entry);
    return async () => {
      this.handlers = this.handlers.filter((x) => x !== entry);
    };
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await sleep(5);
  }
}
