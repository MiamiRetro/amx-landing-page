/**
 * Hits an exchange's affiliate API with the configured credentials and prints
 * the raw answer. Use it to confirm an endpoint before trusting the flow.
 *
 *   npx tsx scripts/verify-probe.ts bybit 12345678
 *
 * A UID you know is one of your referrals should come back referred:true.
 * A random UID should come back referred:false rather than throwing.
 */
import "dotenv/config";
import { buildProviders } from "../src/verify/providers/index.js";
import { isExchange } from "../src/verify/types.js";

async function main() {
  const [exchange, uid] = process.argv.slice(2);
  if (!exchange || !isExchange(exchange) || !uid) throw new Error("usage: verify-probe.ts <bitget|blofin|bybit> <uid>");
  const provider = buildProviders().get(exchange);
  if (!provider) throw new Error(`${exchange} has no provider; set its API credentials`);
  console.log(`provider: ${provider.constructor.name} (configured: ${provider.configured()})`);
  const started = Date.now();
  try {
    console.log("result:", JSON.stringify(await provider.lookup(uid), null, 2), `in ${Date.now() - started}ms`);
  } catch (e) {
    console.error("threw:", e instanceof Error ? e.message : e);
    if (e && typeof e === "object" && "body" in e) console.error("body:", (e as { body?: string }).body);
    process.exitCode = 1;
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });
