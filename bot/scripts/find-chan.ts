import { ChannelType } from "discord.js";
import { connect } from "../src/lib/client.js";
async function main() { const { client, guild } = await connect(); try { const ch = guild.channels.cache.find((c) => c.type === ChannelType.GuildText && c.name === process.argv[2]); console.log(ch?.id ?? ""); } finally { await client.destroy(); } }
main();
