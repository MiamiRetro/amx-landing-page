# AMX Discord Multilingual Mirror Bot — Plan

Goal: every text channel we choose gets a Chinese, Korean and Indonesian twin. A message posted in any one of the four appears in the other three within a couple of seconds, translated, under the original author's display name and avatar, with every mention, link, emoji, attachment, reply and edit carried across. A member who only ever opens the Korean channels should feel like the whole community speaks Korean.

Languages at launch: English (source community), Simplified Chinese (`zh`), Korean (`ko`), Indonesian (`id`). Adding a language later is a config change plus one new channel per group.

---

## 1. How it works (architecture)

```
                         ┌──────────────────────────┐
  #general (en) ──msg──▶ │                          │ ──webhook──▶ #general-zh
  #general-zh  ──msg──▶  │   mirror-bot (Node 22)   │ ──webhook──▶ #general-ko
  #general-ko  ──msg──▶  │   discord.js gateway     │ ──webhook──▶ #general-id
  #general-id  ──msg──▶  │                          │ ──webhook──▶ #general
                         └────┬──────────────┬──────┘
                              │              │
                     Claude API          Supabase Postgres
                  (translation)     (channel groups, message map,
                                     translation cache, glossary)
```

**Channel groups.** Each mirrored channel belongs to a *group* of four channels, one per language. Every channel in the group is both a source and a target: a Korean member typing in `#general-ko` is mirrored into `en`, `zh` and `id`. Groups live in one table so adding `#trading-signals` is one slash command.

**Identity via webhooks.** The bot never posts as itself. It creates one webhook per target channel and executes it with the author's guild display name and avatar URL. The message renders with the member's nickname and picture. This is the standard technique used by cross-server bridge bots and is the only way Discord allows a bot to post under another name.

**Translation via Claude.** One API call per source message returns all three target translations as structured JSON. The prompt carries a glossary of terms that must not be translated (`AMX`, tickers, "gm", "alpha", "degen", etc.) and strict rules for preserving Discord markup. Anything that is not human language (URLs, mentions, emoji, code) is swapped for placeholders before the call and restored after, so the model can never corrupt it.

**State in Supabase.** We already run Supabase. Four tables (below) hold config, the source-to-mirror message map (needed for edits, deletes, replies and jump links), a translation cache, and the glossary.

**Hosting.** The bot holds a persistent websocket to Discord's gateway, so it needs a long-running process, not Vercel serverless. Recommended: Fly.io or Railway, one small container (~$5 to $10 per month), Docker image, health endpoint, auto-restart. Vercel can host an admin dashboard later if wanted.

---

## 2. Making it seamless: what gets mirrored and how

| Element | How it is preserved | Notes |
|---|---|---|
| Author name and avatar | Webhook `username` = guild display name, `avatar_url` = guild-specific avatar if set, else user avatar | Discord shows a small `APP` tag next to webhook names. This is the one seam that cannot be removed. |
| User mentions `<@id>` | Placeholder before translation, restored after | Renders as `@Name` and pings the user in the mirror channel too. |
| Role mentions `<@&id>`, `@everyone`, `@here` | Same placeholder approach; `allowed_mentions` on the mirror copies exactly what Discord resolved on the original | Prevents a member without permission from getting `@everyone` pinged through the mirror. |
| Channel mentions `<#id>` | Remapped to the *same-language* twin in the target channel | `#trading-signals` in the English post becomes `#trading-signals-ko` in the Korean mirror. Channels with no twin are left as-is. |
| Message links (`discord.com/channels/...`) | Looked up in the message map and rewritten to the mirrored message in the reader's language | Falls back to the original link if the target message was never mirrored. |
| URLs | Placeholder, never translated | Link previews (embeds) re-unfurl automatically on the mirror. |
| Custom emoji `<:name:id>` / `<a:name:id>` | Placeholder | Same server, so they render in every twin. |
| Unicode emoji, markdown, spoilers, code blocks | Kept verbatim; code blocks and inline code are placeholders | Prompt instructs the model to keep bold/italic/line breaks. |
| Timestamps `<t:unix:F>` | Placeholder | Discord renders them in each viewer's locale anyway. |
| Attachments (images, video, files) | Downloaded and re-uploaded on the webhook | Discord CDN links expire, so linking is not enough. Size limit follows the server boost tier. |
| Stickers | Sent as the sticker's image | Webhooks cannot send stickers natively; Lottie stickers fall back to the sticker name. |
| Polls | Re-created on the webhook with translated question and options | Votes are not synced across languages (v2 candidate). |
| Replies | Quote block at the top of the mirror: `↩ **Name**: first 80 chars…` with a jump link to the mirrored parent | Webhooks cannot create native reply threads. |
| Edits | On `messageUpdate`, re-translate and PATCH every mirror | Discord shows `(edited)` on the mirrors. Ignores updates where only embeds changed (link unfurl). |
| Deletes | On `messageDelete`, delete every mirror | Moderation in one channel propagates to all. |
| Other bots (alert bots, chart posts) | Mirrored like humans, embeds translated field by field | Only our own webhook messages are skipped, to avoid loops. |
| Order | Per source channel, messages are processed strictly in order | Conversations read the same in every language. |
| Downtime | On startup, fetch messages posted since the last seen ID per channel and mirror them | No gaps after a deploy or crash. |

