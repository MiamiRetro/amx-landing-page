# Mirror bot rollout — dry run, 21 Sep 2026

Preflight for applying `bot/layouts/languages.json` to the live server. Nothing
in this pass wrote to Discord outside the `mirror-test` sandbox.

## 1. Preflight checks

| Check | Result |
|---|---|
| `npm test` | 10/10 pass |
| `npm run typecheck` | clean |
| `ANTHROPIC_API_KEY` | valid — live call to `claude-sonnet-5` returned 200 |
| Supabase (`scripts/smoke.ts`) | read + write + cache round-trip ok |
| Discord source-channel permissions (`scripts/perms.ts`) | ok on all 6 sources |
| Railway service status / logs | **not verified — see §4** |

## 2. Sandbox end-to-end (`scripts/e2e.ts`)

`ALL PASSED` — 31 checks against the `mirror-test` group, driven through a
temporary webhook so the running bot treats the post as foreign traffic.

Covered: mirror fan-out to zh/ko/id, author name and avatar carried, URLs,
`$TICKER`, markdown and user mentions preserved, channel mentions remapped to
each language's own twin, `message_map` rows written, edit propagation, reverse
direction (ko → en/id), delete propagation both ways.

The run is confirmed to have gone through the live translator: `usage_log`
recorded four fresh `anthropic:claude-sonnet-5` calls at 05:50 (296, 294, 78 and
69 output tokens) matching the messages posted. Note the suite asserts
*structure*, not that the text reads correctly in each language — the marker it
tracks is a code span precisely so translation cannot alter it. Quality still
rests on the bake-off, not on this suite.

## 3. Planned changes

`npm run channels -- apply layouts/languages.json --dry-run` produced 24
creations and **zero** deletions or modifications:

- **3 roles** — `中文`, `한국어`, `Bahasa Indonesia`
- **3 categories** — one per language, each visible to its language role plus
  `Moderators` and `Team - Will Not DM`
- **18 channels** — 6 per language: `announcements-*`, `trade-alerts-*` and
  `bitcoin-*` read-only; `general-*`, `trader-chat-*` and `help-desk-*`
  two-way

`apply` never deletes, so the operation is additive and re-runnable.

## 4. Open items before `--apply`

1. **Railway status and logs were not verified.** This session's egress policy
   blocks `backboard.railway.com` and `railway.com` (403 on CONNECT), and the
   Railway CLI is not installed, so neither deployment state nor logs could be
   read. The bot is nonetheless confirmed *running and translating*, inferred
   from the sandbox run: mirrors appeared within seconds and the translation
   calls landed in `usage_log`. Confirm replica count is still 1 before rollout
   — two replicas against one server would double-post every mirror.

2. **`#trade-alerts` is ambiguous.** The server has two channels matching it,
   `⚡・trade-alerts` and `🔒・trade-alerts`. The layout creates one
   `trade-alerts-*` twin per language, so `/mirror create` must name the
   intended source explicitly or it will bind to whichever resolves first.

3. **Input-token accounting under-reports cost.** *(fixed; measured 2026-10-04.)*
   `src/translate/anthropic.ts` recorded `input_tokens` and
   `cache_read_input_tokens` but never `cache_creation_input_tokens`, so
   whenever the prompt was written to cache the bulk of it landed in an
   uncounted field — the `in=2` rows. `usage_log` now has a separate
   `cache_creation_tokens` column; cache writes bill at 1.25× base input and
   cache reads at 0.1×, so folding them into `input_tokens` would misstate cost
   either way. The column is applied to the live database.

   **Measured over all 186 successful Sonnet 5 calls (2026-09-17 → 2026-10-03):
   zero cache reads. Not one.** The `in=2` rows were a 26-call window on
   17–21 Sep; the other 160 calls logged a full 1051–1585 input tokens
   (median ~1180). So real input volume is roughly **1200 tokens per call**,
   not 2 — use that for the rollout budget, not the old table.

   The root cause of `cached=0` was placement, not TTL: `cache_control` was
   passed as a *top-level* parameter, which auto-places the breakpoint on the
   last cacheable block — the per-message user turn. No two requests shared
   that prefix, so a call either wrote a fresh entry at 1.25× or did not cache
   at all, and nothing was ever read back. No amount of traffic would have
   changed that. The marker now sits on the system block, the only part of the
   prompt that is byte-identical across calls.

   Caveat: the system prompt is ~900–950 tokens, under Sonnet 5's 1024-token
   minimum cacheable prefix, so the marker is most likely **inert** on the
   current model — no write, no 1.25× premium, input volume simply reported in
   full. It starts paying off by itself if the system prompt grows past 1024,
   or on a model with a lower minimum (Opus 5 is 512). Re-run
   `scripts/usage.ts` after the next deploy to confirm; it now prints
   fresh / cache read / cache write plus a billed-equivalent total.

4. **13 channels remain invisible to the bot**, including `👑・vip-chat`
   (`View=✗`). None are in this layout, so this does not block the rollout, but
   any later mirror of those channels needs the bot added to the gating roles
   (or granted Administrator).

## 5. Apply command

```sh
cd bot
npm run channels -- apply layouts/languages.json          # drop --dry-run
```

Then, per source channel:

```sh
/mirror category lang:zh category:#╭───  中文  ───╮ role:@中文
/mirror create source:#💬・general name:general
```
