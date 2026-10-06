import { connect } from "../src/lib/client.js";
import { opsUserIds } from "../src/lib/layout.js";
async function main() {
  const { client, guild } = await connect();
  try {
    for (const id of opsUserIds()) {
      const m = await guild.members.fetch(id).catch(() => null);
      console.log(m ? `${m.user.username}: roles = ${m.roles.cache.filter((r) => r.id !== guild.id).map((r) => r.name).join(", ") || "(none)"}` : `${id}: not in server`);
    }
  } finally { await client.destroy(); }
}
main();
