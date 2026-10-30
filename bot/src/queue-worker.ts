/**
 * Local translation worker. Runs next to llama-server (Gemma) on our own machine,
 * claims jobs from the Supabase queue and writes results back. It makes only
 * outbound calls (Supabase, and llama-server on localhost): no inbound port, no
 * domain. It never touches Discord; the Railway bot publishes.
 *
 *   npm run queue:worker
 *
 * Needs SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and TRANSLATION_QUEUE_ENV.
 * Does not need (and should not be given) the Discord token.
 */
import { hostname } from "node:os";
import { setLogLevel, log, errInfo } from "./log.js";
import { config } from "./config.js";
import { HARD_CONTEXT_BUDGET, type BudgetConfig } from "./translate/queue/budget.js";
import { SupabaseTranslationQueue } from "./translate/queue/client.js";
import { LlamaClient } from "./translate/queue/llama.js";
import { translationQueueName } from "./translate/queue/names.js";
import { QueueWorker } from "./translate/queue/worker.js";

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer, got "${raw}"`);
  return n;
}

async function main() {
  setLogLevel(config.logLevel());
  const model = process.env.GEMMA_QUEUE_MODEL?.trim() || "gemma4";
  const queueName = translationQueueName(model, config.translationQueueEnv());
  const baseUrl = process.env.GEMMA_LLAMA_URL?.trim() || "http://127.0.0.1:8081";
  const llama = new LlamaClient({ baseUrl, jsonMode: process.env.GEMMA_JSON_MODE !== "off" });

  let contextBudget = Math.min(intEnv("GEMMA_CONTEXT_BUDGET", HARD_CONTEXT_BUDGET), HARD_CONTEXT_BUDGET);
  const nCtx = await llama.contextSize();
  if (nCtx !== null && nCtx < contextBudget) {
    log.warn("llama-server context is smaller than the budget, using it instead", { nCtx, contextBudget });
    contextBudget = nCtx;
  }
  const budget: BudgetConfig = {
    contextBudget,
    templateHeadroom: intEnv("GEMMA_TEMPLATE_HEADROOM_TOKENS", 128),
    maxOutputCap: intEnv("GEMMA_MAX_OUTPUT_TOKENS", 4096),
  };

  const workerId = process.env.GEMMA_WORKER_ID?.trim() || `${hostname()}-${process.pid}`;
  const worker = new QueueWorker({
    queue: SupabaseTranslationQueue.fromEnv(),
    llama,
    queueName,
    workerId,
    model,
    budget,
    pollMs: intEnv("TRANSLATION_QUEUE_POLL_MS", 1000),
    leaseSec: intEnv("TRANSLATION_QUEUE_LEASE_SEC", 60),
    heartbeatMs: intEnv("TRANSLATION_QUEUE_HEARTBEAT_MS", 5000),
  });

  worker.start();
  log.info("translation worker started", { queue: queueName, workerId, llama: baseUrl, budget, llamaHealthy: await llama.healthy() });

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info("worker shutting down", { signal });
    // Hard stop if graceful shutdown hangs (e.g. Supabase unreachable).
    setTimeout(() => process.exit(1), 10_000).unref();
    await worker.stop();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((e) => {
  log.error("worker fatal", errInfo(e));
  process.exit(1);
});
