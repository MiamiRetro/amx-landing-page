# Brief for Hermes: the Discord multilingual mirror bot

Written 17 Sep 2026 for Hermes, the data collection agent, so it can plan around the mirror bot and read its data without disturbing it. The full design is in `discord-mirror-bot-plan.md`; the code is in `bot/`. This file is the short version with the facts a data agent needs.

## 1. What the bot does

The server is BLKBöX Trading Floor (guild `935681399095169035`, about 700 members). Every mirrored channel belongs to a *group*: one channel per language (`en`, `zh`, `ko`, `id`). A message posted in any channel of a group is translated by Claude and re-posted into every other channel of the group through a webhook, under the original author's display name and avatar. Edits and deletes propagate. Deleting a mirror deletes the original and the other mirrors.

Mirrors are posted by webhooks named **AMX Mirror**, one per channel, owned by the bot application. The bot user is **BLKBöX Translator** (`1546071825211985982`, same value as the application id).

## 2. Current state

| Item | State |
|---|---|
| Bot process | Running on Railway, one replica, translation provider `anthropic:claude-sonnet-5`. |
| Storage | Supabase project `lemmlfpumqtngtrnjvpv` (service-role only, RLS on, no public policies). |
| Live mirroring | Only the hidden sandbox group `mirror-test` (four channels under category `1549670440790790164`). Nothing member-facing is mirrored yet. |
| Real channels | Layout written and dry-run, awaiting the owner's go-ahead to create. Mirroring in them is a later, separate step. |

## 3. Channel structure

### Source channels (English, existing)

| Channel | ID | Mirror mode |
|---|---|---|
| 💬・general | `951524879126122506` | Two-way |
| 📈・trader-chat | `1513730525007839342` | Two-way |
| ☎️・help-desk | `1175147777202851870` | Two-way |
| 📢・announcements | `1294842329684770908` | Read-only twins |
| ⚡・trade-alerts | `1476459889302700184` | Read-only twins |
| 🟠・bitcoin | `937733105379328110` | Read-only twins |
| 🔒・trade-alerts (teaser for unverified) | `1122573112685371412` | Not in v1, see plan section 10 |

### Twin channels (planned, from `bot/layouts/languages.json`)

Three new categories, `╭───  中文  ───╮`, `╭───  한국어  ───╮` and `╭───  Bahasa Indonesia  ───╮`, each visible only to its language role plus Moderators and Team. Inside each, six channels named after the source with a language suffix: `announcements-<lang>`, `trade-alerts-<lang>`, `bitcoin-<lang>` (read-only, only the bot posts) and `general-<lang>`, `trader-chat-<lang>`, `help-desk-<lang>` (two-way, members post and their messages flow back to English).

Language roles: `中文`, `한국어`, `Bahasa Indonesia`. Members choose one through Discord Onboarding. Channel IDs for the twins do not exist yet; once created they will be in `channel_group_members` (section 5), which is the source of truth for "which channel is which language of which group".

## 4. Telling originals from mirrors

This is the single most important rule for any data collection. Every mirrored message exists once per language, so naive counting over-reports by up to 4x.

A message is a **mirror** when any of these hold:

- Its `webhook_id` is set and the webhook's name is `AMX Mirror` (or its `application_id` is `1546071825211985982`).
- Its message id appears in `message_map.mirror_message_id`.

A message is an **original** otherwise, whichever language channel it was posted in. An original posted in `general-ko` by a Korean member is the real event; its copies in `general`, `general-zh` and `general-id` are mirrors. So "language of the author" is the language of the channel the original was posted in, not the channel where you happened to read it.

Mirrors carry the `APP` tag in the Discord client and show the author's name but a webhook user id, not the member's id. To attribute a mirror to a real member, join through `message_map` to the source message and read its author.

Two visible quirks of mirrors:

- The first message a webhook posts with a given avatar URL arrives without the avatar and gets it via a `MESSAGE_UPDATE` about 150 ms later. That update has no `edited_timestamp`; it is not an edit.
- A message whose translation failed is still mirrored, untranslated, with a footer line `-# ⏳ translation pending`.

## 5. Data in Supabase

All tables are in the `public` schema. Timestamps are `timestamptz` in UTC. Discord ids are stored as `text`.

