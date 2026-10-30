import { test } from "node:test";
import assert from "node:assert/strict";
import { HARD_CONTEXT_BUDGET, byteUpperBound, expectedOutputTokens, measurePrompt, planBudget, DEFAULT_BUDGET } from "../src/translate/queue/budget.js";
import { LlamaClient, buildChatBody } from "../src/translate/queue/llama.js";
import { translationQueueName } from "../src/translate/queue/names.js";
import { Wakeup } from "../src/translate/queue/wakeup.js";
import { sleep } from "./support/memory-queue.js";

test("a small request fits and max_tokens leaves prompt + headroom + output within 8192", () => {
  const plan = planBudget({ promptTokens: 900, segmentTokens: 30, exact: true }, 1, 3);
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.ok(plan.promptTokens + DEFAULT_BUDGET.templateHeadroom + plan.maxTokens <= HARD_CONTEXT_BUDGET);
  assert.ok(plan.maxTokens <= DEFAULT_BUDGET.maxOutputCap);
  assert.ok(plan.maxTokens >= plan.expectedOutput);
});

test("an oversized request is refused, never given a truncating max_tokens", () => {
  // 3 targets x 2 x 1500 segment tokens cannot fit in the output cap.
  const plan = planBudget({ promptTokens: 2400, segmentTokens: 1500, exact: true }, 1, 3);
  assert.equal(plan.ok, false);
  if (!plan.ok) assert.match(plan.reason, /over_budget/);
  // A prompt that nearly fills the window leaves no room even for a short answer.
  assert.equal(planBudget({ promptTokens: 8100, segmentTokens: 5, exact: true }, 1, 1).ok, false);
});

test("the configured budget can only tighten, never exceed, 8192", () => {
  // 8000 + headroom leaves 64 tokens of room: fits a 100k window, must not fit the clamped 8192.
  const loose = planBudget({ promptTokens: 8000, segmentTokens: 20, exact: true }, 1, 1, { ...DEFAULT_BUDGET, contextBudget: 100_000 });
  assert.equal(loose.ok, false);
  const tight = planBudget({ promptTokens: 1050, segmentTokens: 20, exact: true }, 1, 1, { ...DEFAULT_BUDGET, contextBudget: 1200 });
  assert.equal(tight.ok, false);
});

test("expected output grows with targets and segments", () => {
  assert.ok(expectedOutputTokens(100, 2, 3) > expectedOutputTokens(100, 2, 1));
  assert.ok(expectedOutputTokens(200, 2, 1) > expectedOutputTokens(100, 2, 1));
});

test("tokenizer failure falls back to the UTF-8 byte upper bound", async () => {
  const text = "안녕하세요 gm"; // multi-byte: bytes > characters
  assert.equal(byteUpperBound(text), Buffer.byteLength(text));
  const m = await measurePrompt("sys", text, [text], async () => {
    throw new Error("tokenizer down");
  });
  assert.equal(m.exact, false);
  assert.equal(m.promptTokens, byteUpperBound("sys") + byteUpperBound(text));
});

test("an abort is not swallowed into a byte estimate", async () => {
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    measurePrompt("s", "u", ["x"], async () => {
      throw new Error("aborted");
    }, ac.signal),
  );
});

test("chat body is text-only, non-thinking, non-streaming and bounded", () => {
  const b = buildChatBody("sys", "user", 512) as unknown as Record<string, unknown>;
  assert.deepEqual(b.chat_template_kwargs, { enable_thinking: false });
  assert.equal(b.stream, false);
  assert.equal(b.max_tokens, 512);
  assert.equal("tools" in b, false);
  assert.equal("model" in b, false);
  for (const m of b.messages as { content: unknown }[]) assert.equal(typeof m.content, "string");
});

test("LlamaClient hits the direct endpoints and sends the bounded body", async () => {
  const seen: { url: string; body: any }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    seen.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.endsWith("/tokenize")) return new Response(JSON.stringify({ tokens: [1, 2, 3] }));
    return new Response(
      JSON.stringify({ choices: [{ message: { content: '{"zh":["你好"]}' }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 4 } }),
    );
  }) as unknown as typeof fetch;
  const c = new LlamaClient({ baseUrl: "http://127.0.0.1:8081/", fetchImpl });
  assert.equal(await c.countTokens("hello"), 3);
  const r = await c.chat("s", "u", 256, new AbortController().signal);
  assert.equal(r.finishReason, "stop");
  assert.equal(r.completionTokens, 4);
  assert.equal(seen[0].url, "http://127.0.0.1:8081/tokenize");
  assert.equal(seen[1].url, "http://127.0.0.1:8081/v1/chat/completions");
  assert.equal(seen[1].body.max_tokens, 256);
  assert.equal(seen[1].body.chat_template_kwargs.enable_thinking, false);
});

test("queue names are env-scoped and validated", () => {
  assert.equal(translationQueueName("gemma4", "prod"), "translate-gemma4-prod");
  assert.equal(translationQueueName("gemma4", "Test Env!"), "translate-gemma4-test-env");
  assert.notEqual(translationQueueName("gemma4", "test"), translationQueueName("gemma4", "prod"));
  assert.throws(() => translationQueueName("gemma4", ""), /environment/);
  assert.throws(() => translationQueueName("gemma4", "x".repeat(80)));
});

test("Wakeup remembers a signal that arrives while nobody waits", async () => {
  const w = new Wakeup();
  w.signal();
  const t0 = Date.now();
  await w.wait(1000);
  assert.ok(Date.now() - t0 < 100);
  const t1 = Date.now();
  await w.wait(40); // consumed: this one really waits
  assert.ok(Date.now() - t1 >= 30);
});

test("Wakeup wakes a waiter early and honours abort", async () => {
  const w = new Wakeup();
  const p = w.wait(5000);
  await sleep(10);
  w.signal();
  const t0 = Date.now();
  await p;
  assert.ok(Date.now() - t0 < 100);
  const ac = new AbortController();
  const q = w.wait(5000, ac.signal);
  ac.abort();
  await q;
});
