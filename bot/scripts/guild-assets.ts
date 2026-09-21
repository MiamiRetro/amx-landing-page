import { connect } from "../src/lib/client.js";
async function main() { const { client, guild } = await connect(); try { console.log("icon:", guild.iconURL({ extension: "png", size: 512 })); console.log("banner:", guild.bannerURL({ extension: "png", size: 1024 })); console.log("splash:", guild.splashURL({ extension: "png", size: 1024 })); console.log("emoji:", guild.emojis.cache.map((e) => `${e.name}:${e.id}`).join(", ")); } finally { await client.destroy(); } }
main();
