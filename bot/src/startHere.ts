import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, type BaseMessageOptions } from "discord.js";
import { pickerMessage } from "./picker.js";

const TEAL = 0x00c9a7;
const PURPLE = 0x845ef7;

/** Server emoji used on the original start-here page. */
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

/**
 * The rebuilt start-here page: six messages, top to bottom.
 * `banner` is the existing "Official BLKBöX links" image, re-uploaded.
 * `helpDeskUrl` is a jump link to the help-desk channel.
 */
export function startHereMessages(opts: { banner?: Buffer; helpDeskUrl: string }): BaseMessageOptions[] {
  const welcome = new EmbedBuilder()
    .setColor(TEAL)
    .setTitle("👋  Welcome to the BLKBöX Trading Floor")
    .setDescription(
      [
        "Automated trading bots, live signals and a community of traders. Three steps to get going:",
        "",
        "**1 · Pick your language** below. Chat, alerts and announcements will show up in it.",
        "**2 · Read the rules.** Short, and they keep this place useful.",
        "**3 · Create your free account** and connect an exchange to start trading with the bots.",
        "",
        "-# 欢迎 · 환영합니다 · Selamat datang — 在下方选择你的语言 · 아래에서 언어를 선택하세요 · Pilih bahasamu di bawah",
      ].join("\n"),
    );

  const rules = new EmbedBuilder()
    .setColor(TEAL)
    .setTitle("📜  Community Rules")
    .setDescription(
      [
        "**1. Respect everyone.** Courtesy to all members. No harassment, hate speech or personal attacks.",
        "**2. No financial advice.** Everything here is education. Do your own research before any trade.",
        "**3. Use the bots responsibly.** No exploiting, unauthorised sharing or misuse.",
        "**4. No spam or self-promotion.** Ads and promos belong only in designated channels.",
        "**5. Protect privacy.** Never share personal data or API keys. No illegal discussion.",
        "**6. Stay on topic.** Keep each channel to its purpose.",
        "**7. Moderators have the final say.** Violations can mean warnings, timeouts or bans.",
        "",
        "By using this server you agree to these rules, our Terms of Service and Privacy Policy. **If you don't agree, please leave the community now.**",
      ].join("\n"),
    );

  const getStarted = new EmbedBuilder()
    .setColor(PURPLE)
    .setTitle("🚀  Create your BLKBöX account")
    .setDescription("Your free account logs you into the app where the trading bots run. Setup takes a few minutes.\n\nCurious how the strategies have performed? The historical results are public.")
    .setURL("https://www.blkbox.pro/");
  if (opts.banner) getStarted.setImage("attachment://official-links.png");

  const exchanges = new EmbedBuilder()
    .setColor(PURPLE)
    .setTitle("🤝  Partnered exchanges")
    .setDescription("Pick an exchange, open your account through our link, then connect it in the app. These are affiliate links: using them supports the community at no cost to you.")
    .addFields(
      { name: `${E.Bitget}  Bitget`, value: "Best choice for COIN-M futures.", inline: true },
      { name: `${E.Blofin}  Blofin`, value: "🇪🇺 🇺🇸 EU and USA friendly, non-KYC, futures and many altcoins.", inline: true },
      { name: `${E.Bybit}  Bybit`, value: "Best for Insurance Trading System (ITS).", inline: true },
    );

  const socials = new EmbedBuilder()
    .setColor(TEAL)
    .setTitle("📡  Follow BLKBöX")
    .setDescription("Market breakdowns, bot updates and live streams.")
    .addFields(
      { name: `${E.YT}  YouTube`, value: "BLKBöX · Bear Trap TV · Tone Vays", inline: true },
      { name: `${E.X}  X`, value: "JT · Matt · Tone Vays · BLKBöX", inline: true },
    );

  const support = new EmbedBuilder()
    .setColor(TEAL)
    .setTitle("🎟️  Need help?")
    .setDescription("Questions about the bots go in the help-desk channel, where the community and the team answer. For anything private, open a support ticket: it creates a private thread with staff.");

  const messages: BaseMessageOptions[] = [
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
      embeds: [getStarted],
      files: opts.banner ? [new AttachmentBuilder(opts.banner, { name: "official-links.png" })] : [],
      components: [
        row(
          link("Create your free account", "https://www.blkbox.pro/", E.BLK),
          link("Strategy performance", "https://momentous-bolt-1cc.notion.site/Bot-Performance-228c030cfd9442d480b0e516363206a1?pvs=4", "🤖"),
        ),
      ],
    },
    {
      embeds: [exchanges],
      components: [
        row(
          link("Bitget", "https://partner.bitget.com/bg/G91HYQ", E.Bitget),
          link("Blofin", "https://partner.blofin.com/d/BLKBox", E.Blofin),
          link("Bybit", "https://partner.bybit.com/b/90136", E.Bybit),
        ),
      ],
    },
    {
      embeds: [socials],
      components: [
        row(
          link("BLKBöX", "https://www.youtube.com/@TheFinancialSummit?Sub_Confirmation=1", E.YT),
          link("Bear Trap TV", "https://www.youtube.com/channel/UCJG_wbsUX52Rr60FPm7Cnew?Sub_Confirmation=1", E.YT),
          link("Tone Vays", "https://www.youtube.com/@tonevays", E.YT),
        ),
        row(
          link("JT", "https://x.com/JtBlkbox", E.X),
          link("Matt", "https://x.com/AlphanumetriX", E.X),
          link("Tone Vays", "https://x.com/ToneVays", E.X),
          link("BLKBöX", "https://x.com/blkboxbot", E.X),
        ),
      ],
    },
    {
      embeds: [support],
      components: [
        row(
          link("Go to help-desk", opts.helpDeskUrl, "☎️"),
          new ButtonBuilder().setStyle(ButtonStyle.Primary).setLabel("Open a Support Ticket").setEmoji("🎟️").setCustomId("placeholder:ticket").setDisabled(true),
        ),
      ],
    },
  ];
  return messages;
}
