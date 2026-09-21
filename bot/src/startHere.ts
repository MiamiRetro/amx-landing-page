import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
  ThumbnailBuilder,
  type MessageCreateOptions,
} from "discord.js";
import { PICKER_PREFIX } from "./picker.js";

/** Brand from blkbox.pro: navy, Sora, cyan and emerald accents, white wordmark. */
const GREEN = 0x22d3ee; // site cyan
const ASSETS = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "start-here");

/** Server emoji used on the page. */
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
const text = (s: string) => new TextDisplayBuilder().setContent(s);
const banner = (file: string) => new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(`attachment://${file}`));
const divider = () => new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);
const asset = (file: string) => new AttachmentBuilder(readFileSync(join(ASSETS, file)), { name: file });

/** One branded card per section, built with Discord's layout components. */
export function startHereMessages(opts: { helpDeskUrl: string }): MessageCreateOptions[] {
  const V2 = MessageFlags.IsComponentsV2;

  const welcome = new ContainerBuilder()
    .setAccentColor(GREEN)
    .addMediaGalleryComponents(banner("hero.png"))
    .addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(
          text("## Welcome to the Trading Floor"),
          text("Automated trading bots, live alerts and a community that never misses a move."),
        )
        .setThumbnailAccessory(new ThumbnailBuilder().setURL("attachment://logo.png").setDescription("BLKBöX")),
    )
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(text("**1**  Choose your language\n**2**  Read the rules\n**3**  Create your account and connect an exchange"));

  const language = new ContainerBuilder()
    .setAccentColor(GREEN)
    .addMediaGalleryComponents(banner("language.png"))
    .addTextDisplayComponents(text("Chat, alerts and announcements will show in the language you pick. Change it any time with `/language`."))
    .addActionRowComponents(
      row(
        new ButtonBuilder().setCustomId(`${PICKER_PREFIX}en`).setLabel("English").setEmoji("🇬🇧").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`${PICKER_PREFIX}zh`).setLabel("中文").setEmoji("🇨🇳").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`${PICKER_PREFIX}ko`).setLabel("한국어").setEmoji("🇰🇷").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`${PICKER_PREFIX}id`).setLabel("Bahasa Indonesia").setEmoji("🇮🇩").setStyle(ButtonStyle.Secondary),
      ),
    );

  const rules = new ContainerBuilder()
    .setAccentColor(GREEN)
    .addMediaGalleryComponents(banner("rules.png"))
    .addTextDisplayComponents(
      text(
        [
          "**Respect everyone.**  No harassment, no hate.",
          "**No financial advice.**  Education only. Do your own research.",
          "**Use the bots responsibly.**  No exploiting, no sharing.",
          "**No spam or self-promo.**",
          "**Protect privacy.**  Never share personal data or API keys.",
          "**Stay on topic**  in each channel.",
          "**Moderators have the final say.**",
        ].join("\n"),
      ),
    )
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(text("-# By using this server you agree to the rules, the Terms of Service and the Privacy Policy."))
    .addActionRowComponents(
      row(
        link("Terms of Service", "https://momentous-bolt-1cc.notion.site/BLKB-X-Inc-Terms-of-Service-f0567f236cfe43f7b04a47ffa4ed3931?pvs=4", "📄"),
        link("Privacy Policy", "https://momentous-bolt-1cc.notion.site/BLKB-X-Inc-Privacy-Policy-192b905b2a57802f838ffd7e0210e7b5?pvs=4", "🔒"),
      ),
    );

  const start = new ContainerBuilder()
    .setAccentColor(GREEN)
    .addMediaGalleryComponents(banner("start.png"))
    .addTextDisplayComponents(text("### Account\nFree, takes a few minutes, and it's where the bots run."))
    .addActionRowComponents(
      row(
        link("Create your free account", "https://www.blkbox.pro/", E.BLK),
        link("Strategy performance", "https://momentous-bolt-1cc.notion.site/Bot-Performance-228c030cfd9442d480b0e516363206a1?pvs=4", "🤖"),
      ),
    )
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(
      text(
        [
          "### Exchange",
          "Open one through our link, then connect it in the app.",
          `${E.Bitget}  **Bitget**  ·  COIN-M futures`,
          `${E.Blofin}  **Blofin**  ·  EU and USA friendly, non-KYC`,
          `${E.Bybit}  **Bybit**  ·  Insurance Trading System`,
          "-# Affiliate links. Using them supports the community at no cost to you.",
        ].join("\n"),
      ),
    )
    .addActionRowComponents(
      row(
        link("Bitget", "https://partner.bitget.com/bg/G91HYQ", E.Bitget),
        link("Blofin", "https://partner.blofin.com/d/BLKBox", E.Blofin),
        link("Bybit", "https://partner.bybit.com/b/90136", E.Bybit),
      ),
    );

  const community = new ContainerBuilder()
    .setAccentColor(GREEN)
    .addMediaGalleryComponents(banner("community.png"))
    .addTextDisplayComponents(text(`${E.YT}  **YouTube**`))
    .addActionRowComponents(
      row(
        link("Baloo's Crypto Jungle", "https://www.youtube.com/@TheFinancialSummit?Sub_Confirmation=1", E.YT),
        link("Bear Trap TV", "https://www.youtube.com/channel/UCJG_wbsUX52Rr60FPm7Cnew?Sub_Confirmation=1", E.YT),
        link("Tone Vays", "https://www.youtube.com/@tonevays", E.YT),
      ),
    )
    .addTextDisplayComponents(text(`${E.X}  **X**`))
    .addActionRowComponents(
      row(
        link("Baloo", "https://x.com/JtBlkbox", E.X),
        link("Matt", "https://x.com/AlphanumetriX", E.X),
        link("Tone Vays", "https://x.com/ToneVays", E.X),
        link("BLKBöX", "https://x.com/blkboxbot", E.X),
      ),
    )
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(text("**Questions?**  Ask in help-desk, the community and the team answer there.\n**Something private?**  Open a support ticket for a private thread with staff."))
    .addActionRowComponents(
      row(
        link("Help-desk", opts.helpDeskUrl, "☎️"),
        new ButtonBuilder().setStyle(ButtonStyle.Primary).setLabel("Open a Support Ticket").setEmoji("🎟️").setCustomId("placeholder:ticket").setDisabled(true),
      ),
    );

  return [
    { components: [welcome], files: [asset("hero.png"), asset("logo.png")], flags: V2 },
    { components: [language], files: [asset("language.png")], flags: V2 },
    { components: [rules], files: [asset("rules.png")], flags: V2 },
    { components: [start], files: [asset("start.png")], flags: V2 },
    { components: [community], files: [asset("community.png")], flags: V2 },
  ];
}
