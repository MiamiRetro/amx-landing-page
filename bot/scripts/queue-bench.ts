/**
 * Live exercise of the translation queue. Talks to the REAL Supabase project in
 * SUPABASE_URL and, for the model scenarios, the REAL llama-server. Nothing here
 * is mocked; it is opt-in because it writes (and cleans up) rows in a database.
 *
 *   QUEUE_LIVE_TEST=1 TRANSLATION_QUEUE_ENV=test npm run queue:bench -- [options]
 *
 * Scenarios (default: all that can run):
 *   claims    SQL behaviour: SKIP LOCKED claims, claim ownership, cancel, deadline,
 *             lease re-claim, late-completion rejection, consume-on-read.
 *   offline   Bot provider with no worker: must fail in well under a second.
 *   live      Real Gemma round trips through queue + worker; latency + validity.
 *   cancel    Cancel a long job mid-generation; the worker must abort llama.
 *   overbudget  An oversized request must fail to cloud, not run locally.
 *
 * Options:
 *   --scenario a,b       pick scenarios
 *   --spawn-worker       run a worker in this process (needs llama-server at
 *                        GEMMA_LLAMA_URL, default http://127.0.0.1:8081). Needed for
 *                        live/cancel/overbudget unless a worker is already running.
 *   --count N            round trips for `live` (default 5)
 *   --external-worker    target the real queue (translate-gemma4-<env>) served by a
 *                        separately running worker instead of an isolated bench queue
 *
 * Every bench queue is named translate-bench-<random>-<env>, so it can never
 * collide with the production queue. The Discord bot is not involved.
 */
import { randomBytes } from "node:crypto";
import { config } from "../src/config.js";
import { log, setLogLevel } from "../src/log.js";
import { placeholdersIntact } from "../src/mirror/placeholders.js";
import type { TranslateRequest } from "../src/translate/provider.js";
import { SupabaseTranslationQueue } from "../src/translate/queue/client.js";
import { LlamaClient } from "../src/translate/queue/llama.js";
import { translationQueueName } from "../src/translate/queue/names.js";
import { QueueUnavailableError, QueuedProvider, QueueTimeoutError } from "../src/translate/queue/queued-provider.js";
import { QueueWorker } from "../src/translate/queue/worker.js";

if (process.env.QUEUE_LIVE_TEST !== "1") {
  console.error("Skipped: this exercises a real Supabase project and (optionally) a real model. Set QUEUE_LIVE_TEST=1 to run it.");
  process.exit(2);
}

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(n);
const opt = (n: string) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};

setLogLevel(process.env.LOG_LEVEL ?? "warn");
const envLabel = config.translationQueueEnv();
if (/^(prod|production)$/i.test(envLabel) && process.env.QUEUE_BENCH_ALLOW_PROD !== "1") {
  console.error(`Refusing to run against environment "${envLabel}". Use a test label, or set QUEUE_BENCH_ALLOW_PROD=1 to run isolated bench queues against this project.`);
  process.exit(2);
}

