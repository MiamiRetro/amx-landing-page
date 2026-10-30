import { z } from "zod";
import { LANGS } from "../../config.js";
import { log, errInfo } from "../../log.js";
import { extractJson } from "../openai-compatible.js";
import { SYSTEM_PROMPT, buildUserPrompt } from "../prompt.js";
import type { TranslateRequest } from "../provider.js";
import type { ClaimedJob, JobResult, QueueApi } from "./api.js";
import { DEFAULT_BUDGET, measurePrompt, planBudget, type BudgetConfig } from "./budget.js";
import type { LlamaChatResult } from "./llama.js";
import { Wakeup } from "./wakeup.js";

/** The slice of LlamaClient the worker uses, so tests can drive it without a server. */
export interface LlamaApi {
  countTokens(text: string, signal?: AbortSignal): Promise<number>;
  chat(system: string, user: string, maxTokens: number, signal: AbortSignal): Promise<LlamaChatResult>;
  healthy(): Promise<boolean>;
}

export interface WorkerOptions {
  queue: QueueApi;
  llama: LlamaApi;
  queueName: string;
  workerId: string;
  /** Label stored in results, e.g. "gemma4". */
  model: string;
  budget?: BudgetConfig;
  /** Backup claim poll interval; Realtime normally wakes the loop sooner. */
  pollMs?: number;
  /** Claim lease; renewed every third of it while a job runs. */
  leaseSec?: number;
  heartbeatMs?: number;
  purgeMs?: number;
  /** A claimed job with less time than this left is failed instead of started. */
  minRemainingMs?: number;
}

const RequestSchema = z.object({
  segments: z.array(z.string()).min(1),
  sourceLang: z.enum(LANGS),
  targets: z.array(z.enum(LANGS)).min(1),
  glossary: z.array(z.object({ term: z.string(), note: z.string().nullable() })),
  context: z.array(z.string()).optional(),
});

type AbortReason = "expired" | "lost_claim" | "shutdown";

/**
 * Serial worker: claims one job at a time, runs it against the local model and
 * writes the result back. It never talks to Discord. The local HTTP request is
 * aborted when the job's deadline passes, the claim is lost (cancelled), or the
 * worker shuts down.
 */
export class QueueWorker {
  private wakeup = new Wakeup();
  private stopping = new AbortController();
  private loopDone: Promise<void> | null = null;
  private unsubscribe: (() => Promise<void>) | null = null;
  private timers: NodeJS.Timeout[] = [];
  private hbBusy = false;
  private purgeBusy = false;
  private lastHealthy: boolean | null = null;
  private current: { jobId: string; abort: (r: AbortReason) => void } | null = null;
  private budget: BudgetConfig;
  private pollMs: number;
  private leaseSec: number;
  private minRemainingMs: number;

  constructor(private o: WorkerOptions) {
    this.budget = o.budget ?? DEFAULT_BUDGET;
    this.pollMs = o.pollMs ?? 1000;
    this.leaseSec = o.leaseSec ?? 60;
    this.minRemainingMs = o.minRemainingMs ?? 500;
  }

  get busy(): boolean {
    return this.current !== null;
  }

  start(): void {
    if (this.loopDone) throw new Error("worker already started");
    this.unsubscribe = this.o.queue.subscribe(this.o.queueName, {
      onInsert: () => this.wakeup.signal(),
      onStatus: (status, err) => {
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") log.warn("realtime unavailable, polling only", { status, ...(err ? errInfo(err) : {}) });
        else if (status === "SUBSCRIBED") log.info("realtime subscribed", { queue: this.o.queueName });
      },
    });
    void this.beat();
    this.timers.push(setInterval(() => void this.beat(), this.o.heartbeatMs ?? 5_000));
    this.timers.push(setInterval(() => void this.purge(), this.o.purgeMs ?? 60_000));
    this.loopDone = this.loop();
  }

  /** Aborts any running generation, fails its job so the bot falls back at once, and deregisters. */
  async stop(): Promise<void> {
    if (this.stopping.signal.aborted) return;
    this.stopping.abort();
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.current?.abort("shutdown");
    this.wakeup.signal();
    await this.loopDone;
    await this.o.queue.workerStop(this.o.queueName, this.o.workerId).catch((e) => log.warn("worker deregister failed", errInfo(e)));
    await this.unsubscribe?.().catch(() => {});
    this.unsubscribe = null;
  }

  /** One claim at a time, strictly sequential: this is the whole concurrency story. */
  private async loop(): Promise<void> {
    while (!this.stopping.signal.aborted) {
      let job: ClaimedJob | null = null;
      try {
        job = await this.o.queue.claim(this.o.queueName, this.o.workerId, this.leaseSec);
      } catch (e) {
        log.warn("claim failed", errInfo(e));
      }
      if (job) {
        await this.process(job);
        continue;
      }
      await this.wakeup.wait(this.pollMs, this.stopping.signal);
    }
  }

  private async beat(): Promise<void> {
    if (this.hbBusy || this.stopping.signal.aborted) return;
    this.hbBusy = true;
    try {
      const healthy = await this.o.llama.healthy();
      if (healthy !== this.lastHealthy) log[healthy ? "info" : "warn"]("local model health changed", { healthy });
      this.lastHealthy = healthy;
      if (this.stopping.signal.aborted) return;
      // No heartbeat while the model is down: the bot sees "no worker" and falls back at once.
      if (healthy) await this.o.queue.heartbeat(this.o.queueName, this.o.workerId, { model: this.o.model, busy: this.busy });
      else await this.o.queue.workerStop(this.o.queueName, this.o.workerId);
    } catch (e) {
      log.warn("heartbeat failed", errInfo(e));
    } finally {
      this.hbBusy = false;
    }
  }