### Translation rules (system prompt, cached)
- Translate meaning and register, not words. Keep slang casual, keep hype hype.
- Never touch anything inside `⟦n⟧` placeholders. Output must contain every placeholder exactly once.
- Do not translate glossary terms, tickers (`$BTC`, `ETH`), handles, or numbers.
- Preserve line breaks, bold, italic, spoilers, bullet lists.
- Very short interjections (`gm`, `lol`, `lfg`) stay as-is unless a natural local equivalent exists.
- Return JSON: `{ "zh": "...", "ko": "...", "id": "..." }` (only the languages that differ from the source).

### Skip the API entirely when
- The message is only emoji, mentions, URLs, numbers, attachments or ≤2 characters.
- The exact normalised text has been translated before (cache hit, keyed by hash + target language, kept 30 days). Chat repeats a lot.

---

## 3. Member experience

- **Language pick on join.** Use Discord's built-in Onboarding to ask "Which language do you read?" and assign a role. Each language has its own category; channel permissions show a member only their language's category (plus any shared channels). Members can change the role at any time.
- **Consistent naming.** `#general`, `#general-zh`, `#general-ko`, `#general-id` inside categories named in the language itself (`一般`, `일반`, `Umum`).
- **Localized bot replies.** Slash-command responses use `interaction.locale`, so a Korean member sees Korean confirmations.
- **Pinned notice** in each mirrored channel (translated): "Messages here are mirrored and machine-translated from our English community. Reply here in your language and everyone sees it."
- **Moderation is unchanged.** Bans and timeouts are guild-wide. AutoMod runs on the original before it exists, so mirrors are of already-filtered content. Deleting any copy removes all copies.

---

## 4. Data model (Supabase)

```sql
create table channel_groups (
  id uuid primary key default gen_random_uuid(),
  guild_id text not null,
  name text not null,                -- "general"
  created_at timestamptz default now()
);

create table channel_group_members (
  group_id uuid references channel_groups(id) on delete cascade,
  channel_id text primary key,
  lang text not null,                -- 'en' | 'zh' | 'ko' | 'id'
  webhook_id text not null,
  webhook_token text not null,       -- encrypt at rest (pgsodium) or store in Fly secrets keyed by channel
  last_seen_message_id text
);

create table message_map (
  source_message_id text not null,
  source_channel_id text not null,
  target_channel_id text not null,
  mirror_message_id text not null,
  lang text not null,
  created_at timestamptz default now(),
  primary key (source_message_id, target_channel_id)
);
create index on message_map (mirror_message_id);   -- reverse lookups for jump links

create table translation_cache (
  hash text not null,                -- sha256(normalised source text)
  lang text not null,
  text text not null,
  created_at timestamptz default now(),
  primary key (hash, lang)
);

create table glossary (
  guild_id text not null,
  term text not null,
  note text,                         -- optional hint, e.g. "product name, keep in Latin script"
  primary key (guild_id, term)
);
```

Row-level security is on with only the service role allowed; the bot is the sole client.

---

## 5. Bot surface (slash commands, admin only)

| Command | What it does |
|---|---|
| `/mirror create name:general` | Creates the group and the three twin channels in the right categories, sets permissions, creates webhooks. |
| `/mirror link channel:#x lang:ko group:general` | Adds an existing channel to a group. |
| `/mirror unlink channel:#x` | Removes a channel from its group (channel stays, mirroring stops). |
| `/mirror status` | Shows groups, queue depth, last error, translation spend today. |
| `/mirror pause` / `resume` | Global kill switch. |
| `/glossary add term:AMX note:"brand, never translate"` | Maintains the do-not-translate list. |
| `/glossary list` | Lists terms. |

---

## 6. Translation engine choice and cost

