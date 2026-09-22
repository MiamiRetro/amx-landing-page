/**
 * Says which exchanges are really being checked and which are standing in.
 *   npx tsx scripts/verify-status.ts
 */
import "dotenv/config";
import { buildProviders } from "../src/verify/providers/index.js";
import { EXCHANGES, EXCHANGE_LABELS } from "../src/verify/types.js";

const NEEDED: Record<string, string[]> = {
  bybit: ["BYBIT_API_KEY", "BYBIT_API_SECRET"],
  bitget: ["BITGET_API_KEY", "BITGET_API_SECRET", "BITGET_API_PASSPHRASE"],
  blofin: ["BLOFIN_API_KEY", "BLOFIN_API_SECRET", "BLOFIN_API_PASSPHRASE"],
};

const providers = buildProviders();
let live = 0;
for (const id of EXCHANGES) {
  const p = providers.get(id);
  const missing = NEEDED[id].filter((n) => !(process.env[n] ?? "").trim());
  if (p?.live) {
    live++;
    console.log(`${EXCHANGE_LABELS[id].padEnd(7)} live     checking against the exchange`);
  } else {
    console.log(`${EXCHANGE_LABELS[id].padEnd(7)} stand-in missing ${missing.join(", ")}`);
  }
}
console.log(`\n${live} of ${EXCHANGES.length} exchanges are verifying for real.`);
if (live < EXCHANGES.length) console.log("Members picking a stand-in exchange are told checks are not switched on, not that their UID is wrong.");
