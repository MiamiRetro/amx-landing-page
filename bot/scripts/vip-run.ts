/**
 * The weekly VIP check, run outside the bot (the Mac Studio's launchd job
 * com.lloyde.blkbox-vip-weekly), because Bybit refuses the bot's hosting region.
 *
 *   railway run npx tsx scripts/vip-run.ts             # store snapshots, set roles, post the report
 *   railway run npx tsx scripts/vip-run.ts --preview   # compute only
 */
import { Db } from "../src/db/index.js";
import { connect } from "../src/lib/client.js";
import { buildProviders } from "../src/verify/providers/index.js";
import { VipTracker } from "../src/vip/tracker.js";

async function main() {
  const preview = process.argv.includes("--preview");
  const { client, guild } = await connect();
  try {
    const rows = await new VipTracker(guild, new Db(), buildProviders()).run({ apply: !preview });
    const total = rows.reduce((a, r) => a + r.usd, 0);
    console.log(`${new Date().toISOString()} ${guild.name}: ${preview ? "preview" : "applied"}, ${rows.length} linked members, $${total.toFixed(2)} in 30 days, ${rows.filter((r) => r.tier).length} VIP, ${rows.filter((r) => r.errors.length).length} with errors`);
    for (const r of rows.filter((r) => r.errors.length)) console.log("  error", r.userId, r.errors.join("; "));
  } finally {
    await client.destroy();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });
