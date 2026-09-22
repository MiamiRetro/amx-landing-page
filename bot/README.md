# amx-mirror-bot

Discord multilingual mirror bot for the AlphanumetriX / BLKBöX community. Design: [`../docs/discord-mirror-bot-plan.md`](../docs/discord-mirror-bot-plan.md).

Every channel in a *group* (one per language) is mirrored into the others: a message posted in `#general` shows up in `#general-zh`, `#general-ko` and `#general-id` under the author's name and avatar, translated, with mentions, links, emoji, attachments, replies, edits and deletes carried across.

## Layout

| Path | What |
|---|---|
| `src/index.ts` | Bot runtime: gateway events → mirror, slash commands, `/health` endpoint |
| `src/mirror/` | Placeholder tokenizer, per-channel FIFO queue, webhook identity, entity remapping, the mirror orchestrator |
| `src/translate/` | Provider interface, Claude adapter, OpenAI-compatible adapter (OpenAI, Gemini, OpenRouter), cache + validation + fallback |
| `src/commands/` | `/mirror …` and `/glossary …` |
| `src/db/` | Supabase client and `schema.sql` |
| `src/channel-manager.ts` | Server snapshot and layout apply (see below) |
| `src/bakeoff.ts` | Blind translation-quality test across providers |
| `test/` | Unit tests (`npm test`) |

## Setup

### 1. Discord application
1. <https://discord.com/developers/applications> → your app → **Bot**: enable **Server Members Intent** and **Message Content Intent**.
2. Invite with (replace `CLIENT_ID`):
   `https://discord.com/oauth2/authorize?client_id=CLIENT_ID&scope=bot%20applications.commands&permissions=805563408`
3. Because every channel on the server is role-gated, give the bot's role **Administrator** (Server Settings → Roles → the bot's role) or add it to every role that can see the channels you mirror.

### 2. Supabase
Create a project (or reuse one), open the SQL editor, paste `src/db/schema.sql`, run it. Copy the project URL and the **service role** key from Settings → API.

### 3. Environment
`cp .env.example .env` and fill it in. Keys:

| Variable | Purpose |
|---|---|
| `DISCORD_TOKEN`, `DISCORD_GUILD_ID` | Bot token and server ID |
| `OPS_USER_IDS` | Accounts that must see every language channel regardless of role |
| `TRANSLATION_PROVIDER` | `anthropic:claude-sonnet-5` (default), or `gemini:<model>`, `openai:<model>`, `openrouter:<model>` |
| `TRANSLATION_FALLBACKS` | Comma-separated providers tried when the primary fails |
| `ANTHROPIC_API_KEY` etc. | Key for each provider you use |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Storage |

### 4. Run locally
```sh
npm install
npm test
npm run dev
```

### 5. Deploy on Railway
New project → Deploy from GitHub → this repo. In the service settings set **Root Directory** to `bot`. Railway picks up `railway.json` (Dockerfile build, `/health` check, restart on failure). Add every variable from `.env.example` under Variables. One replica only; the bot must never run twice against the same server.

## Operating it

Slash commands (Administrator only):

| Command | Does |
|---|---|
| `/mirror category lang:zh category:#中文 role:@中文` | Where twins for a language are created and who may see them (once per language) |
| `/mirror create source:#general name:general` | Creates `general-zh/ko/id` in those categories and starts mirroring. `readonly:true` for alerts and announcements |
| `/mirror link channel lang group` | Adds an existing channel to a group |
| `/mirror unlink channel` | Stops mirroring that channel |
| `/mirror status` | Groups, queue depth, translation usage in the last 24h |
| `/mirror pause` · `resume` | Kill switch |
| `/glossary add term note` · `remove` · `list` | Terms never translated (brand names, slang to keep) |

Webhooks are created on first use, one per channel, named "AMX Mirror". Deleting a webhook in Discord is safe; the bot recreates it.

