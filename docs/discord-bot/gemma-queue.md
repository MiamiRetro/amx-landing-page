# Gemma translation queue

Translate with Gemma 4 on our Studio, with Claude Sonnet as the safety net, and **no domain, no public endpoint, no inbound port**. The bot (Railway) and a worker (Studio) both only make outbound calls to Supabase.

```
Discord ─▶ Railway bot ──enqueue──▶ Supabase (translation_jobs) ◀──claim/complete── Studio worker ──▶ llama-server :8081
              │  ▲                        │ Realtime wakeups + 1 s poll backup
              │  └── reads result ────────┘
              └── on queue unavailable / timeout / worker failure ──▶ Sonnet (TRANSLATION_FALLBACKS)
```

- The **worker only writes a result**. The Railway bot stays the only thing that posts to Discord, so a late or duplicate result can never post twice.
- Defaults are untouched. Nothing changes until `TRANSLATION_PROVIDER` is switched.

## What each side does

**Bot, provider `queued:gemma4`** (`src/translate/queue/queued-provider.ts`)
1. `translation_enqueue` with `require_worker`: if no worker heartbeat in the last `TRANSLATION_QUEUE_WORKER_TTL_SEC` (15 s) it returns null and the provider throws at once. Sonnet runs immediately; nobody waits out a deadline for a dead worker.
2. Otherwise waits at most `TRANSLATION_QUEUE_DEADLINE_SEC` (20 s, capped below `TRANSLATION_TIMEOUT_SEC`). One sequential loop: read the job, then sleep until a Realtime nudge or 1 s, whichever is first. Polls never overlap.
3. On timeout (or if the Translator aborts it) the job is **cancelled in the database**. The worker's renewal then fails and it aborts generation; if it finishes anyway, `translation_complete` refuses the result. If the cancel loses a race to a completion, that one result is used, once.
4. The provider declares `maxAttempts = 1`, so the Translator's retry loop does not queue a second job. A bad result (damaged placeholders, malformed output) goes straight to the next provider. Cache and placeholder validation are unchanged and still apply.

**Worker** (`src/queue-worker.ts`, `src/translate/queue/worker.ts`)
- One job at a time. Claim (`FOR UPDATE SKIP LOCKED`, new `claim_token` per claim), lease renewed every third of `TRANSLATION_QUEUE_LEASE_SEC`, result written only with the token.
- Direct HTTP to `llama-server` (`GEMMA_LLAMA_URL`, default `http://127.0.0.1:8081`). No router, no `model` field, plain string messages (no images/audio/tools), `chat_template_kwargs.enable_thinking=false`, `stream=false`, bounded `max_tokens`.
- **Budget**: prompt + template headroom + `max_tokens` ≤ 8192. Prompt is counted with llama's `/tokenize`; if that fails it falls back to a UTF-8 byte upper bound (never under-counts). If the expected output does not fit, the job is **failed with `over_budget`** and the bot falls back to Sonnet. A reply that stops on `finish_reason=length` is also failed. Nothing is ever truncated silently or stored cut off.
- The local HTTP request is aborted when the job deadline passes, the bot cancels (lease renew returns false), or the worker shuts down. Jobs already past deadline are expired by the claim function and never generated.
- Heartbeat every 5 s, only while `/health` of llama-server is OK. When the model is down the worker withdraws its heartbeat, so the bot falls back immediately. On SIGTERM it aborts, fails the running job (`worker_shutdown`, so the bot falls back at once) and deregisters.

## Database

`src/db/schema.sql` (idempotent, additive; re-running the whole file is safe). Adds `translation_jobs`, `translation_workers` and `translation_*` functions.
- RLS on, no policies; table privileges revoked from `anon`/`authenticated`; every function is `SECURITY DEFINER`, `search_path = ''`, `EXECUTE` revoked from `public/anon/authenticated` and granted to `service_role` only.
- Message text is in `request` only while a job is live; it is blanked when the job reaches any final state, the bot deletes a row as it reads the result, and rows are deleted at `deadline + 10 min` at the latest (`translation_purge()`, called on every enqueue and by the worker every minute). Optional extra: `select cron.schedule('translation-purge','* * * * *','select public.translation_purge()')`.
- The table is added to the `supabase_realtime` publication for wakeups (service role only, because of RLS).

Apply: Supabase SQL editor → paste `src/db/schema.sql` → run. After applying, in **Database → Advisors** confirm no new warnings, and that `anon` cannot call the functions (`select has_function_privilege('anon','public.translation_claim(text,text,int)','execute')` → false).

