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

**Hosting.** The bot holds a persistent websocket to Discord's gateway, so it needs a long-running process, not Vercel serverless. Decision: Railway, one small container (~$5 to $10 per month) built from the `bot/` directory, health endpoint, auto-restart. Vercel can host an admin dashboard later if wanted.

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

## 6. Translation engine: research findings (6 Sep 2026)

Three research passes were run: community discussion (Reddit, Hacker News), open-weight models (GitHub, Hugging Face, WMT results) and commercial APIs (WMT25 human-evaluation data, vendor pricing). **Reddit could not be read**: this environment's network policy blocks reddit.com, Hacker News pages, Hugging Face and arXiv, so community sentiment below comes only from Hacker News snippets and GitHub issue trackers. Rerun that pass from a machine with open access before treating it as settled.

### What the evidence says

**Frontier LLMs beat dedicated MT engines for chat, and are within one statistical cluster of each other.** In WMT25's human evaluation for English→Chinese (recomputed from the organisers' published data), Claude 4 scored 86.9, DeepSeek V3 85.0, GPT-4.1 84.0 and Gemini 2.5 Pro 83.8, all above the human reference at 82.1. On the "social" subset (real social-media posts) Gemini 2.5 Pro led. The anonymised Google/Microsoft/DeepL-class engines ranked so far behind on automatic metrics that they were not selected for human evaluation. Sources: WMT25 findings and the `wmt25-general-mt` data repository.

**Korean and Indonesian have weaker evidence.** WMT25 English→Korean used a human metric whose data was not published; automatic rankings put Gemini 2.5 Pro, GPT-4.1 and Claude 4 at the top in that order. English→Indonesian was automatic-only, with Gemini and GPT leading and Claude mid-table. A 2026 vendor benchmark (Alconost) reports the opposite for Indonesian, with Anthropic models ahead. Treat all three as a tie to be settled by our own test.

**Register matters more than model choice for Korean.** An LREC 2026 paper finds MT-tuned models over-use polite forms compared with what readers prefer. The prompt must say "casual chat register, 반말 unless the source is formal" explicitly. Same logic applies to Indonesian slang (bahasa gaul).

**Open-weight: one credible candidate.** Tencent's Hy-MT2 (May 2026, Apache-2.0, 33 languages including zh, ko, id) self-reports 98% of Gemini 3.1 Pro on FLORES-200 and is served on OpenRouter at $0.074 in / $0.295 out per million tokens, roughly 25 times cheaper than Sonnet 5. Two cautions: its predecessor topped WMT25 on automatic metrics but fell "considerably lower" than Gemini under human evaluation, and its GitHub issues document over-translation of very short inputs (a one-word input expanded into three sentences) and mid-output language drift. Short hype messages and tickers are exactly our traffic. The predecessor HY-MT1.5 is unusable anyway: its licence excludes South Korea. Tower+, NLLB and Aya are non-commercial. TranslateGemma and Xiaomi's MiLMMT have no serverless host and no independent Korean or Indonesian evaluation.

**Community complaints worth designing around.** LLMs occasionally hallucinate or add content (HN, several threads); NMT engines lack context and cannot be told the register. Our placeholder scheme, glossary and structured output address the first; the prompt addresses the second.

### Recommendation

The bot is built model-agnostic: a `TranslationProvider` interface with adapters, and the model is one config value. Pick the launch model by a **blind bake-off** in Phase 1: 200 real messages per language, four candidates, native speakers rate them without knowing which is which.

| Candidate | Why it is in the bake-off | Per-message cost (est.) | 1,000 msgs/day |
|---|---|---|---|
| Claude Sonnet 5 | Best human-evaluated en→zh score in WMT25; zero-data-retention eligible; one SDK for everything | ~$0.0018 | ~$37/mo |
| Gemini 3.7 Flash | Led the social/chat subset for zh; top automatic scores for ko and id; cheapest frontier option (promo price to end 2026) | ~$0.0011 | ~$22/mo |
| GPT-5.x (Terra tier) | Top-cluster on ko/id; reputation for placeholder preservation | ~$0.0024 | ~$48/mo |
| Hy-MT2-7B via OpenRouter | Open weights, Apache-2.0, cost floor; must prove it handles short slang without over-translating | ~$0.0001 | ~$2/mo |

Cost assumes ~700 input tokens (600 of them a cached system prompt) and ~150 output tokens per message, with a third of messages never reaching the API. List prices as of 6 Sep 2026; several are promotional.

