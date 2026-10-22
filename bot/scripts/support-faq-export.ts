/**
 * Prints the FAQ entries moderators added through the weekly review, ready to
 * paste into assets/support/faq.md so they are versioned with the code.
 *
 *   npx tsx scripts/support-faq-export.ts
 */
import { Db } from "../src/db/index.js";
import { config } from "../src/config.js";

const rows = await new Db().listSettings(config.guildId(), "support_faq:");
const entries = rows.map((r) => r.value).filter(Boolean);
console.log(entries.length ? entries.join("\n\n") : "(no entries added yet)");