## Environments

Queue name = `translate-<model>-<TRANSLATION_QUEUE_ENV>`, e.g. `translate-gemma4-prod` and `translate-gemma4-test`. `TRANSLATION_QUEUE_ENV` is required (falls back to Railway's `RAILWAY_ENVIRONMENT_NAME` for the bot). A worker only serves its own queue. Use different labels for the test and production bots so they never consume each other's jobs.

## Run the worker (Studio)

Use the existing Studio Gemma service on 8081. Keep its shared server context at **32768** for other workloads; the Discord worker enforces its own **8192** combined budget. Do not start another model or resize the shared server for this worker.

Then:

```sh
cd bot
SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… TRANSLATION_QUEUE_ENV=prod \
GEMMA_LLAMA_URL=http://127.0.0.1:8081 \
npm run queue:worker
```
(or put the variables in `bot/.env` on the Studio, which is gitignored). The worker needs the Supabase service key but **not** the Discord token. Exactly one worker per queue is intended; a second one is safe (claims are atomic) but gains nothing for a single-slot model.

Worker variables: `GEMMA_LLAMA_URL`, `GEMMA_CONTEXT_BUDGET` (default and max 8192; lowered automatically to llama's `n_ctx` if smaller), `GEMMA_MAX_OUTPUT_TOKENS` (4096), `GEMMA_TEMPLATE_HEADROOM_TOKENS` (128), `GEMMA_JSON_MODE=off` to drop `response_format`, `GEMMA_WORKER_ID`, `TRANSLATION_QUEUE_POLL_MS` (1000), `TRANSLATION_QUEUE_LEASE_SEC` (60), `TRANSLATION_QUEUE_HEARTBEAT_MS` (5000).

## Switch the bot over (Railway)

```
TRANSLATION_PROVIDER=queued:gemma4
TRANSLATION_FALLBACKS=anthropic:claude-sonnet-5
TRANSLATION_QUEUE_ENV=prod              # or rely on RAILWAY_ENVIRONMENT_NAME
TRANSLATION_QUEUE_DEADLINE_SEC=20       # optional
```
Set the fallback: with a queued primary and no fallback, a down worker leaves messages untranslated (the bot logs a warning at startup). Worst case for one message when the worker is up but slow: 20 s queue wait, then Sonnet.

### Rollback

Set these on Railway and redeploy/restart; no database change needed:
```
TRANSLATION_PROVIDER=anthropic:claude-sonnet-5
TRANSLATION_FALLBACKS=anthropic:claude-haiku-4-5   # restore pre-cutover fallback
```
Stopping the worker is also safe on its own: the bot sees no heartbeat and uses Sonnet immediately. The SQL is additive and can stay.

## Verify against the real thing

`scripts/queue-bench.ts` is opt-in and uses the real Supabase project (and the real model for the model scenarios). It uses isolated `translate-bench-<random>-<env>` queues and cleans up after itself.

```sh
cd bot
# SQL behaviour + bot-side fast fallback; needs only Supabase
QUEUE_LIVE_TEST=1 TRANSLATION_QUEUE_ENV=test npm run queue:bench -- --scenario claims,offline

# plus real Gemma round trips, mid-generation cancel and over-budget (llama-server must already be up)
QUEUE_LIVE_TEST=1 TRANSLATION_QUEUE_ENV=test npm run queue:bench -- --spawn-worker --count 10
```
It refuses `prod`/`production` labels unless `QUEUE_BENCH_ALLOW_PROD=1`. Scenarios: `claims` (concurrent SKIP LOCKED claims, claim ownership, cancel, deadline, lease re-claim, late completion rejected, consume-on-read), `offline` (no worker → fast failure; silent worker → bounded timeout and cancel), `live` (latency p50/p95, placeholders intact), `cancel`, `overbudget`.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Bot log `no live worker` / everything on Sonnet | Worker not running, llama-server unhealthy, or different `TRANSLATION_QUEUE_ENV` |
| Jobs fail `over_budget` | Message too long for 8192 tokens; expected, goes to Sonnet |
| Jobs fail `truncated` or `bad_output` | Raise `GEMMA_MAX_OUTPUT_TOKENS` (within the window) or try `GEMMA_JSON_MODE=off`; goes to Sonnet meanwhile |
| Log `realtime unavailable, polling only` | Table not in the `supabase_realtime` publication or Realtime off; still works at ≤1 s extra latency |
