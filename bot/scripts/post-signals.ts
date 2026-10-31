/**
 * Posts the AlphanumetriX signal history to every language's alphanumetrix
 * channel: the explainer with the timeline, one card per signal, and the
 * current 3-light board (pinned). Each post is an embed in the channel's own
 * language around a language-free infographic from assets/signals/out
 * (render with `node assets/signals/render.mjs`).
 *
 * It posts through the mirror's own "AMX Mirror" webhooks (src/signals/feed.ts),
 * so the mirror does not translate the posts a second time. Re-running
 * replaces the earlier set.
 *
 *   railway run --environment test npx tsx scripts/post-signals.ts --guild 1180210431126675576
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, GatewayIntentBits, type APIEmbed, type TextChannel } from "discord.js";
import { config } from "../src/config.js";
import { Db } from "../src/db/index.js";
import { Translator, providerFromSpec } from "../src/translate/index.js";
import { SignalPoster } from "../src/signals/feed.js";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "..", "assets", "signals", "out");
/** The poster's picture when the server has none recorded yet (signals:avatar). */
const AVATAR = "https://cdn.discordapp.com/avatars/1563549043454644264/65520ed36f41f49b975644f757ebaead.png?size=256";
const FOOTER = "Past signals don't guarantee future results · Not financial advice";
/** blkbox.tradingview_signal_events id of signal #7, the newest one shown. */
const LAST_ID = 7;
const GREEN = 0x22c55e, RED = 0xef4444, CYAN = 0x22d3ee;
const t = (d: string) => `<t:${Math.floor(Date.parse(d + "T00:00:00Z") / 1000)}:D>`;

interface Post { file: string; embed: APIEmbed }
const model = (icon: string, label: string, n: number) => `${icon} ${label} · ${n}/3`;
const history = "-# From the dashboard's history. No alert price was recorded, so this is BTC's daily close.";
const signal = (n: number, bull: boolean, name: string, when: string, date: string, price: string, text: string, m: string): Post => ({
  file: `signal-${n}.png`,
  embed: {
    color: bull ? GREEN : RED,
    title: `${bull ? "🟢" : "🔴"} #${n} · ${name} flipped ${bull ? "bullish" : "bearish"}`,
    description: text,
    fields: [
      { name: when === "fired" ? "📅 Fired" : "📅 Confirmed", value: t(date), inline: true },
      { name: "💰 BTC", value: price, inline: true },
      { name: "🚦 Model", value: m, inline: true },
    ],
    footer: { text: FOOTER },
  },
});

