/**
 * Uploads the glowing BLKBöX mark as a server emoji so it can sit on buttons.
 *   npx tsx scripts/emoji.ts            # show whether it exists
 *   npx tsx scripts/emoji.ts --apply    # create or replace it
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "../src/lib/client.js";

const NAME = "BLKglow";
const FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "start-here", "emoji.png");

async function main() {
  const apply = process.argv.includes("--apply");
  const { client, guild } = await connect();
  try {
    const existing = (await guild.emojis.fetch()).find((e) => e.name === NAME);
    if (existing) console.log("exists:", `<:${existing.name}:${existing.id}>`);
    if (!apply) return console.log("dry run; pass --apply to create or replace it");
    if (existing) await existing.delete("replacing with a new render");
    const made = await guild.emojis.create({ attachment: readFileSync(FILE), name: NAME, reason: "start-here buttons" });
    console.log("created:", `<:${made.name}:${made.id}>`);
  } finally {
    await client.destroy();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });
