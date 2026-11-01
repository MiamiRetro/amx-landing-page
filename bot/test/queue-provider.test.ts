import { test } from "node:test";
import assert from "node:assert/strict";
import { Translator, providerFromSpec } from "../src/translate/index.js";
import { OpenAICompatibleProvider } from "../src/translate/openai-compatible.js";
import { AnthropicProvider } from "../src/translate/anthropic.js";
import type { TranslateRequest, TranslateResult, TranslationProvider } from "../src/translate/provider.js";
import { QueueJobError, QueuedProvider, QueueTimeoutError, QueueUnavailableError } from "../src/translate/queue/queued-provider.js";
import { QueueWorker, type LlamaApi } from "../src/translate/queue/worker.js";
import type { LlamaChatResult } from "../src/translate/queue/llama.js";
import { MemoryQueue, sleep, until } from "./support/memory-queue.js";

const Q = "translate-gemma4-test";
const req = (over: Partial<TranslateRequest> = {}): TranslateRequest => ({ segments: ["gm ⟦0⟧"], sourceLang: "en", targets: ["zh"], glossary: [], ...over });

function provider(queue: MemoryQueue, over: Partial<ConstructorParameters<typeof QueuedProvider>[0]> = {}) {
  return new QueuedProvider({ queue, queueName: Q, model: "gemma4", deadlineMs: 300, workerTtlSec: 15, pollMs: 25, ...over });
}

/** Stands in for a live worker heartbeat without running a worker. */
const beat = (q: MemoryQueue) => q.heartbeat(Q, "w1");

function llamaReplying(content: string | (() => Promise<LlamaChatResult>)): LlamaApi {
  return {
    countTokens: async (t) => Math.ceil(t.length / 4),
    healthy: async () => true,
    chat: async () =>
      typeof content === "string"
        ? { content, finishReason: "stop", promptTokens: 50, completionTokens: 10, cachedTokens: 0, reasoning: "" }
        : content(),
  };
}

function worker(queue: MemoryQueue, llama: LlamaApi) {
  return new QueueWorker({ queue, llama, queueName: Q, workerId: "w1", model: "gemma4", pollMs: 20, heartbeatMs: 20, leaseSec: 0.15 });
}

test("end to end: provider queues, worker answers, result is returned and the row consumed", async () => {
  const queue = new MemoryQueue();
  const w = worker(queue, llamaReplying('{"zh":["早 ⟦0⟧"]}'));
  w.start();
  await until(() => queue.workerAlive(Q, 5));
  const p = provider(queue);
  const r = await p.translate(req());
  assert.deepEqual(r.translations.zh, ["早 ⟦0⟧"]);
  assert.equal(r.usage.inputTokens, 50);
  assert.equal(r.usage.outputTokens, 10);
  assert.equal(queue.jobs.size, 0, "consumed on read, nothing lingers");
  await w.stop();
  await p.close();
});

test("no live worker: fails at once without queueing anything", async () => {
  const queue = new MemoryQueue();
  const p = provider(queue, { deadlineMs: 20_000 });
  const t0 = Date.now();
  await assert.rejects(p.translate(req()), QueueUnavailableError);
  assert.ok(Date.now() - t0 < 200, "must not wait out the deadline");
  assert.equal(queue.jobs.size, 0);
});

test("a stale heartbeat counts as no worker", async () => {
  const queue = new MemoryQueue();
  queue.workers.set(`${Q}/w1`, Date.now() - 60_000);
  await assert.rejects(provider(queue).translate(req()), QueueUnavailableError);
});

test("deadline: the job is cancelled and a late result from the worker is rejected", async () => {
  const queue = new MemoryQueue();
  await beat(queue);
  const p = provider(queue, { deadlineMs: 120 });
  const pending = p.translate(req());
  await until(() => queue.jobs.size === 1);
  const claim = (await queue.claim(Q, "w1", 60))!; // worker takes it and sits on it
  const t0 = Date.now();
  await assert.rejects(pending, QueueTimeoutError);
  assert.ok(Date.now() - t0 < 600);
  const job = [...queue.jobs.values()][0];
  assert.equal(job.status, "cancelled");
  // The worker finishes late: refused, so there is nothing for anyone to publish.
  assert.equal(await queue.complete(claim.id, claim.claimToken, { translations: { zh: ["late"] } }), false);
  assert.equal(job.result, null);
});

test("cancel losing the race to completion still yields the one result", async () => {
  const queue = new MemoryQueue();
  await beat(queue);
  const p = provider(queue, { deadlineMs: 150, pollMs: 1000 });
  queue.realtime = false;
  const pending = p.translate(req());
  await until(() => queue.jobs.size === 1);
  const claim = (await queue.claim(Q, "w1", 60))!;
  // Complete just before the provider's final cancel, after its last poll.
  await sleep(100);
  await queue.complete(claim.id, claim.claimToken, { translations: { zh: ["在最后"] }, usage: {} });
  const r = await pending;
  assert.deepEqual(r.translations.zh, ["在最后"]);
});

test("worker-reported failure surfaces immediately, not after the deadline", async () => {
  const queue = new MemoryQueue();
  const w = worker(queue, llamaReplying('{"zh":["a","b"]}')); // wrong length -> bad_output
  w.start();
  await until(() => queue.workerAlive(Q, 5));
  const t0 = Date.now();
  await assert.rejects(provider(queue, { deadlineMs: 10_000, pollMs: 5000 }).translate(req()), QueueJobError);
  assert.ok(Date.now() - t0 < 1500);
  await w.stop();
});

test("a malformed stored result is rejected rather than passed on", async () => {
  const queue = new MemoryQueue();
  await beat(queue);
  const p = provider(queue);
  const pending = p.translate(req());
  await until(() => queue.jobs.size === 1);
  const c = (await queue.claim(Q, "w1", 60))!;
  await queue.complete(c.id, c.claimToken, { translations: { zh: ["one", "two"] } });
  await assert.rejects(pending, QueueJobError);
});

test("realtime wakes the waiter well before the backup poll", async () => {
  const queue = new MemoryQueue();
  await beat(queue);
  const p = provider(queue, { deadlineMs: 10_000, pollMs: 5000 });
  const pending = p.translate(req());
  await until(() => queue.jobs.size === 1);
  await sleep(50);
  const c = (await queue.claim(Q, "w1", 60))!;
  const t0 = Date.now();
  await queue.complete(c.id, c.claimToken, { translations: { zh: ["快"] }, usage: {} });
  await pending;
  assert.ok(Date.now() - t0 < 500);
  await p.close();
});

test("polling alone delivers the result when realtime is down", async () => {
  const queue = new MemoryQueue();
  queue.realtime = false;
  await beat(queue);
  const p = provider(queue, { deadlineMs: 5000, pollMs: 20 });
  const pending = p.translate(req());
  await until(() => queue.jobs.size === 1);
  const c = (await queue.claim(Q, "w1", 60))!;
  await queue.complete(c.id, c.claimToken, { translations: { zh: ["轮询"] }, usage: {} });
  assert.deepEqual((await pending).translations.zh, ["轮询"]);
});

test("polls never overlap even when they are slower than the interval", async () => {
  const queue = new MemoryQueue();
  queue.realtime = false;
  queue.getLatencyMs = 30;
  await beat(queue);
  const p = provider(queue, { deadlineMs: 250, pollMs: 5 });
  await assert.rejects(p.translate(req()), QueueTimeoutError);
  assert.equal(queue.maxGetInFlight, 1);
  assert.ok(queue.getCalls >= 3);
});

test("aborting the call cancels the queued job", async () => {
  const queue = new MemoryQueue();
  await beat(queue);
  const ac = new AbortController();
  const pending = provider(queue, { deadlineMs: 10_000 }).translate(req(), { signal: ac.signal });
  await until(() => queue.jobs.size === 1);
  ac.abort();
  await assert.rejects(pending, QueueTimeoutError);
  assert.equal([...queue.jobs.values()][0].status, "cancelled");
});

// --- through the real Translator retry/fallback loop ---------------------------

function cloud(id: string, impl: (r: TranslateRequest) => TranslateResult["translations"]): TranslationProvider & { calls: number } {
  return {
    id,
    calls: 0,
    async translate(r) {
      this.calls++;
      return { translations: impl(r), usage: { inputTokens: 1, cachedTokens: 0, cacheCreationTokens: 0, outputTokens: 1 } };
    },
  };
}

test("Translator: worker unavailable goes straight to Sonnet with no queue attempt", async () => {
  const queue = new MemoryQueue();
  const sonnet = cloud("anthropic:claude-sonnet-5", (r) => ({ zh: r.segments.map((s) => `云 ${s}`) }));
  const tr = new Translator({ primary: provider(queue), fallbacks: [sonnet] });
  const t0 = Date.now();
  const r = await tr.translate(["hi ⟦0⟧"], [["<@1>"]], "en", ["zh"], []);
  assert.deepEqual(r.translations.zh, ["云 hi ⟦0⟧"]);
  assert.equal(sonnet.calls, 1);
  assert.equal(queue.jobs.size, 0);
  assert.ok(Date.now() - t0 < 300);
});

test("Translator: a queue timeout is ONE queue attempt, then the fallback", async () => {
  const queue = new MemoryQueue();
  await beat(queue); // worker "alive" but never answers
  const sonnet = cloud("anthropic:claude-sonnet-5", (r) => ({ zh: r.segments.map((s) => `云 ${s}`) }));
  const tr = new Translator({ primary: provider(queue, { deadlineMs: 100 }), fallbacks: [sonnet] });
  const t0 = Date.now();
  const r = await tr.translate(["hi ⟦0⟧"], [["<@1>"]], "en", ["zh"], []);
  assert.deepEqual(r.translations.zh, ["云 hi ⟦0⟧"]);
  assert.equal(queue.jobs.size, 1, "the retry loop must not enqueue a second job");
  assert.equal(sonnet.calls, 1);
  assert.ok(Date.now() - t0 < 1000, "not two full deadlines");
});