  private async purge(): Promise<void> {
    if (this.purgeBusy) return;
    this.purgeBusy = true;
    try {
      const n = await this.o.queue.purge();
      if (n > 0) log.info("purged translation jobs", { rows: n });
    } catch (e) {
      log.warn("purge failed", errInfo(e));
    } finally {
      this.purgeBusy = false;
    }
  }

  private async process(job: ClaimedJob): Promise<void> {
    const started = Date.now();
    const ac = new AbortController();
    let reason: AbortReason | null = null;
    const abort = (r: AbortReason) => {
      if (reason) return;
      reason = r;
      ac.abort();
    };
    this.current = { jobId: job.id, abort };
    const timers: NodeJS.Timeout[] = [];
    try {
      if (job.remainingMs < this.minRemainingMs) {
        await this.fail(job, "deadline too close to start");
        return;
      }
      timers.push(setTimeout(() => abort("expired"), job.remainingMs));
      let renewing = false;
      timers.push(
        setInterval(() => {
          if (renewing) return;
          renewing = true;
          this.o.queue
            .renew(job.id, job.claimToken, this.leaseSec)
            .then((ok) => {
              if (!ok) abort("lost_claim");
            })
            .catch((e) => log.warn("lease renew failed", { jobId: job.id, ...errInfo(e) }))
            .finally(() => {
              renewing = false;
            });
        }, Math.min(1000, (this.leaseSec * 1000) / 3)),
      );

      const parsed = RequestSchema.safeParse(job.request);
      if (!parsed.success) {
        await this.fail(job, "bad_request: job payload does not match the translation request shape");
        return;
      }
      const req = parsed.data as TranslateRequest;
      const user = buildUserPrompt(req);

      const m = await measurePrompt(SYSTEM_PROMPT, user, req.segments, (t) => this.o.llama.countTokens(t, ac.signal), ac.signal);
      const plan = planBudget(m, req.segments.length, req.targets.length, this.budget);
      if (!plan.ok) {
        log.info("job over budget, leaving it to cloud", { jobId: job.id, reason: plan.reason });
        await this.fail(job, plan.reason);
        return;
      }

      const out = await this.o.llama.chat(SYSTEM_PROMPT, user, plan.maxTokens, ac.signal);
      if (out.reasoning) log.warn("model returned reasoning text although thinking is disabled", { jobId: job.id, chars: out.reasoning.length });
      if (out.finishReason === "length") {
        await this.fail(job, `truncated: hit max_tokens ${plan.maxTokens}`);
        return;
      }
      const translations = parseTranslations(out.content, req);
      const result: JobResult = {
        translations,
        usage: { inputTokens: Math.max(0, out.promptTokens - out.cachedTokens), cachedTokens: out.cachedTokens, cacheCreationTokens: 0, outputTokens: out.completionTokens },
        model: this.o.model,
        ms: Date.now() - started,
      };
      const accepted = await this.complete(job, result);
      if (!accepted) log.info("result rejected: job was cancelled, expired or reclaimed", { jobId: job.id, ms: result.ms });
      else log.info("job done", { jobId: job.id, ms: result.ms, promptTokens: out.promptTokens, outputTokens: out.completionTokens, exact: plan.exact });
    } catch (e) {
      const r = reason as AbortReason | null;
      if (r === "shutdown") await this.fail(job, "worker_shutdown");
      else if (r === "expired") log.info("job deadline passed, generation aborted", { jobId: job.id, ms: Date.now() - started });
      else if (r === "lost_claim") log.info("job cancelled by the bot, generation aborted", { jobId: job.id, ms: Date.now() - started });
      else {
        log.warn("job failed", { jobId: job.id, ...errInfo(e) });
        await this.fail(job, e instanceof Error ? e.message : String(e));
      }
    } finally {
      timers.forEach((t) => clearInterval(t));
      this.current = null;
    }
  }

  private async complete(job: ClaimedJob, result: JobResult): Promise<boolean> {
    try {
      return await this.o.queue.complete(job.id, job.claimToken, result);
    } catch (e) {
      log.warn("complete failed, retrying once", { jobId: job.id, ...errInfo(e) });
      return this.o.queue.complete(job.id, job.claimToken, result);
    }
  }

  private async fail(job: ClaimedJob, error: string): Promise<void> {
    try {
      await this.o.queue.fail(job.id, job.claimToken, error);
    } catch (e) {
      log.warn("fail report failed", { jobId: job.id, ...errInfo(e) });
    }
  }
}

function parseTranslations(content: string, req: TranslateRequest): Record<string, string[]> {
  const parsed = extractJson(content);
  const translations: Record<string, string[]> = {};
  for (const t of req.targets) {
    const arr = parsed[t];
    if (!Array.isArray(arr) || arr.length !== req.segments.length || !arr.every((s) => typeof s === "string")) {
      throw new Error(`bad_output: translation for ${t} malformed`);
    }
    translations[t] = arr as string[];
  }
  return translations;
}
