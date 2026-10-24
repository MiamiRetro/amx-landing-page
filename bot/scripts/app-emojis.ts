/**
 * Copies the server guide's custom emoji (BLKBöX logo, YouTube, X, exchange
 * logos) from the live server into this bot's own Discord application, so the
 * guide shows them in any server the bot is in. Idempotent: emoji the app
 * already has (by name) are skipped. The button logo (BLKglow) is uploaded
 * from assets/start-here/emoji.png; --refresh replaces the app's copy after
 * a new render.
 *
 *   railway run npx tsx scripts/app-emojis.ts
 *   railway run npx tsx scripts/app-emojis.ts --refresh
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "discord.js";
import { config } from "../src/config.js";
import { GUIDE_EMOJI } from "../src/startHere.js";

/** Emoji rendered in this repo rather than copied from the live server. */
const LOCAL: Record<string, string> = {
  BLKglow: join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "start-here", "emoji.png"),
};

async function main() {
  const client = new Client({ intents: [] });
  await client.login(config.discordToken());
  try {
    const app = await client.application!.fetch();
    const have = await app.emojis.fetch();
    const refresh = process.argv.includes("--refresh");
    for (const [name, id] of Object.entries(GUIDE_EMOJI)) {
      const own = have.find((e) => e.name === name);
      if (own && !(refresh && LOCAL[name])) { console.log(`have ${name}`); continue; }
      let attachment: Buffer;
      if (LOCAL[name]) attachment = readFileSync(LOCAL[name]);
      else {
        const res = await fetch(`https://cdn.discordapp.com/emojis/${id}.png?size=128`);
        if (!res.ok) { console.log(`! could not download ${name} (${res.status})`); continue; }
        attachment = Buffer.from(await res.arrayBuffer());
      }
      if (own) await own.delete();
      const made = await app.emojis.create({ attachment, name });
      console.log(`added ${name} → ${made.id}`);
    }
  } finally {
    await client.destroy();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });
