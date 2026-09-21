import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, type BaseMessageOptions } from "discord.js";
import { pickerMessage } from "./picker.js";

const TEAL = 0x00c9a7;
const PURPLE = 0x845ef7;

/** Server emoji used on the start-here page. */
const E = {
  BLK: "<:BLK:1266575686454480936>",
  YT: "<:YT:1314772706402504754>",
  X: "<:X_:1229210993142403072>",
  Bitget: "<:Bitget:1217641587622805555>",
  Blofin: "<:blofin:1229192127666458724>",
  Bybit: "<:bybit:1314770880923959407>",
};

const link = (label: string, url: string, emoji?: string) => {
  const b = new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(label).setURL(url);
  return emoji ? b.setEmoji(emoji) : b;
};
const row = (...buttons: ButtonBuilder[]) => new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons);

/** The start-here page: four messages. Short lines, one idea each, buttons do the work. */
export function startHereMessages(opts: { helpDeskUrl: string }): BaseMessageOptions[] {
  const welcome = new EmbedBuilder()
    .setColor(TEAL)
    .setTitle("👋  Welcome to BLKBöX")
    .setDescription(["**1.** Pick your language below", "**2.** Read the rules", "**3.** Create your account and connect an exchange"].join("\n"));

  const rules = new EmbedBuilder()
    .setColor(TEAL)
    .setTitle("📜  Rules")
    .setDescription(
      [
        "**Respect everyone.** No harassment or hate.",
        "**No financial advice.** Education only, do your own research.",
        "**Use the bots responsibly.** No exploiting or sharing.",
        "**No spam or self-promo.**",
        "**Protect privacy.** Never share personal data or API keys.",
        "**Stay on topic** in each channel.",
        "**Moderators have the final say.**",
        "",
        "-# By using this server you agree to the rules, the Terms of Service and the Privacy Policy.",
      ].join("\n"),
    );

  const start = new EmbedBuilder()
    .setColor(PURPLE)
    .setTitle("🚀  Get started")
    .setDescription(
      [
        "**Account** — free, takes a few minutes, runs the bots.",
        "",
        "**Exchange** — open one through our link, then connect it in the app.",
        `${E.Bitget} Bitget · COIN-M futures`,
        `${E.Blofin} Blofin · EU and USA friendly, non-KYC`,
        `${E.Bybit} Bybit · Insurance Trading System`,
        "",
        "-# Exchange links are affiliate links. Using them supports the community at no cost to you.",
      ].join("\n"),
    );

  const community = new EmbedBuilder()
    .setColor(TEAL)
    .setTitle("📡  Follow · Get help")
    .setDescription(
      [
        `${E.YT} **YouTube** — Baloo's Crypto Jungle · Bear Trap TV · Tone Vays`,
        `${E.X} **X** — Baloo · Matt · Tone Vays · BLKBöX`,
        "",
        "☎️ **Questions** go in help-desk. **Private matters:** open a support ticket below.",
      ].join("\n"),
    );

  return [
    { embeds: [welcome] },
    pickerMessage(),
    {
      embeds: [rules],
      components: [
        row(
          link("Terms of Service", "https://momentous-bolt-1cc.notion.site/BLKB-X-Inc-Terms-of-Service-f0567f236cfe43f7b04a47ffa4ed3931?pvs=4", "📄"),
          link("Privacy Policy", "https://momentous-bolt-1cc.notion.site/BLKB-X-Inc-Privacy-Policy-192b905b2a57802f838ffd7e0210e7b5?pvs=4", "🔒"),
        ),
      ],
    },
    {
      embeds: [start],
      components: [
        row(
          link("Create your free account", "https://www.blkbox.pro/", E.BLK),
          link("Strategy performance", "https://momentous-bolt-1cc.notion.site/Bot-Performance-228c030cfd9442d480b0e516363206a1?pvs=4", "🤖"),
        ),
        row(
          link("Bitget", "https://partner.bitget.com/bg/G91HYQ", E.Bitget),
          link("Blofin", "https://partner.blofin.com/d/BLKBox", E.Blofin),
          link("Bybit", "https://partner.bybit.com/b/90136", E.Bybit),
        ),
      ],
    },
    {
      embeds: [community],
      components: [
        row(
          link("Baloo's Crypto Jungle", "https://www.youtube.com/@TheFinancialSummit?Sub_Confirmation=1", E.YT),
          link("Bear Trap TV", "https://www.youtube.com/channel/UCJG_wbsUX52Rr60FPm7Cnew?Sub_Confirmation=1", E.YT),
          link("Tone Vays", "https://www.youtube.com/@tonevays", E.YT),
        ),
        row(
          link("Baloo", "https://x.com/JtBlkbox", E.X),
          link("Matt", "https://x.com/AlphanumetriX", E.X),
          link("Tone Vays", "https://x.com/ToneVays", E.X),
          link("BLKBöX", "https://x.com/blkboxbot", E.X),
        ),
        row(
          link("Help-desk", opts.helpDeskUrl, "☎️"),
          new ButtonBuilder().setStyle(ButtonStyle.Primary).setLabel("Open a Support Ticket").setEmoji("🎟️").setCustomId("placeholder:ticket").setDisabled(true),
        ),
      ],
    },
  ];
}
