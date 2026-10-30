import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "../../config.js";
import type { TranslateRequest } from "../provider.js";
import type { ClaimedJob, JobState, JobStatus, QueueApi, SubscribeHandlers } from "./api.js";

/** QueueApi over the service-role RPCs in db/schema.sql. */
export class SupabaseTranslationQueue implements QueueApi {
  constructor(private sb: SupabaseClient) {}

  static fromEnv(): SupabaseTranslationQueue {
    return new SupabaseTranslationQueue(createClient(config.supabaseUrl(), config.supabaseServiceKey(), { auth: { persistSession: false } }));
  }

  private async rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await this.sb.rpc(fn, args);
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data as T;
  }

  async enqueue(queue: string, request: TranslateRequest, opts: { deadlineSec: number; requireWorkerSec?: number }): Promise<string | null> {
    return this.rpc<string | null>("translation_enqueue", {
      p_queue: queue,
      p_request: request,
      p_deadline_seconds: opts.deadlineSec,
      p_require_worker_seconds: opts.requireWorkerSec ?? null,
    });
  }

  async get(jobId: string, consume: boolean): Promise<JobState | null> {
    const rows = await this.rpc<{ job_status: JobStatus; job_result: unknown; job_error: string | null }[]>("translation_get", {
      p_job_id: jobId,
      p_consume: consume,
    });
    const r = rows[0];
    return r ? { status: r.job_status, result: r.job_result, error: r.job_error } : null;
  }

  cancel(jobId: string): Promise<boolean> {
    return this.rpc<boolean>("translation_cancel", { p_job_id: jobId });
  }

  async claim(queue: string, workerId: string, leaseSec: number): Promise<ClaimedJob | null> {
    const rows = await this.rpc<
      { job_id: string; job_request: unknown; job_remaining_ms: number | string; job_claim_token: string; job_attempts: number }[]
    >("translation_claim", { p_queue: queue, p_worker_id: workerId, p_lease_seconds: leaseSec });
    const r = rows[0];
    if (!r) return null;
    return { id: r.job_id, request: r.job_request, remainingMs: Number(r.job_remaining_ms), claimToken: r.job_claim_token, attempts: r.job_attempts };
  }

  renew(jobId: string, claimToken: string, leaseSec: number): Promise<boolean> {
    return this.rpc<boolean>("translation_renew", { p_job_id: jobId, p_claim_token: claimToken, p_lease_seconds: leaseSec });
  }

  complete(jobId: string, claimToken: string, result: unknown): Promise<boolean> {
    return this.rpc<boolean>("translation_complete", { p_job_id: jobId, p_claim_token: claimToken, p_result: result });
  }

  fail(jobId: string, claimToken: string, error: string): Promise<boolean> {
    return this.rpc<boolean>("translation_fail", { p_job_id: jobId, p_claim_token: claimToken, p_error: error });
  }

  async heartbeat(queue: string, workerId: string, info?: Record<string, unknown>): Promise<void> {
    await this.rpc<null>("translation_heartbeat", { p_queue: queue, p_worker_id: workerId, p_info: info ?? null });
  }

  async workerStop(queue: string, workerId: string): Promise<void> {
    await this.rpc<null>("translation_worker_stop", { p_queue: queue, p_worker_id: workerId });
  }

  purge(): Promise<number> {
    return this.rpc<number>("translation_purge", {});
  }

  subscribe(queue: string, h: SubscribeHandlers): () => Promise<void> {
    const filter = `queue=eq.${queue}`;
    const ch = this.sb.channel(`translation-queue:${queue}:${randomUUID()}`);
    if (h.onInsert) {
      const onInsert = h.onInsert;
      ch.on("postgres_changes", { event: "INSERT", schema: "public", table: "translation_jobs", filter }, () => onInsert());
    }
    if (h.onUpdate) {
      const onUpdate = h.onUpdate;
      ch.on("postgres_changes", { event: "UPDATE", schema: "public", table: "translation_jobs", filter }, (p) => {
        const id = (p.new as { id?: string } | undefined)?.id;
        if (id) onUpdate(id);
      });
    }
    ch.subscribe((status, err) => h.onStatus?.(status, err));
    return async () => {
      await this.sb.removeChannel(ch);
    };
  }
}
