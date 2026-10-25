/**
 * Posts the AlphanumetriX signal history to every language's alphanumetrix
 * channel: the explainer with the timeline, one card per signal, and the
 * current 3-light board (pinned). Each post is an embed in the channel's own
 * language around a language-free infographic from assets/signals/out
 * (render with `node assets/signals/render.mjs`).
 *
 * It posts through the mirror's own "AMX Mirror" webhooks, so the mirror does
 * not translate the posts a second time. Re-running replaces the earlier set.
 *
 *   railway run --environment test npx tsx scripts/post-signals.ts --guild 1180210431126675576
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, GatewayIntentBits, WebhookClient, type APIEmbed, type TextChannel } from "discord.js";
import { config, type Lang } from "../src/config.js";
import { Db } from "../src/db/index.js";
import { Translator, providerFromSpec } from "../src/translate/index.js";
import { tokenize, detokenize } from "../src/mirror/placeholders.js";
import { WEBHOOK_NAME } from "../src/mirror/webhooks.js";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "..", "assets", "signals", "out");
const GROUP = "alphanumetrix";
const AVATAR = "https://cdn.discordapp.com/avatars/1563549043454644264/{hash}.png?size=256";
const FOOTER = "Past signals don't guarantee future results · Not financial advice";
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

/** The translatable strings of an embed, in a fixed order, and the way back. */
function strings(e: APIEmbed): string[] {
  return [e.title!, e.description!, ...(e.fields ?? []).flatMap((f) => [f.name, f.value]), e.footer!.text];
}
function rebuild(e: APIEmbed, s: string[]): APIEmbed {
  let i = 2;
  return { ...e, title: s[0], description: s[1], fields: e.fields?.map((f) => ({ ...f, name: s[i++], value: s[i++] })), footer: { text: s[i] } };
}

async function main() {
  const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
  const guildId = arg("guild") ?? config.guildId();
  const db = new Db();
  const group = (await db.loadGroups(guildId)).find((g) => g.name === GROUP);
  if (!group) throw new Error(`no ${GROUP} mirror group in ${guildId}`);
  const src = group.members.find((m) => m.lang === "en")!;
  const targets = group.members.filter((m) => m.lang !== "en");

  const translator = new Translator({ primary: providerFromSpec(config.translationProvider()), fallbacks: config.translationFallbacks().map(providerFromSpec), db, timeoutMs: 120_000 });
  const glossary = await db.glossary(guildId);
  const langs = targets.map((m) => m.lang as Lang);
  const localized = new Map<Lang, APIEmbed[]>([["en" as Lang, POSTS.map((p) => p.embed)]]);
  for (const l of langs) localized.set(l, []);
  for (const p of POSTS) {
    const tok = strings(p.embed).map(tokenize);
    // One language per call: all nine at once overflows the provider's output for the longer cards.
    for (const l of langs) {
      const r = await translator.translate(tok.map((x) => x.text), tok.map((x) => x.entities), "en" as Lang, [l], glossary);
      if (!r.translated) throw new Error(`translation incomplete for ${p.file} (${l})`);
      localized.get(l)!.push(rebuild(p.embed, r.translations[l].map((s, i) => detokenize(s, tok[i].entities))));
    }
    console.log("translated", p.file);
  }

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  await client.login(config.discordToken());
  try {
    const guild = await client.guilds.fetch(guildId);
    const poster = await client.fetchWebhook("1563549043454644264");
    const avatarURL = AVATAR.replace("{hash}", poster.avatar ?? "");
    // The English channel has no mirror webhook; one named like the mirror's own is skipped by it.
    const enChannel = (await guild.channels.fetch(src.channel_id)) as TextChannel;
    const enHook = (await enChannel.fetchWebhooks()).find((w) => w.name === WEBHOOK_NAME && w.owner?.id === client.user!.id)
      ?? (await enChannel.createWebhook({ name: WEBHOOK_NAME, reason: "signal history" }));
    const hooks = new Map<string, { channelId: string; hook: WebhookClient }>();
    hooks.set("en", { channelId: src.channel_id, hook: new WebhookClient({ id: enHook.id, token: enHook.token! }) });
    for (const m of targets) hooks.set(m.lang, { channelId: m.channel_id, hook: new WebhookClient({ id: m.webhook_id!, token: m.webhook_token! }) });

    // Replace the earlier set: everything these posters sent in these channels.
    const ours = new Set([poster.id, enHook.id, ...targets.map((m) => m.webhook_id!)]);
    for (const [, { channelId }] of hooks) {
      const ch = (await guild.channels.fetch(channelId)) as TextChannel;
      const old = (await ch.messages.fetch({ limit: 50 })).filter((m) => (m.webhookId && ours.has(m.webhookId)) || m.type === 6);
      for (const m of old.values()) await m.delete().catch(() => {});
    }

    for (let i = 0; i < POSTS.length; i++) {
      for (const [lang, { channelId, hook }] of hooks) {
        const embed = { ...localized.get(lang as Lang)![i], image: { url: `attachment://${POSTS[i].file}` } };
        const msg = await hook.send({ username: "AlphanumetriX", avatarURL, embeds: [embed], files: [{ attachment: readFileSync(join(OUT, POSTS[i].file)), name: POSTS[i].file }], allowedMentions: { parse: [] } });
        if (i === POSTS.length - 1) {
          const ch = (await guild.channels.fetch(channelId)) as TextChannel;
          await ch.messages.pin(msg.id).catch((e) => console.log("pin failed", lang, e.message));
        }
      }
      console.log("posted", POSTS[i].file);
    }
    // Drop the "pinned a message" notices.
    for (const [, { channelId }] of hooks) {
      const ch = (await guild.channels.fetch(channelId)) as TextChannel;
      for (const m of (await ch.messages.fetch({ limit: 5 })).filter((m) => m.type === 6).values()) await m.delete().catch(() => {});
    }
    console.log(`done: https://discord.com/channels/${guildId}/${src.channel_id}`);
  } finally {
    await client.destroy();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });
