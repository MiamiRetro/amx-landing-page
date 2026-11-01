import type { TranslateRequest } from "../provider.js";

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "expired";

export interface JobState {
  status: JobStatus;
  result: unknown;
  error: string | null;
}

export interface ClaimedJob {
  id: string;
  request: unknown;
  /** Time left before the job's deadline, measured by the database clock. */
  remainingMs: number;
  /** Proves ownership of this claim; required to renew, complete or fail. */
  claimToken: string;
  attempts: number;
}

export interface SubscribeHandlers {
  /** A job was added to the queue (worker wakeup). */
  onInsert?: () => void;
  /** A job changed state (bot wakeup). */
  onUpdate?: (jobId: string) => void;
  onStatus?: (status: string, err?: Error) => void;
}

/**
 * Everything the bot and the worker need from the queue. The production
 * implementation is SupabaseTranslationQueue (RPCs defined in db/schema.sql);
 * tests use an in-memory model of the same rules.
 */
export interface QueueApi {
  /** Returns the job id, or null when requireWorkerSec is set and no worker is alive. */
  enqueue(queue: string, request: TranslateRequest, opts: { deadlineSec: number; requireWorkerSec?: number }): Promise<string | null>;
  /** Reads a job; with consume, a final job is deleted as it is read. Null when it no longer exists. */
  get(jobId: string, consume: boolean): Promise<JobState | null>;
  /** False when the job was already final. */
  cancel(jobId: string): Promise<boolean>;
  claim(queue: string, workerId: string, leaseSec: number): Promise<ClaimedJob | null>;
  /** False when the claim is gone and the holder must stop. */
  renew(jobId: string, claimToken: string, leaseSec: number): Promise<boolean>;
  /** False when the result was rejected (cancelled, expired, or not the claim holder). */
  complete(jobId: string, claimToken: string, result: unknown): Promise<boolean>;
  fail(jobId: string, claimToken: string, error: string): Promise<boolean>;
  heartbeat(queue: string, workerId: string, info?: Record<string, unknown>): Promise<void>;
  workerStop(queue: string, workerId: string): Promise<void>;
  purge(): Promise<number>;
  /** Realtime wakeups; returns an unsubscribe function. Polling remains the backup. */
  subscribe(queue: string, handlers: SubscribeHandlers): () => Promise<void>;
}

/** What the worker writes into a job's result. Same shape as TranslateResult plus bookkeeping. */
export interface JobResult {
  translations: Record<string, string[]>;
  usage: { inputTokens: number; cachedTokens: number; cacheCreationTokens: number; outputTokens: number };
  model: string;
  ms: number;
}
