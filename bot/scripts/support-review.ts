/**
 * Runs the help-desk weekly review once, outside the schedule.
 *
 *   npx tsx scripts/support-review.ts            # dry run: prints the summary and gaps, posts nothing
 *   npx tsx scripts/support-review.ts --post     # posts in the moderators' chat, as the weekly run would
 *
 * Replies to the posted gaps are handled by the running bot.
 */
import { Db } from "../src/db/index.js";
import { connect } from "../src/lib/client.js";
import { SupportReview } from "../src/support/review.js";

async function main() {
  const post = process.argv.includes("--post");
  const { client, guild } = await connect();
  try {
    await guild.channels.fetch();
    const review = new SupportReview(guild, new Db(), client.user!.id, null, () => false);
    const out = await review.run(Date.now(), { dryRun: !post });
    console.log(JSON.stringify(out, null, 2));
  } finally {
    await client.destroy();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });
