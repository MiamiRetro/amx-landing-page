# amx-mirror-bot

Discord multilingual mirror bot for the AlphanumetriX community. Design: [`../docs/discord-mirror-bot-plan.md`](../docs/discord-mirror-bot-plan.md).

Status: **channel manager only**. The mirroring runtime lands in Phase 1.

## Channel manager

Takes a snapshot of the server (categories, channels, visibility, roles, 30-day activity) so we can decide which channels to mirror, and applies a language-category layout idempotently.

### One-time setup

1. Create an application at <https://discord.com/developers/applications>, add a Bot, copy its token.
2. Under **Bot → Privileged Gateway Intents** enable **Server Members Intent** (needed for role member counts). Message Content is not needed for the channel manager.
3. Invite it with this scope/permission set (replace `CLIENT_ID`):

   ```
   https://discord.com/oauth2/authorize?client_id=CLIENT_ID&scope=bot%20applications.commands&permissions=268707856
   ```

   That number is Manage Roles, Manage Channels, Manage Webhooks, View Channels, Send Messages, Manage Messages, Attach Files, Read Message History.
4. In Discord, enable Developer Mode (Settings → Advanced), right-click the server icon → **Copy Server ID**.
5. `cp .env.example .env` and fill in both values. `.env` is gitignored.

### Use

```sh
cd bot
npm install
npm run channels -- snapshot --days 30      # writes snapshots/<server>-<date>.md and .json
npm run channels -- roles                   # member count per role
npm run channels -- apply layouts/languages.example.json --dry-run
```

`snapshot` walks message history backwards per channel (up to `--scan 2000` messages) to count messages per day, distinct human authors and bot messages inside the window. On a large server this takes a minute or two because of Discord rate limits.

`apply` creates roles, categories and channels from a JSON layout and sets view permissions so a language category is visible only to its role. It never deletes anything. Re-running it is safe.

### Running it from a Claude Code session

Set `DISCORD_TOKEN` and `DISCORD_GUILD_ID` as environment variables on the Claude Code environment (Settings → Environments → Environment variables), then ask for the `channel-manager` agent. It runs the snapshot, reads the report and recommends which channels to mirror.
