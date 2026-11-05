/**
 * One-time Telegram login for the story watcher (Tone's stories -> Discord general).
 *
 * Run it on your own computer, signed in as the spare Telegram account:
 *
 *   cd bot && npm run tg:login
 *
 * It asks for the api_id and api_hash (from https://my.telegram.org > API
 * development tools, made while signed in as that account), then the phone
 * number, the login code Telegram sends, and the 2FA password if set.
 *
 * It prints one long session string. That string is the login itself: put it
 * in Railway as TELEGRAM_STORIES_SESSION (with TELEGRAM_STORIES_API_ID and
 * TELEGRAM_STORIES_API_HASH) and nowhere else. Run this once per server
 * (test and production each need their own session, or Telegram cuts both off).
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

const rl = createInterface({ input: stdin, output: stdout });
const ask = (q: string) => rl.question(q).then((a) => a.trim());

const apiId = Number(process.env.TELEGRAM_STORIES_API_ID || (await ask("api_id: ")));
const apiHash = process.env.TELEGRAM_STORIES_API_HASH || (await ask("api_hash: "));
const client = new TelegramClient(new StringSession(""), apiId, apiHash, { connectionRetries: 3 });
client.setLogLevel("error" as never);

await client.start({
  phoneNumber: () => ask("Phone number (with +country code): "),
  phoneCode: () => ask("Login code Telegram just sent you: "),
  password: () => ask("2FA password (blank if none): "),
  onError: (e) => console.error(String(e)),
});
const me = await client.getMe();
console.log(`\nLogged in as ${"username" in me && me.username ? `@${me.username}` : me.id}.`);
console.log("\nTELEGRAM_STORIES_SESSION (paste into Railway only, never into chat):\n");
console.log(client.session.save());
await client.disconnect();
rl.close();
process.exit(0);
