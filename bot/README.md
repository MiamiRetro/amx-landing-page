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
   `https://discord.com/oauth2/authorize?client_id=CLIENT_ID&scope=bot%20applications.commands&permissions=268707856`
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
