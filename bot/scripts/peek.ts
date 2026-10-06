import type { TextChannel } from "discord.js";
import { connect } from "../src/lib/client.js";
async function main() {
  const [chanId, msgId] = process.argv.slice(2);
  const { client, guild } = await connect();
  try {
    const ch = (await guild.channels.fetch(chanId)) as TextChannel;
    const m = await ch.messages.fetch(msgId).catch(() => null);
    console.log(m ? { id: m.id, author: m.author.username, edited: m.editedTimestamp, content: m.content.slice(0, 200) } : "message gone");
  } finally { await client.destroy(); }
}
main();