const POSTS: Post[] = [
  { file: "timeline.png", embed: { color: CYAN, title: "🚦 The AlphanumetriX 3-light system",
    description: "Our flagship BTC model reads three signals. Each one is a light, 🟢 bullish or 🔴 bearish, and the more lights agree, the stronger the trend.\n\n" +
      "💎 **Weekly Diamond**: the big-picture signal. It fires about once per market cycle, and every time it has fired so far, it has marked the cycle bottom.\n" +
      "📈 **3-Day Cross**: a crossover on the 3-day chart that confirms the medium-term trend.\n" +
      "🌊 **Wave Flip**: fires when the AlphanumetriX wave changes direction, usually the first of the three to react.",
    fields: [
      { name: "🚦 Reading the lights", value: "🔴🔴 0/3 · Strong Bear Trend\n🔴🟡 1/3 · Leaning Bearish\n🟡🟢 2/3 · Leaning Bullish\n🟢🟢 3/3 · Strong Bull Trend" },
      { name: "📈 Reading the chart", value: "The line is BTC's daily close. Each tag is a signal flip (▲ bullish, ▼ bearish), and the colored band underneath is the model's reading at the time. Every signal on record follows below, oldest first." },
    ],
    footer: { text: FOOTER } } },
  signal(1, true, "Weekly Diamond", "fired", "2026-02-09", "~$70,138", `${history}\nThe big-picture signal turns bullish first. The Weekly Diamond fires about once per market cycle, and every time it has fired so far, it has marked the cycle bottom. The faster two have no signal on record yet, so the trend has turned but isn't confirmed.`, model("🔴🟡", "Leaning Bearish", 1)),
  signal(2, true, "Wave Flip", "fired", "2026-04-13", "~$74,418", `${history}\nWave Flip joins the Weekly Diamond. Two of three agree, which is already a strong bull signal.`, model("🟡🟢", "Leaning Bullish", 2)),
  signal(3, true, "3-Day Cross", "fired", "2026-04-19", "~$73,802", `${history}\nFull alignment: all three lights are green, the strategy's strongest posture. BTC went on to about $82.2k by May 10.`, model("🟢🟢", "Strong Bull Trend", 3)),
  signal(4, false, "Wave Flip", "confirmed", "2026-06-03", "$66,673.66", "The first crack. BTC had slid about 19% from its May high, and Wave Flip turns red. Two of three are still green, so the trend is still positive but weakening.", model("🟡🟢", "Leaning Bullish", 2)),
  signal(5, false, "3-Day Cross", "confirmed", "2026-06-06", "$61,060.24", "3-Day Cross follows Wave Flip down, and only the Weekly Diamond is still green. Sellers have the edge: BTC bottomed near $58.6k on Jun 30 and stayed under $67k until mid-August.", model("🔴🟡", "Leaning Bearish", 1)),
  signal(6, true, "Wave Flip", "confirmed", "2026-08-21", "$73,010.81", "The first bullish flip since June, with BTC about 19.6% above the June bearish cross. Two of three are green again.", model("🟡🟢", "Leaning Bullish", 2)),
  signal(7, true, "3-Day Cross", "confirmed", "2026-08-23", "$77,088.42", "Full alignment again: all three lights are green. Since then BTC has traded as high as $86.6k (Sep 21). The risk to watch is any one light turning red.", model("🟢🟢", "Strong Bull Trend", 3)),
  { file: "board.png", embed: { color: GREEN, title: "🚦 Where the model stands now",
    description: `🟢 💎 **Weekly Diamond**: bullish since ${t("2026-02-09")}\n🟢 📈 **3-Day Cross**: bullish since ${t("2026-08-23")}\n🟢 🌊 **Wave Flip**: bullish since ${t("2026-08-21")}\n\n` +
      "**3 of 3 bullish → 🟢🟢 Strong Bull Trend.** Historically, trend continuation has been the high-probability outcome from this setup.",
    fields: [{ name: "📊 Live model", value: "https://dash.blkbox.pro" }],
    footer: { text: FOOTER } } },
];

async function main() {
  const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
  const guildId = arg("guild") ?? config.guildId();
  const db = new Db();
  const translator = new Translator({ primary: providerFromSpec(config.translationProvider()), fallbacks: config.translationFallbacks().map(providerFromSpec), db, timeoutMs: 120_000 });
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  await client.login(config.discordToken());
  try {
    const guild = await client.guilds.fetch(guildId);
    const poster = new SignalPoster(guild, db, translator);
    if (!(await db.getSetting(guildId, "signals:avatar"))) await poster.setAvatar(AVATAR);
    const targets = await poster.targets();
    console.log("channels:", targets.map((t) => `${t.lang} ${t.channelId}`).join(", "));

    // Replace the earlier set: everything the AlphanumetriX poster sent in these channels, and pin notices.
    for (const t of targets) {
      const ch = (await guild.channels.fetch(t.channelId)) as TextChannel;
      const old = (await ch.messages.fetch({ limit: 50 })).filter((m) => (!!m.webhookId && m.author.username === "AlphanumetriX") || m.type === 6);
      for (const m of old.values()) await m.delete().catch(() => {});
    }

    for (const p of POSTS) {
      const image = readFileSync(join(OUT, p.file));
      if (p.file === "board.png") await poster.postBoard(p.embed, image, targets);
      else await poster.post(p.embed, image, p.file, targets);
      console.log("posted", p.file);
    }
    // The feed (src/signals/feed.ts) posts what arrives after the newest signal shown here.
    await db.setSetting(guildId, "signals:last_id", String(LAST_ID));
    console.log(`done: https://discord.com/channels/${guildId}/${targets[0].channelId}`);
  } finally {
    await client.destroy();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });
