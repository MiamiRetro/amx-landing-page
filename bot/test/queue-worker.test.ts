import { test } from "node:test";
import assert from "node:assert/strict";
import type { LlamaChatResult } from "../src/translate/queue/llama.js";
import { QueueWorker, type LlamaApi } from "../src/translate/queue/worker.js";
import type { TranslateRequest } from "../src/translate/provider.js";
import { MemoryQueue, sleep, until } from "./support/memory-queue.js";

const Q = "translate-gemma4-test";

function request(over: Partial<TranslateRequest> = {}): TranslateRequest {
  return { segments: ["gm fam"], sourceLang: "en", targets: ["zh", "ko"], glossary: [], ...over };
}

function ok(content: string, extra: Partial<LlamaChatResult> = {}): LlamaChatResult {
  return { content, finishReason: "stop", promptTokens: 100, completionTokens: 20, cachedTokens: 0, reasoning: "", ...extra };
}

class FakeLlama implements LlamaApi {
  chats: { system: string; user: string; maxTokens: number }[] = [];
  concurrent = 0;
  maxConcurrent = 0;
  aborted = 0;
  isHealthy = true;
  tokenize: (t: string) => number = (t) => Math.ceil(t.length / 4);
  chatImpl: (user: string, signal: AbortSignal) => Promise<LlamaChatResult> = async () => ok('{"zh":["早安"],"ko":["굿모닝"]}');

  async countTokens(text: string): Promise<number> {
    return this.tokenize(text);
  }
  async healthy() {
    return this.isHealthy;
  }
  async chat(system: string, user: string, maxTokens: number, signal: AbortSignal): Promise<LlamaChatResult> {
    this.chats.push({ system, user, maxTokens });
    this.maxConcurrent = Math.max(this.maxConcurrent, ++this.concurrent);
    signal.addEventListener("abort", () => this.aborted++, { once: true });
    try {
      return await this.chatImpl(user, signal);
    } finally {
      this.concurrent--;
    }
  }
}

