/**
 * Makes a one-time link that connects a concierge host's Google Calendar
 * (free/busy only). Send it to the host: they open it, sign in, press Allow.
 *
 *   railway run -e test -- npx tsx scripts/calendar-link.ts --host matt
 */
import { config } from "../src/config.js";
import { createLink } from "../src/calendar/google.js";
import { Db } from "../src/db/index.js";

const i = process.argv.indexOf("--host");
const host = i >= 0 ? process.argv[i + 1] : undefined;
if (!host) throw new Error("usage: calendar-link.ts --host <jt|matt>");
console.log(await createLink(new Db(), config.guildId(), host));
