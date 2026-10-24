/**
 * Posts one card of the server guide (or the picker channel), in any server the bot is in and any language.
 *
 *   npx tsx scripts/post-card.ts --guild 1180210431126675576 --channel rules --card rules
 *   npx tsx scripts/post-card.ts --channel "🧭・服务器指南" --card all --lang zh
 *   npx tsx scripts/post-card.ts --channel "🌐・choose-language" --card language
 *
 * Cards: welcome, rules, start, community (the guide, translated with --lang) and terms, language (the picker).
 *
 * --guild defaults to DISCORD_GUILD_ID. Re-running replaces the bot's own
 * earlier messages in that channel, so it is safe to run repeatedly while
 * iterating on wording.
 */
import "dotenv/config";
import { ChannelType, Client, Events, GatewayIntentBits, type TextChannel } from "discord.js";
import { isLang, type Lang } from "../src/config.js";
import { startHereMessages, useAppEmojis } from "../src/startHere.js";

/** Cards in the order startHereMessages returns them: the server guide, then the picker channel's two. */
const GUIDE_CARDS = ["welcome", "rules", "start", "community"] as const;
const PICKER_CARDS = ["terms", "language"] as const;
const CARD_NAMES = [...GUIDE_CARDS, ...PICKER_CARDS];
type CardName = (typeof CARD_NAMES)[number];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : undefined;
}

async function main() {
  const guildId = arg("guild") ?? process.env.DISCORD_GUILD_ID;
  const channelName = arg("channel");
  const card = (arg("card") ?? "rules") as CardName | "all";
  const langArg = arg("lang") ?? "en";
  if (!isLang(langArg)) throw new Error(`--lang must be one of the bot's languages`);
  const lang: Lang = langArg;
  if (!guildId) throw new Error("set --guild or DISCORD_GUILD_ID");
  if (!channelName) throw new Error('pass --channel "<name>"');
  if (card !== "all" && !CARD_NAMES.includes(card)) throw new Error(`--card must be "all" or one of: ${CARD_NAMES.join(", ")}`);

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  await client.login(process.env.DISCORD_TOKEN);
  await new Promise((r) => client.once(Events.ClientReady, r));
  try {
    const guild = await client.guilds.fetch(guildId);
    await guild.channels.fetch();
    const me = guild.members.me ?? (await guild.members.fetchMe());
    const find = (n: string) =>
      guild.channels.cache.find(
        (c): c is TextChannel => (c?.type === ChannelType.GuildText || c?.type === ChannelType.GuildAnnouncement) && c.name === n,
      );
    const ch = find(channelName);
    if (!ch) throw new Error(`no channel "${channelName}" in ${guild.name}. Channels: ${guild.channels.cache.filter((c) => c?.type === ChannelType.GuildText).map((c) => c!.name).join(", ")}`);

    // The help-desk link has to resolve inside whichever server we are posting to.
    // Names can carry a tree prefix (┣☎️・help-desk), so match on the ending.
    const helpDesk = guild.channels.cache.find(
      (c): c is TextChannel => (c?.type === ChannelType.GuildText || c?.type === ChannelType.GuildAnnouncement) && /(^|・)help-desk$/.test(c.name),
    );
    const helpDeskUrl = helpDesk ? `https://discord.com/channels/${guild.id}/${helpDesk.id}` : `https://discord.com/channels/${guild.id}`;

    const old = (await ch.messages.fetch({ limit: 50 })).filter((m) => m.author.id === me.id);
    for (const m of old.values()) await m.delete().catch(() => {});

    // The guide's custom emoji come from this bot app's own copies, so they show whichever server it's in.
    useAppEmojis([...(await client.application!.emojis.fetch()).values()]);
    const picker = (PICKER_CARDS as readonly string[]).includes(card);
    const cards = startHereMessages({ helpDeskUrl, lang, picker });
    const names: readonly string[] = picker ? PICKER_CARDS : GUIDE_CARDS;
    const payloads = card === "all" ? cards : [cards[names.indexOf(card)]];
    for (const p of payloads) await ch.send(p);
    console.log(`posted ${payloads.length} card(s) in ${guild.name} #${ch.name}: https://discord.com/channels/${guild.id}/${ch.id}`);
    if (!helpDesk && card === "all") console.log("note: no help-desk channel here, so that button points at the server instead");
  } finally {
    await client.destroy();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
