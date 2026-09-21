import { Db } from "../src/db/index.js";
async function main() {
  const db = new Db();
  const { data, error } = await db.sb.from("usage_log").select("provider,ok,at,input_tokens,cached_tokens,output_tokens,ms").order("at", { ascending: false }).limit(200);
  if (error) throw new Error(error.message);
  const byProv: Record<string, { n: number; ok: number; inp: number; cached: number; out: number; ms: number; first: string; last: string }> = {};
  for (const r of data) {
    const b = (byProv[r.provider] ??= { n: 0, ok: 0, inp: 0, cached: 0, out: 0, ms: 0, first: r.at, last: r.at });
    b.n++; if (r.ok) b.ok++; b.inp += r.input_tokens; b.cached += r.cached_tokens; b.out += r.output_tokens; b.ms += r.ms; b.first = r.at;
  }
  for (const [p, b] of Object.entries(byProv)) console.log(`${p}: ${b.n} calls (${b.ok} ok), avg ${Math.round(b.ms / b.n)} ms, in ${b.inp} (cached ${b.cached}), out ${b.out}, ${b.first.slice(0, 16)} → ${b.last.slice(0, 16)}`);
  const groups = await db.loadGroups(process.env.DISCORD_GUILD_ID!);
  console.log("groups:", groups.map((g) => `${g.name}(${g.members.length})`).join(", "));
}
main().catch((e) => { console.error(e.message); process.exit(1); });
