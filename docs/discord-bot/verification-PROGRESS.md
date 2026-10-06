# AMX Discord bot — verification — progress

Read by the OS (BLKBOX › discord-verification). Audited 2026-10-06.

Code: bot/src/verify, bot/src/startHere.ts and bot/scripts on branch
claude/discord-multilingual-mirror-bot-k86ksq (Railway deploys that branch).
Previews: `npx tsx scripts/post-start-here.ts --preview` and
`npx tsx scripts/post-verify.ts --preview` post to the hidden ops-only
#start-here-preview and #verify-preview channels; `--channel <name>` posts live.
The bot-wide housekeeping lives here too.

## Shipped
- [x] UID verification against the Bitget, Blofin and Bybit affiliate APIs: rate limiting, one UID per account, 12-hour key-health check, moderator /uid commands
- [x] Start-here page rebuilt as 5 branded cards (hero, language, rules, exchanges by country, community links)
- [x] Ops-only preview channels for the start-here page and the verify panel
- [x] Key-health alerts go to a Discord channel (VERIFY_ALERT_CHANNEL_ID is set)
- [x] Channel-manager CLI (snapshot / apply layout, never deletes) and ops scripts; typecheck clean, 24/24 tests pass

## Verification
- [ ] Prove Bitget and Blofin verification end to end — only Bybit has a confirmed success so far (bot/scripts/verify-probe.ts, src/verify/providers/bitget.ts and blofin.ts)
- [ ] Finish the start-here placeholders — MEXC and Toobit are "coming soon" with no affiliate links or providers, and "Open a Support Ticket" is a disabled button with no ticket flow (bot/src/startHere.ts)

## Funnel
- [ ] Build subscriber → verified tracking — per docs/funnel-and-tracking-plan.md nothing is built yet: events table and writer, invite attribution, Discord OAuth on blkbox.pro, one verification shared by site and Discord (members verify twice today), Hermes delivery, reporting

## Bot housekeeping
- [ ] Get bot/ onto main — Railway deploys straight from a working branch on every push, and claude/nice-ptolemy-wo5xbs has 2 prompt-cache commits that conflict with it (src/db/index.ts, src/translate/anthropic.ts); merge, point Railway at main, add watch path /bot/**
- [ ] Add an uptime alert — one replica, restarts capped at 10, no external check; railway.json's /health healthcheck doesn't look applied
- [ ] Refresh stale docs — hermes-mirror-bot-brief.md predates the rollout and the README skips verification, start-here and /language
