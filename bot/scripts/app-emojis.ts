/**
 * Copies the server guide's custom emoji (BLKBöX logo, YouTube, X, exchange
 * logos) from the live server into this bot's own Discord application, so the
 * guide shows them in any server the bot is in. Idempotent: emoji the app
 * already has (by name) are skipped.
 *
 *   railway run npx tsx scripts/app-emojis.ts
 */
import { Client } from "discord.js";
import { config } from "../src/config.js";
import { GUIDE_EMOJI } from "../src/startHere.js";

async function main() {
  const client = new Client({ intents: [] });
  await client.login(config.discordToken());
  try {
    const app = await client.application!.fetch();
    const have = await app.emojis.fetch();
    for (const [name, id] of Object.entries(GUIDE_EMOJI)) {
      if (have.some((e) => e.name === name)) { console.log(`have ${name}`); continue; }
      const res = await fetch(`https://cdn.discordapp.com/emojis/${id}.png?size=128`);
      if (!res.ok) { console.log(`! could not download ${name} (${res.status})`); continue; }
      const made = await app.emojis.create({ attachment: Buffer.from(await res.arrayBuffer()), name });
      console.log(`added ${name} → ${made.id}`);
    }
  } finally {
    await client.destroy();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });
