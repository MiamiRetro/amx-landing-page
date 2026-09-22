/**
 * Sets the bot's own username and avatar (the identity shown on messages the bot
 * posts itself, such as the start-here page). Webhook mirrors are unaffected:
 * those carry the original author's name and avatar.
 *
 *   npx tsx scripts/identity.ts            # show the current identity
 *   npx tsx scripts/identity.ts --apply    # set name to BLKBöX and the glowing avatar
 *
 * Discord rate-limits bot username changes to two per hour.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "../src/lib/client.js";

const NAME = "BLKBöX";
const AVATAR = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "start-here", "avatar.png");

async function main() {
  const apply = process.argv.includes("--apply");
  const { client } = await connect();
  try {
    const me = client.user;
    console.log("current:", { username: me.username, discriminator: me.discriminator, avatar: me.avatarURL() });
    if (!apply) return console.log("dry run; pass --apply to change it");

    if (me.username !== NAME) {
      await me.setUsername(NAME);
      console.log("username ->", NAME);
    }
    await me.setAvatar(readFileSync(AVATAR));
    console.log("avatar ->", AVATAR);
    console.log("now:", { username: client.user.username, avatar: client.user.avatarURL() });
  } finally {
    await client.destroy();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });
