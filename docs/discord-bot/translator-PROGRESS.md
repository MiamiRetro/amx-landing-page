# AMX Discord bot — translator — progress

Read by the OS (BLKBOX › discord-translator). Audited 2026-10-06. Mirroring the
BLKBöX Trading Floor EN ↔ zh / ko / id since the 2026-09-21 rollout.

Code: bot/src/mirror and bot/src/translate on branch
claude/discord-multilingual-mirror-bot-k86ksq (Railway deploys that branch).
Verification and the start-here page have their own list:
docs/discord-bot/verification-PROGRESS.md.

## Shipped
- [x] Mirroring on 6 channel groups (4 two-way, 2 read-only) with webhook identity, edits, deletes, replies, attachments and a loop guard
- [x] Language picker buttons and /language, bot-managed language roles, native-language channel names

## Translation quality
- [ ] Harden translation — the glossary is empty and TRANSLATION_FALLBACKS is unset, so a Claude failure leaves text untranslated (12 of 206 calls failed, last on 2026-09-24); no native-speaker review yet
- [ ] Decide on the prompt cache — it never hits (system prompt is under the 1024-token minimum); spend is ~$1-3/month, so low priority

## More channels
- [ ] Deferred channels and Phase 4 — teaser twins for #trade-alerts and bot-profits; threads, reaction sync, per-user translate command, zh-TW (docs/discord-mirror-bot-plan.md §7, 10, 11)
