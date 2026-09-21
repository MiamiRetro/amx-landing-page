import { Db } from "../src/db/index.js";
async function main() {
  const db = new Db();
  const { data, error } = await db.sb.from("usage_log").select("at,ok,input_tokens,cached_tokens,output_tokens,segments,ms").eq("provider", "anthropic:claude-sonnet-5").order("at", { ascending: true });
  if (error) throw new Error(error.message);
  for (const r of data) console.log(`${r.at.slice(5, 19)} ${r.ok ? "ok  " : "FAIL"} seg=${r.segments} in=${r.input_tokens} cached=${r.cached_tokens} out=${r.output_tokens} ${r.ms}ms`);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
