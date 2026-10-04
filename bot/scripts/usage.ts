import { Db } from "../src/db/index.js";
async function main() {
  const db = new Db();
  const { data, error } = await db.sb.from("usage_log").select("provider,ok,at,input_tokens,cached_tokens,cache_creation_tokens,output_tokens,ms").order("at", { ascending: false }).limit(200);
  if (error) throw new Error(error.message);
  const byProv: Record<string, { n: number; ok: number; inp: number; cached: number; write: number; out: number; ms: number; first: string; last: string }> = {};
  for (const r of data) {
    const b = (byProv[r.provider] ??= { n: 0, ok: 0, inp: 0, cached: 0, write: 0, out: 0, ms: 0, first: r.at, last: r.at });
    b.n++; if (r.ok) b.ok++; b.inp += r.input_tokens; b.cached += r.cached_tokens; b.write += r.cache_creation_tokens; b.out += r.output_tokens; b.ms += r.ms; b.first = r.at;
  }
  for (const [p, b] of Object.entries(byProv)) {
    // Billed input, in base-input-token equivalents: cache writes cost 1.25x, cache reads 0.1x.
    const total = b.inp + b.cached + b.write;
    const billed = Math.round(b.inp + b.write * 1.25 + b.cached * 0.1);
    console.log(
      `${p}: ${b.n} calls (${b.ok} ok), avg ${Math.round(b.ms / b.n)} ms, in ${total} (fresh ${b.inp}, cache read ${b.cached}, cache write ${b.write}; ≈${billed} billed), out ${b.out}, ${b.first.slice(0, 16)} → ${b.last.slice(0, 16)}`,
    );
  }
  const groups = await db.loadGroups(process.env.DISCORD_GUILD_ID!);
  console.log("groups:", groups.map((g) => `${g.name}(${g.members.length})`).join(", "));
}
main().catch((e) => { console.error(e.message); process.exit(1); });