| Table | What it holds | Notes for collection |
|---|---|---|
| `channel_groups` | One row per group: `id`, `guild_id`, `name`, `paused`. | `name` is the human label, e.g. `general`. |
| `channel_group_members` | One row per channel in a group: `channel_id`, `group_id`, `lang`, `webhook_id`, `last_seen_message_id`. | The channel-to-language map. `webhook_token` is a secret, never read or log it. |
| `message_map` | One row per (source message, target channel): `source_message_id`, `source_channel_id`, `target_channel_id`, `mirror_message_id`, `lang`, `created_at`. | `lang` is the target language. A source message has one row per other channel in its group. Rows are deleted when the original is deleted. |
| `translation_cache` | `hash` (of source language + text), `lang`, translated `text`, `provider`. | Cache hits cost nothing; useful for measuring repeat content. |
| `usage_log` | One row per provider call: `at`, `provider`, `input_tokens`, `cached_tokens`, `output_tokens`, `segments`, `ms`, `ok`. | The cost and latency record. `ok=false` with 0 tokens means the API rejected the call. |
| `glossary` | Terms never translated. | Owner-managed via `/glossary`. |
| `settings` | Key-value per guild, e.g. the per-language category and role configuration. | |

Useful derivations:

- **Originals per language per day**: originals are messages in a group channel that are not in `message_map.mirror_message_id`. Group by the `lang` of `source_channel_id` in `channel_group_members`.
- **Mirror latency**: the Discord snowflake gives the post time: `timestamp_ms = (id >> 22) + 1420070400000`. Latency is `mirror_message_id` time minus `source_message_id` time.
- **Translation spend**: sum tokens in `usage_log` by day and provider. Cached input tokens are billed at a tenth of the input price.

## 6. Access

The bot uses the Supabase service-role key, which Hermes must not share. Give Hermes its own read path:

- Preferred: a Postgres role with `select` on the tables above, or RLS policies for a dedicated key. RLS is enabled with no policies, so the anon key returns nothing.
- Acceptable for a first pass: read-only queries through the Supabase MCP `execute_sql` tool.

For Discord itself, Hermes should use its own bot token with the `Guilds`, `GuildMessages` and `MessageContent` intents, not the mirror bot's token. Two processes on one token fight over the gateway session.

## 7. Rules of engagement

1. **Never post into a group channel through a webhook of your own.** The bot treats foreign webhook messages as originals and mirrors them. If Hermes must post, use a normal bot user, and prefer channels outside any group.
2. **Never delete a mirror message.** Deleting a mirror deletes the original in the source channel and every other mirror.
3. **Never run a second instance of the mirror bot** and never reuse its Discord token.
4. **Do not write to the bot's tables.** They are the bot's state. Read freely.
5. **Ignore `MESSAGE_UPDATE` events without `edited_timestamp`.** They are avatar resolution or link unfurls, not edits. The bot applies the same rule.
6. **Slash commands** (`/mirror status`, `/mirror pause`, `/glossary list`) are Administrator-only and meant for the owner, not for automation.

## 8. Where Hermes can help

- **Volume and cost forecast.** The plan still lacks confirmed 30-day activity per source channel with the bot able to see every channel. `bot/snapshots/activity-2026-09-17.md` is the latest attempt. A per-channel messages-per-day figure for the six sources gives the daily token estimate directly (one Claude call per original, roughly 250 output tokens per message for three targets).
- **Adoption after launch.** Members per language role over time, originals posted per language, and the share of two-way traffic that starts in a non-English channel.
- **Quality signals.** Messages that were mirrored with the `translation pending` footer, `usage_log` rows with `ok=false`, and edits that arrive within a minute of the original (a proxy for authors correcting a mistranslation, though most edits are ordinary).
- **Teaser decision.** Whether unverified (`New Member`) accounts split by language enough to justify the second role per language that the `🔒・trade-alerts` twins would need.

## 9. Pointers

| Need | Where |
|---|---|
| Design and decisions | `docs/discord-mirror-bot-plan.md` |
| Schema | `bot/src/db/schema.sql` |
| Which messages are originals vs mirrors, in code | `bot/src/mirror/mirror.ts` (`accepts`) and `bot/src/mirror/groups.ts` |
| Planned channel layout | `bot/layouts/languages.json` |
| Server snapshots | `bot/snapshots/` |
| Environment variable names | `bot/.env.example` |
| Sandbox and end-to-end test | `bot/scripts/sandbox.ts`, `bot/scripts/e2e.ts` |