/** Resolves when the signal aborts, like a closed HTTP connection. */
function hang(signal: AbortSignal): Promise<never> {
  return new Promise((_res, rej) => signal.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")), { once: true }));
}

function setup(llama = new FakeLlama(), over: Partial<ConstructorParameters<typeof QueueWorker>[0]> = {}) {
  const queue = new MemoryQueue();
  const worker = new QueueWorker({ queue, llama, queueName: Q, workerId: "w1", model: "gemma4", pollMs: 20, heartbeatMs: 20, leaseSec: 0.15, ...over });
  return { queue, llama, worker };
}

const state = async (q: MemoryQueue, id: string) => (await q.get(id, false))!;

test("a job is claimed, run with a bounded max_tokens, and its result stored", async () => {
  const { queue, llama, worker } = setup();
  const id = queue.enqueueMs(Q, request(), 5000)!;
  worker.start();
  await until(() => queue.jobs.get(id)?.status === "succeeded");
  const st = await state(queue, id);
  assert.deepEqual((st.result as any).translations, { zh: ["早安"], ko: ["굿모닝"] });
  assert.equal(llama.chats.length, 1);
  assert.ok(llama.chats[0].maxTokens > 0 && llama.chats[0].maxTokens <= 4096);
  // Message text is gone from the row once the job is final.
  assert.deepEqual(queue.jobs.get(id)!.request, {});
  await worker.stop();
});

test("worker is strictly serial: never two generations at once", async () => {
  const llama = new FakeLlama();
  llama.chatImpl = async () => {
    await sleep(30);
    return ok('{"zh":["a"],"ko":["b"]}');
  };
  const { queue, worker } = setup(llama);
  const ids = [1, 2, 3, 4].map(() => queue.enqueueMs(Q, request(), 5000)!);
  worker.start();
  await until(() => ids.every((id) => queue.jobs.get(id)?.status === "succeeded"));
  assert.equal(llama.maxConcurrent, 1);
  assert.equal(llama.chats.length, 4);
  await worker.stop();
});

test("concurrent claimers never receive the same job", async () => {
  const queue = new MemoryQueue();
  const a = queue.enqueueMs(Q, request(), 5000)!;
  const b = queue.enqueueMs(Q, request(), 5000)!;
  const got = await Promise.all([queue.claim(Q, "w1", 60), queue.claim(Q, "w2", 60), queue.claim(Q, "w3", 60)]);
  const ids = got.filter(Boolean).map((j) => j!.id);
  assert.equal(ids.length, 2);
  assert.deepEqual(new Set(ids), new Set([a, b]));
});

test("a queued job already past its deadline is expired, not generated", async () => {
  const { queue, llama, worker } = setup();
  const id = queue.enqueueMs(Q, request(), 5)!;
  await sleep(25);
  worker.start();
  await sleep(120);
  assert.equal(llama.chats.length, 0);
  assert.equal((await state(queue, id)).status, "expired");
  await worker.stop();
});

test("the local HTTP request is aborted when the job deadline passes, and nothing is stored", async () => {
  const llama = new FakeLlama();
  llama.chatImpl = (_u, signal) => hang(signal);
  const { queue, worker } = setup(llama);
  const id = queue.enqueueMs(Q, request(), 700)!;
  worker.start();
  await until(() => llama.chats.length === 1);
  await until(() => llama.aborted === 1, 3000);
  await until(() => !worker.busy);
  const st = await state(queue, id);
  assert.equal(st.status, "expired");
  assert.equal(st.result, null);
  await worker.stop();
});

test("cancelling a running job aborts generation within a lease renewal", async () => {
  const llama = new FakeLlama();
  llama.chatImpl = (_u, signal) => hang(signal);
  const { queue, worker } = setup(llama);
  const id = queue.enqueueMs(Q, request(), 30_000)!;
  worker.start();
  await until(() => llama.chats.length === 1);
  await queue.cancel(id);
  await until(() => llama.aborted === 1);
  await until(() => !worker.busy);
  assert.equal((await state(queue, id)).status, "cancelled");
  await worker.stop();
});

test("a result arriving after cancel is rejected and never becomes readable", async () => {
  const queue = new MemoryQueue();
  const id = queue.enqueueMs(Q, request(), 5000)!;
  const claim = (await queue.claim(Q, "w1", 60))!;
  await queue.cancel(id);
  assert.equal(await queue.complete(id, claim.claimToken, { translations: { zh: ["x"] } }), false);
  assert.equal(await queue.renew(id, claim.claimToken, 60), false);
  const st = await state(queue, id);
  assert.equal(st.status, "cancelled");
  assert.equal(st.result, null);
});

test("only the current claim holder can complete a re-claimed job", async () => {
  const queue = new MemoryQueue();
  const id = queue.enqueueMs(Q, request(), 30_000)!;
  const first = (await queue.claim(Q, "w1", 0.01))!;
  await sleep(20); // lease lapses: worker 1 is presumed dead
  const second = (await queue.claim(Q, "w2", 60))!;
  assert.equal(second.id, id);
  assert.notEqual(second.claimToken, first.claimToken);
  assert.equal(await queue.complete(id, first.claimToken, { translations: {} }), false);
  assert.equal(await queue.complete(id, second.claimToken, { translations: {} }), true);
});

test("shutdown aborts the running request, fails the job at once and deregisters", async () => {
  const llama = new FakeLlama();
  llama.chatImpl = (_u, signal) => hang(signal);
  const { queue, worker } = setup(llama);
  const id = queue.enqueueMs(Q, request(), 30_000)!;
  worker.start();
  await until(() => llama.chats.length === 1);
  await worker.stop();
  assert.equal(llama.aborted, 1);
  const st = await state(queue, id);
  assert.equal(st.status, "failed");
  assert.match(st.error!, /worker_shutdown/);
  assert.equal(queue.workerAlive(Q, 60), false);
});

test("an over-budget request fails to cloud without calling the model", async () => {
  const llama = new FakeLlama();
  const { queue, worker } = setup(llama);
  const id = queue.enqueueMs(Q, request({ segments: ["x".repeat(40_000)] }), 5000)!;
  worker.start();
  await until(() => queue.jobs.get(id)?.status === "failed");
  assert.equal(llama.chats.length, 0);
  assert.match((await state(queue, id)).error!, /over_budget/);
  await worker.stop();
});

test("when the tokenizer is down the byte bound decides: small fits, large is refused", async () => {
  const llama = new FakeLlama();
  llama.tokenize = () => {
    throw new Error("tokenizer down");
  };
  const { queue, worker } = setup(llama);
  const small = queue.enqueueMs(Q, request(), 5000)!;
  const large = queue.enqueueMs(Q, request({ segments: ["가".repeat(2500)] }), 5000)!; // 7500 bytes
  worker.start();
  await until(() => queue.jobs.get(small)?.status === "succeeded" && queue.jobs.get(large)?.status === "failed");
  assert.equal(llama.chats.length, 1);
  assert.match((await state(queue, large)).error!, /byte bound/);
  await worker.stop();
});

test("max_tokens plus prompt plus headroom stays inside the configured window", async () => {
  const llama = new FakeLlama();
  llama.tokenize = (t) => t.length; // pessimistic: 1 token per char
  const { queue, worker } = setup(llama, { budget: { contextBudget: 8192, templateHeadroom: 128, maxOutputCap: 8192 } });
  queue.enqueueMs(Q, request(), 5000);
  worker.start();
  await until(() => llama.chats.length === 1);
  const c = llama.chats[0];
  assert.ok(llama.tokenize(c.system) + llama.tokenize(c.user) + 128 + c.maxTokens <= 8192);
  await worker.stop();
});

test("a reply cut off by max_tokens is failed, never stored truncated", async () => {
  const llama = new FakeLlama();
  llama.chatImpl = async () => ok('{"zh":["早', { finishReason: "length" });
  const { queue, worker } = setup(llama);
  const id = queue.enqueueMs(Q, request(), 5000)!;
  worker.start();
  await until(() => queue.jobs.get(id)?.status === "failed");
  assert.match((await state(queue, id)).error!, /truncated/);
  await worker.stop();
});

test("malformed model output fails the job so the bot can fall back", async () => {
  const llama = new FakeLlama();
  llama.chatImpl = async () => ok('{"zh":["only one language"]}');
  const { queue, worker } = setup(llama);
  const id = queue.enqueueMs(Q, request(), 5000)!;
  worker.start();
  await until(() => queue.jobs.get(id)?.status === "failed");
  assert.match((await state(queue, id)).error!, /bad_output/);
  await worker.stop();
});

test("heartbeat is sent while the model is healthy and withdrawn when it is not", async () => {
  const llama = new FakeLlama();
  const { queue, worker } = setup(llama);
  worker.start();
  await until(() => queue.workerAlive(Q, 5));
  llama.isHealthy = false;
  await until(() => !queue.workerAlive(Q, 5));
  llama.isHealthy = true;
  await until(() => queue.workerAlive(Q, 5));
  await worker.stop();
  assert.equal(queue.workerAlive(Q, 5), false);
});

test("a realtime insert wakes an idle worker long before the backup poll", async () => {
  const { queue, worker } = setup(new FakeLlama(), { pollMs: 5000 });
  worker.start();
  await sleep(50);
  const t0 = Date.now();
  const id = queue.enqueueMs(Q, request(), 5000)!;
  await until(() => queue.jobs.get(id)?.status === "succeeded", 1000);
  assert.ok(Date.now() - t0 < 1000);
  await worker.stop();
});

test("jobs on another environment's queue are never picked up", async () => {
  const { queue, llama, worker } = setup();
  const other = queue.enqueueMs("translate-gemma4-prod", request(), 5000)!;
  worker.start();
  await sleep(120);
  assert.equal(llama.chats.length, 0);
  assert.equal((await state(queue, other)).status, "queued");
  await worker.stop();
});
