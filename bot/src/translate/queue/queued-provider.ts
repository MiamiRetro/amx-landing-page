import type { SupabaseClient } from "@supabase/supabase-js";
import { config, type Lang } from "../../config.js";
import { log, errInfo } from "../../log.js";
import type { TranslateOptions, TranslateRequest, TranslateResult, TranslationProvider } from "../provider.js";
import type { JobResult, QueueApi } from "./api.js";
import { SupabaseTranslationQueue } from "./client.js";
import { translationQueueName } from "./names.js";
import { Wakeup } from "./wakeup.js";

/** No worker heartbeat: nothing was queued, so the caller can fall back immediately. */
export class QueueUnavailableError extends Error {}
/** The deadline passed; the job was cancelled and any late result is ignored. */
export class QueueTimeoutError extends Error {}
/** The worker reported failure (over budget, bad output, shutdown...) or the job vanished. */
export class QueueJobError extends Error {}

export interface QueuedProviderOptions {
  queue: QueueApi;
  /** Env-scoped queue name, see translationQueueName. */
  queueName: string;
  /** Model label, e.g. "gemma4"; the provider id is queued:<model>. */
  model: string;
  /** How long to wait for the worker before cancelling the job. */
  deadlineMs: number;
  /** Heartbeats older than this mean the worker is down. */
  workerTtlSec: number;
  /** Backup poll interval; Realtime normally wakes us sooner. */
  pollMs?: number;
}

/**
 * Submits the request to the Supabase queue and waits, bounded, for the local
 * worker's result. It only ever *reads* the result: the bot publishes to Discord,
 * the worker never does. When the deadline passes the job is cancelled in the
 * database, which makes the worker's late completion fail, so a result can be
 * consumed at most once and never after the caller moved on to the fallback.
 */
export class QueuedProvider implements TranslationProvider {
  readonly id: string;
  /** One queue attempt per request; the Translator's retry would otherwise wait out a second full deadline. */
  readonly maxAttempts = 1;
  private waiters = new Map<string, Wakeup>();
  private unsubscribe: (() => Promise<void>) | null = null;
  private pollMs: number;

  constructor(private o: QueuedProviderOptions) {
    this.id = `queued:${o.model}`;
    this.pollMs = o.pollMs ?? 1000;
  }

  /** Realtime is an optimisation; if it never connects, polling still delivers every result. */
  private ensureSubscribed() {
    if (this.unsubscribe) return;
    this.unsubscribe = this.o.queue.subscribe(this.o.queueName, {
      onUpdate: (id) => this.waiters.get(id)?.signal(),
      onStatus: (status, err) => {
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") log.warn("translation queue realtime unavailable, polling only", { status, ...(err ? errInfo(err) : {}) });
      },
    });
  }

  async close() {
    const u = this.unsubscribe;
    this.unsubscribe = null;
    await u?.().catch(() => {});
  }

  async translate(req: TranslateRequest, opts?: TranslateOptions): Promise<TranslateResult> {
    const signal = opts?.signal;
    if (signal?.aborted) throw new QueueTimeoutError("aborted before queueing");
    this.ensureSubscribed();

    const started = Date.now();
    const jobId = await this.o.queue.enqueue(this.o.queueName, req, {
      deadlineSec: Math.max(1, Math.ceil(this.o.deadlineMs / 1000)),
      requireWorkerSec: this.o.workerTtlSec,
    });
    if (!jobId) throw new QueueUnavailableError(`no live worker on ${this.o.queueName}`);

    const result = await this.waitFor(jobId, started + this.o.deadlineMs, signal);
    return toTranslateResult(result, req, this.id);
  }

  private async waitFor(jobId: string, localDeadline: number, signal?: AbortSignal): Promise<unknown> {
    const wake = new Wakeup();
    this.waiters.set(jobId, wake);
    let pollFailures = 0;
    try {
      // Strictly sequential: one get at a time, then sleep until the next
      // Realtime nudge or the backup interval. Polls can never overlap.
      for (;;) {
        if (signal?.aborted) break;
        try {
          const st = await this.o.queue.get(jobId, true);
          pollFailures = 0;
          if (!st) throw new QueueJobError(`job ${jobId} no longer exists`);
          if (st.status === "succeeded") return st.result;
          if (st.status === "failed") throw new QueueJobError(st.error ?? "worker failed the job");
          if (st.status === "cancelled" || st.status === "expired") throw new QueueTimeoutError(`job ${st.status}`);
        } catch (e) {
          if (e instanceof QueueJobError || e instanceof QueueTimeoutError) throw e;
          // A blip talking to Supabase: keep waiting, the deadline still bounds us.
          if (++pollFailures === 1) log.warn("translation queue poll failed", errInfo(e));
        }
        const left = localDeadline - Date.now();
        if (left <= 0) break;
        await wake.wait(Math.min(this.pollMs, left), signal);
      }
    } finally {
      this.waiters.delete(jobId);
    }

    // Gave up. Cancel so the worker stops and its late result is refused. If the
    // cancel loses a race with completion the job is already final: take that
    // result (we have not fallen back yet, so it still posts exactly once).
    const cancelled = await this.o.queue.cancel(jobId).catch((e) => {
      log.warn("translation queue cancel failed", { jobId, ...errInfo(e) });
      return true;
    });
    if (!cancelled) {
      const st = await this.o.queue.get(jobId, true).catch(() => null);
      if (st?.status === "succeeded") return st.result;
    }
    throw new QueueTimeoutError(signal?.aborted ? "aborted while waiting for worker" : `no result from worker within ${this.o.deadlineMs}ms`);
  }
}

function toTranslateResult(raw: unknown, req: TranslateRequest, id: string): TranslateResult {
  const r = raw as Partial<JobResult> | null;
  if (!r || typeof r !== "object" || !r.translations || typeof r.translations !== "object") throw new QueueJobError(`${id}: malformed result`);
  const translations: Partial<Record<Lang, string[]>> = {};
  for (const t of req.targets) {
    const arr = (r.translations as Record<string, unknown>)[t];
    if (!Array.isArray(arr) || arr.length !== req.segments.length || !arr.every((s) => typeof s === "string")) {
      throw new QueueJobError(`${id}: translation for ${t} malformed`);
    }
    translations[t] = arr as string[];
  }
  const u = r.usage;
  return {
    translations,
    usage: {
      inputTokens: Number(u?.inputTokens) || 0,
      cachedTokens: Number(u?.cachedTokens) || 0,
      cacheCreationTokens: Number(u?.cacheCreationTokens) || 0,
      outputTokens: Number(u?.outputTokens) || 0,
    },
  };
}

/** Builds the provider for a "queued:<model>" spec from environment config. */
export function queuedProviderFromEnv(model: string, sb?: SupabaseClient): QueuedProvider {
  if (!model) throw new Error('Provider "queued" needs a model after the colon, e.g. queued:gemma4');
  const queueName = translationQueueName(model, config.translationQueueEnv());
  // The queue must resolve before the Translator's own timeout, or its retry/fallback timer wins.
  const deadlineSec = Math.min(config.translationQueueDeadlineSec(), Math.max(1, config.translationTimeoutSec() - 2));
  return new QueuedProvider({
    queue: sb ? new SupabaseTranslationQueue(sb) : SupabaseTranslationQueue.fromEnv(),
    queueName,
    model,
    deadlineMs: deadlineSec * 1000,
    workerTtlSec: config.translationQueueWorkerTtlSec(),
  });
}