test("Translator: damaged placeholders from the local model go to cloud without a second queue job", async () => {
  const queue = new MemoryQueue();
  const w = worker(queue, llamaReplying('{"zh":["dropped the placeholder"]}'));
  w.start();
  await until(() => queue.workerAlive(Q, 5));
  const sonnet = cloud("anthropic:claude-sonnet-5", (r) => ({ zh: r.segments.map((s) => `云 ${s}`) }));
  const tr = new Translator({ primary: provider(queue, { deadlineMs: 2000 }), fallbacks: [sonnet] });
  const r = await tr.translate(["hi ⟦0⟧"], [["<@1>"]], "en", ["zh"], []);
  assert.deepEqual(r.translations.zh, ["云 hi ⟦0⟧"]);
  assert.equal(queue.jobs.size, 0, "first job consumed; no second was created");
  assert.equal(sonnet.calls, 1);
  await w.stop();
});

test("Translator: its own timeout aborts the provider, which cancels the job", async () => {
  const queue = new MemoryQueue();
  await beat(queue);
  const tr = new Translator({ primary: provider(queue, { deadlineMs: 10_000 }), timeoutMs: 80 });
  const r = await tr.translate(["hi"], [[]], "en", ["zh"], []);
  assert.equal(r.translated, false);
  await until(() => [...queue.jobs.values()].every((j) => j.status === "cancelled"));
});

test("Translator keeps its cache and placeholder validation for queued results", async () => {
  const queue = new MemoryQueue();
  const w = worker(queue, llamaReplying('{"zh":["早 ⟦0⟧"]}'));
  w.start();
  await until(() => queue.workerAlive(Q, 5));
  const puts: any[] = [];
  const db = {
    cacheGet: async () => new Map<string, string>(),
    cachePut: async (rows: unknown[]) => void puts.push(...rows),
    logUsage: async () => {},
  } as any;
  const tr = new Translator({ primary: provider(queue, { deadlineMs: 2000 }), db });
  const r = await tr.translate(["gm ⟦0⟧"], [["<@1>"]], "en", ["zh"], []);
  assert.equal(r.translated, true);
  assert.deepEqual(r.translations.zh, ["早 ⟦0⟧"]);
  assert.equal(puts.length, 1);
  assert.equal(puts[0].provider, "queued:gemma4");
  await w.stop();
});

// --- cloud adapters and defaults are unchanged ------------------------------------

test("cloud providers keep the default two attempts and are not queue-backed", () => {
  const prev = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key";
  try {
    const a: TranslationProvider = providerFromSpec("anthropic:claude-sonnet-5");
    assert.ok(a instanceof AnthropicProvider);
    assert.equal(a.id, "anthropic:claude-sonnet-5");
    assert.equal(a.maxAttempts, undefined);
  } finally {
    if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prev;
  }
});

test("OpenAI-compatible request body is unchanged", async () => {
  let body: any;
  const fetchImpl = (async (_u: string, init?: RequestInit) => {
    body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"zh":["你好"]}' } }], usage: { prompt_tokens: 5, completion_tokens: 2 } }));
  }) as unknown as typeof fetch;
  const p: TranslationProvider = new OpenAICompatibleProvider({ vendor: "openai", model: "m", baseUrl: "https://x/v1", apiKey: "k", fetchImpl });
  await p.translate({ segments: ["hi"], sourceLang: "en", targets: ["zh"], glossary: [] });
  assert.deepEqual(Object.keys(body).sort(), ["messages", "model", "response_format", "temperature"]);
  assert.equal(body.temperature, 0.2);
  assert.equal(p.maxAttempts, undefined);
});

test("Anthropic adapter request is unchanged", async () => {
  let args: any;
  const client = {
    messages: {
      parse: async (a: unknown) => {
        args = a;
        return { stop_reason: "end_turn", parsed_output: { zh: ["你好"] }, usage: { input_tokens: 1, output_tokens: 1 } };
      },
    },
  } as any;
  await new AnthropicProvider("claude-sonnet-5", client).translate({ segments: ["hi"], sourceLang: "en", targets: ["zh"], glossary: [] });
  assert.equal(args.max_tokens, 4096);
  assert.equal(args.model, "claude-sonnet-5");
  assert.equal(args.output_config.effort, "low");
  assert.equal(args.system[0].cache_control.type, "ephemeral");
});

test("queued:gemma4 resolves from env, is queue-scoped, and needs an environment label", () => {
  const keys = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "TRANSLATION_QUEUE_ENV", "RAILWAY_ENVIRONMENT_NAME"] as const;
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    process.env.SUPABASE_URL = "http://127.0.0.1:1";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test";
    delete process.env.TRANSLATION_QUEUE_ENV;
    delete process.env.RAILWAY_ENVIRONMENT_NAME;
    assert.throws(() => providerFromSpec("queued:gemma4"), /TRANSLATION_QUEUE_ENV/);
    process.env.TRANSLATION_QUEUE_ENV = "test";
    const p = providerFromSpec("queued:gemma4");
    assert.equal(p.id, "queued:gemma4");
    assert.equal(p.maxAttempts, 1);
    assert.throws(() => providerFromSpec("queued:"), /needs a model/);
  } finally {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
});
