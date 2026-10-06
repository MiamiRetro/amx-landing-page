# AMX Discord bot — progress

Read by the OS (#discord-bot). Updated 2026-10-06. Running in production and
mirroring EN ↔ zh / ko / id since the 2026-09-21 rollout.

The code is in bot/ on main (merged 2026-10-06). Railway (project amx) still
deploys branch claude/discord-multilingual-mirror-bot-k86ksq until the source
is switched to main; see Housekeeping. Once it is, the /bot/** watch path means
editing this file doesn't redeploy the bot.

## Shipped
- [x] Mirroring on 6 channel groups (4 two-way, 2 read-only) with webhook identity, edits, deletes, replies, attachments and a loop guard
- [x] Language picker buttons and /language, bot-managed language roles, native-language channel names
- [x] Start-here page rebuilt as 5 branded cards (hero, language, rules, exchanges by country, community links)
- [x] UID verification against the Bitget, Blofin and Bybit affiliate APIs: rate limiting, one UID per account, 12-hour key-health check, moderator /uid commands
- [x] Channel-manager CLI (snapshot / apply layout, never deletes) and ops scripts; typecheck clean, 26/26 tests pass
- [x] Bitget verification fixed (2026-10-06): it read customer-commissions' empty list as a match, so any UID verified (nobody had used it; 0 Bitget verifications). Now POST /api/v2/broker/customer-list matched on the uid; checked live against real referrals and a canary
- [x] Blofin verification proven against the live API (2026-10-06): real invitees come back referred, a canary does not
- [x] UID tester page: `railway run npm run verify:ui` in bot/, then http://localhost:8611 (or the Tailscale IP). Read-only, same providers as the bot
- [x] Translation: Claude Haiku 4.5 set as TRANSLATION_FALLBACKS, glossary seeded (AlphanumetriX, AMX, BLKBöX, BLKBoX, Float), cache writes logged in their own usage_log column
- [x] claude/nice-ptolemy-wo5xbs merged; bot/ merged onto main; README covers verification, start-here, /language, /uid and the tester
- [x] VERIFY_ALERT_CHANNEL_ID set to #mod-chat; HEARTBEAT_URL hook in the bot (unset)

## Housekeeping
- [ ] Point Railway at main — in the dashboard (the CLI login can't change service settings): Source branch `main`, Watch Paths `/bot/**`, Healthcheck Path `/health`. railway.json under bot/ isn't read, because Railway looks for it at the repo root
- [ ] Let the bot post in #mod-chat — it can view the channel but not Send Messages, so key-health alerts fail with "health alert send failed" in the logs until it can
- [ ] Turn on the uptime alert — create a healthchecks.io check (period 5 min, grace 10 min) and set HEARTBEAT_URL on Railway
- [ ] Config as Code is deprecated on Railway from 2026-12-01 — move the build/deploy settings to .railway/railway.ts (`railway config migrate`) or delete bot/railway.json
- [ ] After the switch, delete claude/nice-ptolemy-wo5xbs and claude/discord-multilingual-mirror-bot-k86ksq on GitHub

## Verification
- [ ] First real member verification on Bitget and Blofin through Discord — the API side is proven; only Bybit has a member success so far
- [ ] Finish the start-here placeholders — MEXC and Toobit are "coming soon" with no affiliate links or providers, and "Open a Support Ticket" is a disabled button with no ticket flow (bot/src/startHere.ts)

## Funnel
- [ ] Build subscriber → verified tracking — per docs/funnel-and-tracking-plan.md nothing is built yet: events table and writer, invite attribution, Discord OAuth on blkbox.pro, one verification shared by site and Discord (members verify twice today), Hermes delivery, reporting

## Translation
- [ ] Native-speaker review of zh / ko / id output; grow the glossary with /glossary add as terms come up. 12 of 404 calls have failed, none since 2026-09-24
- [ ] Deferred channels and Phase 4 — teaser twins for #trade-alerts and bot-profits; threads, reaction sync, per-user translate command, zh-TW (docs/discord-mirror-bot-plan.md §7, 10, 11)
- [ ] Refresh hermes-mirror-bot-brief.md — it predates the rollout. Prompt cache decided: the breakpoint stays on the system block, inert while the system prompt is under Sonnet 5's 1024-token minimum; revisit only if the prompt grows
