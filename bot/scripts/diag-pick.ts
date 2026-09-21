import { PermissionFlagsBits } from "discord.js";
import { Db } from "../src/db/index.js";
import { connect } from "../src/lib/client.js";
import { opsUserIds } from "../src/lib/layout.js";
async function main() {
  const { client, guild } = await connect();
  const db = new Db();
  try {
    const me = guild.members.me ?? (await guild.members.fetchMe());
    console.log("bot top role:", me.roles.highest.name, "position", me.roles.highest.position, "| ManageRoles:", me.permissions.has(PermissionFlagsBits.ManageRoles));
    for (const n of ["中文", "한국어", "Bahasa Indonesia"]) { const r = guild.roles.cache.find((x) => x.name === n)!; console.log(`role ${n}: position ${r.position}, id ${r.id}, setting role:? ${await db.getSetting(guild.id, n === "中文" ? "role:zh" : n === "한국어" ? "role:ko" : "role:id")}`); }
    for (const id of opsUserIds()) {
      const m = await guild.members.fetch(id);
      console.log(`ops ${m.user.username}: pref=${await db.getLangPref(guild.id, id)} roles=${m.roles.cache.filter((r) => /中文|한국어|Bahasa/.test(r.name)).map((r) => r.name).join(",") || "(no language role)"}`);
    }
    const { data } = await db.sb.from("language_prefs").select("*").order("updated_at", { ascending: false }).limit(5);
    console.log("recent prefs:", JSON.stringify(data));
  } finally { await client.destroy(); }
}
main();