const external = flag("--external-worker");
const spawnWorker = flag("--spawn-worker");
const benchQueue = external ? translationQueueName("gemma4", envLabel) : translationQueueName(`bench-${randomBytes(3).toString("hex")}`, envLabel);
const llamaUrl = process.env.GEMMA_LLAMA_URL?.trim() || "http://127.0.0.1:8081";
const q = SupabaseTranslationQueue.fromEnv();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Check {
  scenario: string;
  name: string;
  ok: boolean;
  detail?: string;
}
const checks: Check[] = [];
let current = "";
function check(name: string, ok: boolean, detail?: string) {
  checks.push({ scenario: current, name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

const synthetic = (text: string, targets: TranslateRequest["targets"] = ["zh", "ko", "id"]): TranslateRequest => ({
  segments: [text],
  sourceLang: "en",
  targets,
  glossary: [{ term: "AMX", note: "brand name" }],
});

const created: string[] = [];
async function enqueue(request: TranslateRequest, deadlineSec: number, requireWorkerSec?: number) {
  const id = await q.enqueue(benchQueue, request, { deadlineSec, requireWorkerSec });
  if (id) created.push(id);
  return id;
}

// --- claims: the SQL, for real ------------------------------------------------------

async function claims() {
  const r = synthetic("gm");
  const ids = [await enqueue(r, 60), await enqueue(r, 60), await enqueue(r, 60)] as string[];
  check("three jobs queued", ids.every(Boolean));

  const got = await Promise.all(["a", "b", "c", "d", "e"].map((w) => q.claim(benchQueue, `bench-${w}`, 30)));
  const claimed = got.filter((c) => c !== null);
  check("5 concurrent claimers on 3 jobs: exactly 3 win, all distinct", claimed.length === 3 && new Set(claimed.map((c) => c!.id)).size === 3, `${claimed.length} claimed`);
  const [c1, c2, c3] = claimed as NonNullable<(typeof claimed)[number]>[];

  check("a claim is owned: wrong token cannot complete", (await q.complete(c1.id, c2.claimToken, { translations: {} })) === false);
  check("a claim is owned: wrong token cannot renew", (await q.renew(c1.id, c2.claimToken, 30)) === false);
  check("holder renews its lease", (await q.renew(c1.id, c1.claimToken, 30)) === true);

  const done = await q.complete(c1.id, c1.claimToken, { translations: { zh: ["好"] }, usage: {}, model: "bench", ms: 1 });
  check("holder completes", done === true);
  check("a second completion is refused", (await q.complete(c1.id, c1.claimToken, { translations: { zh: ["重"] } })) === false);
  const st = await q.get(c1.id, true);
  check("result is readable once, then consumed", st?.status === "succeeded" && (await q.get(c1.id, false)) === null);

  check("cancel a running job", (await q.cancel(c2.id)) === true);
  check("late result after cancel is rejected", (await q.complete(c2.id, c2.claimToken, { translations: { zh: ["晚"] } })) === false);
  check("renew after cancel tells the worker to stop", (await q.renew(c2.id, c2.claimToken, 30)) === false);
  const s2 = await q.get(c2.id, true);
  check("cancelled job has no readable result", s2?.status === "cancelled" && s2.result === null);

  check("worker-reported failure is visible to the bot", (await q.fail(c3.id, c3.claimToken, "over_budget: test")) === true && (await q.get(c3.id, true))?.error === "over_budget: test");

  // Deadline: an unclaimed job past its deadline is never handed out.
  const short = (await enqueue(r, 1))!;
  await sleep(1500);
  check("expired queued job is not claimable", (await q.claim(benchQueue, "bench-x", 30)) === null);
  check("expired queued job reads as expired", (await q.get(short, true))?.status === "expired");

  // Late completion after the deadline.
  const late = (await enqueue(r, 2))!;
  const lc = await q.claim(benchQueue, "bench-y", 30);
  await sleep(2500);
  check("completion after the deadline is rejected", lc?.id === late && (await q.complete(late, lc.claimToken, { translations: { zh: ["晚"] } })) === false);
  check("deadline-passed job reads as expired", (await q.get(late, true))?.status === "expired");

  // Lease: a worker that dies is replaced, and the old claim is dead.
  const lease = (await enqueue(r, 60))!;
  const first = await q.claim(benchQueue, "bench-dead", 5);
  check("claim with a 5s lease", first?.id === lease);
  check("a live lease is not reclaimable", (await q.claim(benchQueue, "bench-new", 30)) === null);
  console.log("  ...waiting 6s for the lease to lapse");
  await sleep(6000);
  const second = await q.claim(benchQueue, "bench-new", 30);
  check("lapsed lease is reclaimed under a new token", second?.id === lease && second.claimToken !== first?.claimToken && second.attempts === 2);
  check("the dead worker's late result is rejected", first !== null && (await q.complete(lease, first.claimToken, { translations: {} })) === false);
  check("the new holder completes", second !== null && (await q.complete(lease, second.claimToken, { translations: { zh: ["ok"] } })) === true);
  await q.get(lease, true);
}

// --- offline: no worker ------------------------------------------------------------

function providerFor(queueName: string, deadlineMs: number) {
  return new QueuedProvider({ queue: q, queueName, model: "gemma4", deadlineMs, workerTtlSec: 15 });
}

async function offline() {
  const idle = translationQueueName(`bench-${randomBytes(3).toString("hex")}`, envLabel); // nobody serves this
  const p = providerFor(idle, 20_000);
  const t0 = Date.now();
  let err: unknown;
  await p.translate(synthetic("gm")).catch((e) => (err = e));
  const ms = Date.now() - t0;
  check("no worker: rejects as unavailable", err instanceof QueueUnavailableError);
  check("no worker: fallback signal arrives fast, not after the 20s deadline", ms < 2000, `${ms}ms`);
  await p.close();

  // Worker "alive" by heartbeat but never claims: bounded wait, then cancelled.
  await q.heartbeat(benchQueue, "bench-silent", {});
  const p2 = providerFor(benchQueue, 2000);
  const t1 = Date.now();
  let err2: unknown;
  await p2.translate(synthetic("gm")).catch((e) => (err2 = e));
  const ms2 = Date.now() - t1;
  check("silent worker: times out at the deadline", err2 instanceof QueueTimeoutError && ms2 >= 1800 && ms2 < 5000, `${ms2}ms`);
  const claimedAfter = await q.claim(benchQueue, "bench-z", 30);
  check("silent worker: the timed-out job was cancelled, not left to run later", claimedAfter === null);
  await q.workerStop(benchQueue, "bench-silent");
  await p2.close();
}

// --- model scenarios -----------------------------------------------------------------

const SAMPLES = [
  "gm fam, BTC looking strong today",
  "Anyone else getting liquidated on this wick? lfg anyway",
  "Funding is flipping negative, longs are getting squeezed",
  "Reminder: AMX weekly call starts in 10 minutes, bring your questions",
  "ETH/BTC finally breaking out, send it",
];

async function live(count: number) {
  const p = providerFor(benchQueue, 60_000);
  const lat: number[] = [];
  let valid = 0;
  for (let i = 0; i < count; i++) {
    const text = `${SAMPLES[i % SAMPLES.length]} ⟦0⟧`;
    const t0 = Date.now();
    try {
      const r = await p.translate(synthetic(text));
      const ms = Date.now() - t0;
      lat.push(ms);
      const intact = (["zh", "ko", "id"] as const).every((t) => r.translations[t]?.every((s) => placeholdersIntact(s, ["$ETH"])));
      if (intact) valid++;
      console.log(`  #${i + 1} ${ms}ms in=${r.usage.inputTokens} out=${r.usage.outputTokens} ${intact ? "ok" : "PLACEHOLDER DAMAGED"}  zh: ${r.translations.zh?.[0]}`);
    } catch (e) {
      console.log(`  #${i + 1} failed: ${e instanceof Error ? e.message : e}`);
    }
  }
  const sorted = [...lat].sort((a, b) => a - b);
  const pct = (x: number) => sorted[Math.min(sorted.length - 1, Math.floor(x * sorted.length))];
  check(`${count} real round trips through queue + worker + Gemma all succeeded`, lat.length === count, `p50=${pct(0.5)}ms p95=${pct(0.95)}ms`);
  check("placeholders intact in every translation", valid === count, `${valid}/${count}`);
  await p.close();
}

async function cancelLive(worker: QueueWorker | null) {
  const longText = Array.from({ length: 15 }, (_, i) => `Line ${i}: ${SAMPLES[i % SAMPLES.length]}.`).join("\n");
  const id = (await enqueue(synthetic(longText, ["zh"]), 120))!;
  if (!id) throw new Error("enqueue failed");
  const started = Date.now();
  while (Date.now() - started < 15_000) {
    if (worker?.busy) break;
    await sleep(100);
  }
  check("worker picked the long job up", worker ? worker.busy : true);
  await sleep(500);
  check("bot cancels it", (await q.cancel(id)) === true);
  const t0 = Date.now();
  while (worker && worker.busy && Date.now() - t0 < 15_000) await sleep(100);
  check("worker aborted the local generation after the cancel", worker ? !worker.busy : true, worker ? `${Date.now() - t0}ms` : "external worker: check its log for 'cancelled by the bot'");
  const st = await q.get(id, true);
  check("cancelled job never yields a result", st?.status === "cancelled" && st.result === null);
}

async function overbudget() {
  const huge = "word ".repeat(9000); // ~45 KB, far past an 8192-token window
  const id = (await enqueue(synthetic(huge, ["zh"]), 60))!;
  const t0 = Date.now();
  let st = await q.get(id, false);
  while (st && (st.status === "queued" || st.status === "running") && Date.now() - t0 < 30_000) {
    await sleep(250);
    st = await q.get(id, false);
  }
  check("oversized request is failed for cloud fallback, not run or truncated", st?.status === "failed" && /over_budget/.test(st.error ?? ""), `${st?.status}: ${st?.error?.slice(0, 80)}`);
  await q.get(id, true);
}

// --- run ---------------------------------------------------------------------------------

async function main() {
  console.log(`Supabase: ${config.supabaseUrl()}  queue: ${benchQueue}${external ? " (REAL queue, external worker)" : " (isolated bench queue)"}`);

  const llama = new LlamaClient({ baseUrl: llamaUrl });
  let worker: QueueWorker | null = null;
  const wanted = new Set((opt("--scenario") ?? "claims,offline,live,cancel,overbudget").split(",").map((s) => s.trim()));
  const needsModel = ["live", "cancel", "overbudget"].some((s) => wanted.has(s));

  if (needsModel && spawnWorker) {
    if (!(await llama.healthy())) {
      console.error(`llama-server at ${llamaUrl} is not healthy; start it first (the bench never starts a model). Skipping model scenarios.`);
      for (const s of ["live", "cancel", "overbudget"]) wanted.delete(s);
    } else {
      worker = new QueueWorker({ queue: q, llama, queueName: benchQueue, workerId: `bench-${process.pid}`, model: "gemma4", pollMs: 1000, heartbeatMs: 2000 });
      console.log(`Prepared in-process worker against ${llamaUrl}; starts after offline/SQL checks`);
    }
  } else if (needsModel && !external) {
    console.log("No worker for model scenarios: pass --spawn-worker (or --external-worker with a running worker). Skipping live/cancel/overbudget.");
    for (const s of ["live", "cancel", "overbudget"]) wanted.delete(s);
  }

  try {
    let workerStarted = false;
    const steps: [string, () => Promise<void>][] = [
      ["claims", claims],
      ["offline", offline],
      ["live", () => live(Number(opt("--count") ?? 5))],
      ["cancel", () => cancelLive(worker)],
      ["overbudget", overbudget],
    ];
    for (const [name, fn] of steps) {
      if (!wanted.has(name)) continue;
      if (worker && !workerStarted && ["live", "cancel", "overbudget"].includes(name)) {
        worker.start();
        workerStarted = true;
        await sleep(2500);
      }
      current = name;
      console.log(`\n[${name}]`);
      await fn();
    }
  } finally {
    await worker?.stop();
    for (const id of created) {
      await q.cancel(id).catch(() => {});
      await q.get(id, true).catch(() => {});
    }
    await q.purge().catch(() => {});
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  for (const f of failed) console.log(`  FAILED [${f.scenario}] ${f.name}${f.detail ? ` (${f.detail})` : ""}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  log.error("bench crashed", { error: e instanceof Error ? e.stack : String(e) });
  process.exit(1);
});