Recommendation: Claude via the Anthropic SDK, with structured JSON output and a cached system prompt. An LLM handles trading slang, tone and the placeholder rules far better than a phrase-based translator, and it is cheaper than DeepL at our volumes (DeepL Pro bills ~$25 per million characters; three targets per message triples that).

Rough per-message shape: ~100 uncached input tokens, ~600 cached system-prompt tokens, ~150 output tokens (three translations). Estimates below assume standard cache-read discounts and that roughly a third of messages skip the API (cache hits, emoji-only, etc.).

| Model | ~cost per translated message | 1,000 msgs/day | 10,000 msgs/day |
|---|---|---|---|
| Claude Opus 5 (`claude-opus-5`) — best quality | ~$0.0046 | ~$95/mo | ~$950/mo |
| Claude Sonnet 5 (`claude-sonnet-5`) | ~$0.0018 | ~$37/mo | ~$370/mo |
| Claude Haiku 4.5 (`claude-haiku-4-5`) | ~$0.0009 | ~$18/mo | ~$180/mo |

Suggested default: start on Opus 5 at `effort: "low"` (translation is not a reasoning task) and measure quality on a sample of real messages in each language with native-speaking members. Drop to Sonnet 5 or Haiku 4.5 only if the quality holds; that is a business call, and the model is a single config value. Whichever is chosen, an outage falls back to a retry queue rather than dropping messages, and the message is mirrored untranslated with a small `(translation pending)` note if the queue backs up beyond 60 seconds.

Privacy note: message content leaves Discord to a third-party API. Add a line to the server rules and the pinned notice.

---

## 7. Build phases

**Phase 0 — Setup (½ day)**
- Create the Discord application, enable the Message Content and Server Members privileged intents (no approval needed under 100 servers), invite the bot with Manage Webhooks, Manage Channels, Read/Send Messages, Manage Messages, Attach Files, Read Message History.
- Supabase: apply the schema above.
- Anthropic API key, Fly.io/Railway project, secrets set.
- New repository `amx-mirror-bot` (TypeScript, discord.js v14, `@anthropic-ai/sdk`, `@supabase/supabase-js`, Dockerfile). This landing-page repo stays static.

**Phase 1 — Core mirror (2 to 3 days)**
- Gateway listener with per-source-channel FIFO queue.
- Placeholder tokenizer/detokenizer for all Discord entity types, with unit tests.
- Translation client: structured output, cached prompt, glossary injection, skip heuristics, cache table.
- Webhook sender with display name/avatar, `allowed_mentions` mirroring, 2,000-character splitting.
- Loop prevention and message map writes.
- `/mirror create|link|unlink|status`.

**Phase 2 — Fidelity (2 to 3 days)**
- Edits and deletes across all mirrors.
- Replies as quote blocks with jump links; message-link rewriting; channel-mention remapping.
- Attachments re-upload, stickers, polls, bot embeds translated per field.
- Startup backfill for missed messages.
- Rate-limit handling and retry queue with dead-letter logging.

**Phase 3 — Launch polish (1 to 2 days)**
- Onboarding language prompt, categories, permissions, pinned notices in all four languages.
- Glossary commands, localized command responses.
- Metrics: messages mirrored, latency p50/p95, API spend per day, error rate; alert to a private ops channel.
- Native-speaker review session per language with ~50 real messages; tune the prompt and glossary.

**Phase 4 — Later**
- Threads: create a twin thread on the mirrored message and mirror inside it.
- Reaction sync (bot re-reacts on mirrors, with a count).
- Poll vote aggregation across languages.
- Per-user "translate this" context-menu command for members who read a language they did not pick.
- Traditional Chinese (`zh-TW`) and further languages.

---

## 8. Known limits (say these up front)

- **`APP` badge.** Webhook messages carry a small `APP` label next to the name. Unavoidable; every bridge bot has it.
- **No native replies.** Mirrors quote the parent instead of threading it.
- **No typing indicator, no read state, no reaction sync in v1.**
- **Machine translation.** Good, not perfect. The glossary and native-speaker review loop are how quality is kept high; a `/report-translation` command can be added if members want to flag misses.
- **Double pings.** A member who opts into multiple language roles gets pinged in each. Onboarding defaults to one role.
- **Bot count.** Message Content intent is free under 100 servers; this bot is private to AMX so that never matters.

---

## 9. Decisions needed from you

1. Simplified or Traditional Chinese first (plan assumes Simplified).
2. Which channels to mirror at launch (plan assumes `#general` plus the signal/chart channels).
3. Model tier to start on (plan recommends Opus 5 at low effort, then measure).
4. Whether members may hold more than one language role.
5. Hosting preference: Fly.io, Railway, or an existing VPS.
