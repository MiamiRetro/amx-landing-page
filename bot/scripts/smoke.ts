import { Db } from "../src/db/index.js";
async function main() {
  const db = new Db();
  const g = process.env.DISCORD_GUILD_ID as string;
  console.log("groups:", (await db.loadGroups(g)).length);
  await db.setSetting(g, "smoke", new Date().toISOString());
  console.log("write+read ok:", await db.getSetting(g, "smoke"));
  await db.cachePut([{ hash: "test", lang: "zh", text: "测试", provider: "smoke" }]);
  console.log("cache ok:", [...(await db.cacheGet(["test"], "zh")).values()]);
}
main().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