## Behaviour notes
- Webhook posts show a small `APP` tag next to the author's name. Discord does not allow removing it.
- Replies become a quoted header with a jump link to the mirrored parent; polls and forwards are rendered as text.
- Deleting an original deletes its mirrors. Deleting a mirror deletes the original and the other mirrors.
- A message whose translation fails everywhere is mirrored untranslated with a small "translation pending" note.
- On startup the bot mirrors anything posted since its last seen message per channel (`BACKFILL_LIMIT`).

## Channel manager
```sh
npm run channels -- snapshot --days 30          # activity report → snapshots/
npm run channels -- roles
npm run channels -- apply layouts/languages.example.json --dry-run
```
`apply` creates roles, categories and channels from a layout and never deletes. Accounts in `OPS_USER_IDS` get view access on every gated category it creates.

## Translation bake-off
```sh
npm run bakeoff -- run --channel <id> --count 200 \
  --providers anthropic:claude-sonnet-5,gemini:gemini-3.7-flash,openai:gpt-5.6-terra,openrouter:tencent/hy-mt2-7b
```
Writes `bakeoff/<date>/sheet-<lang>.md` (translations shuffled and lettered per row) and `ratings-<lang>.csv` for native speakers. Keep `key.json` away from raters. Then `npm run bakeoff -- score bakeoff/<date>` prints the average per provider and language.

## UID verification

A member presses **Verify my UID**, picks their exchange and pastes the UID in
one popup. The bot asks that exchange's affiliate API whether the UID registered
under our link, and grants the membership role if it did.

### Switching it on

Until an exchange has API credentials it runs a stand-in that cannot check
anything. Members who pick it are told checks are not switched on rather than
being told their UID is wrong, so a good UID is never treated as a bad one.

Check which exchanges are real:

```
npm run verify:status
```

Create one API key per exchange, from the account that owns the affiliate
programme, with the read or affiliate permission only. Never a trading or
withdrawal permission: this key only ever answers questions.

| Exchange | Where | Notes |
|---|---|---|
| Bybit | affiliates.bybit.com, then Account Settings → API Management on the desktop site | Must be the master UID, and tick **Affiliate** as the only permission |
| Bitget | Partner/agent portal → API Key Management | Needs the agent or broker permission, and sets a passphrase |
| Blofin | Profile → API Management | **Read** permission is enough, and sets a passphrase |

Put them in Railway, which redeploys on save:

```
BYBIT_API_KEY, BYBIT_API_SECRET
BITGET_API_KEY, BITGET_API_SECRET, BITGET_API_PASSPHRASE
BLOFIN_API_KEY, BLOFIN_API_SECRET, BLOFIN_API_PASSPHRASE
```

If an exchange asks for an IP allowlist, Railway egress IPs are not fixed on the
hobby plans, so leave it open or use a static egress.

### Confirming an exchange really answers

```
npm run verify:probe -- bybit 6526315384
```

Run it once with a UID you know is one of your referrals, which must come back
`referred: true`, and once with a random UID, which must come back
`referred: false` rather than throwing. If it throws, the endpoint or the
permission is wrong; override the path without touching code:

```
BYBIT_AFFILIATE_PATH, BITGET_AFFILIATE_PATH, BLOFIN_AFFILIATE_PATH
```

### The verify channel disappears once you are in

```
npm run verify:channel -- --channel "<name>"
```

Discord applies every role deny, then every role allow. Allowing view on
@everyone and denying it on the membership role means arrivals see the channel
and verified members do not, with no per-member overwrites and nothing for the
bot to tidy up afterwards. Do not allow view on any other role there, because a
role allow beats the deny.

### Rules the flow enforces

- Someone who already holds the membership role is turned away before any API call.
- One UID belongs to one Discord account, so a verified UID cannot be passed around.
- Five attempts per member per fifteen minutes, so UIDs cannot be guessed at.
- An exchange outage is reported as an outage, never as a rejection.
