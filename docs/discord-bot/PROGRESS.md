# AMX Discord bot — progress

Read by the OS (#discord-bot). Audited 2026-10-06. Running in production and
mirroring EN ↔ zh / ko / id since the 2026-09-21 rollout.

The code is in bot/ on branch claude/discord-multilingual-mirror-bot-k86ksq, which
Railway deploys (project amx). This file lives on main so editing it doesn't
redeploy the bot.

## Shipped
- [x] Mirroring on 6 channel groups (4 two-way, 2 read-only) with webhook identity, edits, deletes, replies, attachments and a loop guard
- [x] Language picker buttons and /language, bot-managed language roles, native-language channel names
- [x] Start-here page rebuilt as 5 branded cards (hero, language, rules, exchanges by country, community links)
- [x] UID verification against the Bitget, Blofin and Bybit affiliate APIs: rate limiting, one UID per account, 12-hour key-health check, moderator /uid commands
- [x] Channel-manager CLI (snapshot / apply layout, never deletes) and ops scripts; typecheck clean, 24/24 tests pass

## Housekeeping
- [ ] Get bot/ onto main — Railway deploys straight from a working branch on every push, and claude/nice-ptolemy-wo5xbs has 2 prompt-cache commits that conflict with it (src/db/index.ts, src/translate/anthropic.ts); merge, point Railway at main, add watch path /bot/**
- [ ] Set VERIFY_ALERT_CHANNEL_ID on Railway — without it the 12-hour key-health check only logs, so an expired affiliate key goes unnoticed until members' verifications fail
- [ ] Add an uptime alert — one replica, restarts capped at 10, no external check; railway.json's /health healthcheck doesn't look applied

## Verification
- [ ] Prove Bitget and Blofin verification end to end — only Bybit has a confirmed success so far (bot/scripts/verify-probe.ts, src/verify/providers/bitget.ts and blofin.ts)
- [ ] Finish the start-here placeholders — MEXC and Toobit are "coming soon" with no affiliate links or providers, and "Open a Support Ticket" is a disabled button with no ticket flow (bot/src/startHere.ts)

## Funnel
- [ ] Build subscriber → verified tracking — per docs/funnel-and-tracking-plan.md nothing is built yet: events table and writer, invite attribution, Discord OAuth on blkbox.pro, one verification shared by site and Discord (members verify twice today), Hermes delivery, reporting

## Translation
- [ ] Harden translation — the glossary is empty and TRANSLATION_FALLBACKS is unset, so a Claude failure leaves text untranslated (12 of 206 calls failed, last on 2026-09-24); no native-speaker review yet
- [ ] Deferred channels and Phase 4 — teaser twins for #trade-alerts and bot-profits; threads, reaction sync, per-user translate command, zh-TW (docs/discord-mirror-bot-plan.md §7, 10, 11)
- [ ] Refresh stale docs and decide on the prompt cache — hermes-mirror-bot-brief.md predates the rollout and the README skips verification, start-here and /language; the prompt cache never hits (system prompt is under the 1024-token minimum) but spend is ~$1-3/month, so low priority