Default while the bake-off runs: **Claude Sonnet 5** (or Opus 5 if the zh sample shows a gap). Fallback chain on outage: primary → second-place model from the bake-off → mirror untranslated with a "translation pending" note, patched later. If Hy-MT2 wins or ties on the native-speaker ratings, it becomes the primary and a frontier model stays as fallback for messages it flags as low-confidence.

Privacy note: message content leaves Discord to a third-party API. Add a line to the server rules and the pinned notice. Anthropic Sonnet/Opus/Haiku and DeepL delete after processing on request; OpenAI keeps 30-day abuse logs unless zero-retention is approved; Gemini paid tier keeps 55 days.

## 7. Build phases

**Phase 0 — Setup (½ day)**
- Create the Discord application, enable the Message Content and Server Members privileged intents (no approval needed under 100 servers), invite the bot with Manage Webhooks, Manage Channels, Read/Send Messages, Manage Messages, Attach Files, Read Message History.
- Supabase: apply the schema above.
- Anthropic API key, Railway project, secrets set.
- Bot code lives in `bot/` in this repo (TypeScript, discord.js v14, `@anthropic-ai/sdk`, `@supabase/supabase-js`, Dockerfile). Railway deploys that directory; it can be split into its own repo later without changes.

**Phase 1 — Core mirror (2 to 3 days)**
- Gateway listener with per-source-channel FIFO queue.
- Placeholder tokenizer/detokenizer for all Discord entity types, with unit tests.
- Translation client behind a `TranslationProvider` interface (Anthropic, Gemini, OpenAI, OpenRouter adapters): structured output, cached prompt, glossary injection, skip heuristics, cache table.
- `bake-off` script: samples N real messages per source channel, translates with every configured provider, writes a blind rating sheet (provider names hidden, revealed by key) for native speakers.
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

## 9. Decisions

| Question | Decision |
|---|---|
| Chinese variant | **Simplified** (`zh`). Traditional can be added later as `zh-TW`. |
| Channels to mirror | Decided after a server snapshot. The channel manager in `bot/` (`npm run channels -- snapshot`) produces a per-channel activity report; the `channel-manager` Claude agent reads it and recommends a list. |
| Translation model | Decided by a blind bake-off in Phase 1 (section 6). Default while it runs: Claude Sonnet 5. |
| Language roles | **One per member.** Onboarding assigns exactly one; switching replaces it. No double pings. |
| Hosting | **Railway.** One service from the `bot/` directory (set Root Directory to `bot`), Dockerfile build, `DISCORD_TOKEN`, `DISCORD_GUILD_ID`, `ANTHROPIC_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` as service variables. |

## 10. Channel decisions (from the 6 Sep 2026 snapshot)

Server: BLKBöX Trading Floor, 704 members, every channel role-gated (hidden from @everyone).

| Channel | Decision |
|---|---|
| #💬・general, #📈・trader-chat, #☎️・help-desk | Mirror, two-way |
| #⚡・trade-alerts, #📢・announcements, #🟠・bitcoin | Mirror, read-only twins |
| #🔒・trade-alerts (teaser for unverified members) | Mirror, read-only twins, gated to unverified members of each language |
| #💹・bot-profits | Not now; dead channel, will be used later. Add when it goes live. |
| #🐸・memes | Skip in v1 |
| #👑・vip-chat | Later, if non-English VIPs appear |
| Forums, voice, tickets, logs, mod-chat, testimonials, beta-testing | Skip |
| #📍・start-here, setup-guides, trading-strategies | Translate once as static copies, not live mirrors |

Still pending: activity numbers from a rerun with the bot granted Administrator, to confirm volumes and cost.

Related: the old iTranslator bot is being removed so members never see double translations. Language roles must be granted only to members who already hold the Member role, since Discord cannot require two roles at once (Phase 3).

## 11. Channel manager (built)

Lives in `bot/` on this branch. It does two jobs before any mirroring code runs:

- `snapshot` writes a markdown report of every category and channel with visibility, roles, slowmode, and 30-day activity (messages per day, distinct human authors, bot messages, last message). This is the input for choosing which channels to mirror.
- `apply <layout.json> --dry-run` creates language roles, role-gated categories and twin channels from a JSON layout, idempotently and without ever deleting. `bot/layouts/languages.example.json` is the starting layout for zh, ko and id.

A Claude Code agent definition at `.claude/agents/channel-manager.md` runs these commands and produces the recommendation. It needs `DISCORD_TOKEN` and `DISCORD_GUILD_ID` in the environment.
