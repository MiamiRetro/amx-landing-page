import { existsSync, readFileSync } from "node:fs";
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
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
  type MessageCreateOptions,
} from "discord.js";
import { PICKER_PREFIX } from "./picker.js";
import type { Lang } from "./config.js";
import { guideText } from "./i18n/guide.js";

/** Brand from blkbox.pro: navy, Sora, cyan and emerald accents, white wordmark. */
const GREEN = 0x22d3ee; // site cyan
const ASSETS = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "start-here");

/** Server emoji used on the page. */
const E = {
  BLK: "<:BLK:1266575686454480936>",
  Glow: "<:BLKglow:1551825660584927232>",
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
/** A banner in the member's language when one was rendered (assets/start-here/<lang>/), English otherwise. */
const asset = (file: string, lang: Lang = "en") => {
  const own = join(ASSETS, lang, file);
  return new AttachmentBuilder(readFileSync(lang !== "en" && existsSync(own) ? own : join(ASSETS, file)), { name: file });
};

const TERMS_URL = "https://momentous-bolt-1cc.notion.site/BLKB-X-Inc-Terms-of-Service-f0567f236cfe43f7b04a47ffa4ed3931?pvs=4";
const PRIVACY_URL = "https://www.blkbox.pro/privacy-policy";
const RULES = [
  "**Respect everyone.**  No harassment, no hate.",
  "**No financial advice.**  Education only. Do your own research.",
  "**Use the bots responsibly.**  No exploiting, no sharing.",
  "**No spam or self-promo.**",
  "**Protect privacy.**  Never share personal data or API keys.",
  "**Stay on topic**  in each channel.",
  "**Moderators have the final say.**",
].join("\n");

/** One branded card per section, built with Discord's layout components. */
/**
 * `translateEmoji` is the server's :translate: emoji markup (`<:translate:id>`),
 * shown on the language card when the server has it.
 */
export function startHereMessages(opts: { helpDeskUrl: string; picker?: boolean; translateEmoji?: string; lang?: Lang }): MessageCreateOptions[] {
  const V2 = MessageFlags.IsComponentsV2;
  const t = guideText(opts.lang ?? "en");

  // Hero image only: the banner already carries the wordmark, headline and tagline.
  const welcome = new ContainerBuilder()
    .setAccentColor(GREEN)
    .addMediaGalleryComponents(banner("hero.png"));

  // Discord only offers four button colours (blurple, grey, green, red) and link buttons are always grey.
  // Green is the closest to the site emerald, so it marks the actions members take on the page.
  const language = new ContainerBuilder()
    .setAccentColor(GREEN)
    .addMediaGalleryComponents(banner("language.png"))
    .addTextDisplayComponents(
      text(
        [
          `### ${opts.translateEmoji ? opts.translateEmoji + "  " : ""}Pick your language to enter`,
          "Chat, alerts and announcements will show in that language.",
          "-# 选择语言 · 언어 선택 · Pilih bahasa · Chọn ngôn ngữ · Elige tu idioma · Escolha seu idioma · Dilini seç · Выберите язык · 言語を選択",
          "-# Your choice is final. A moderator can change it if you need.",
        ].join("\n"),
      ),
    )
    .addActionRowComponents(
      row(
        new ButtonBuilder().setCustomId(`${PICKER_PREFIX}en`).setLabel("English").setEmoji("🇬🇧").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`${PICKER_PREFIX}zh`).setLabel("中文").setEmoji("🇨🇳").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`${PICKER_PREFIX}ko`).setLabel("한국어").setEmoji("🇰🇷").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`${PICKER_PREFIX}id`).setLabel("Bahasa Indonesia").setEmoji("🇮🇩").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`${PICKER_PREFIX}vi`).setLabel("Tiếng Việt").setEmoji("🇻🇳").setStyle(ButtonStyle.Success),
      ),
      row(
        new ButtonBuilder().setCustomId(`${PICKER_PREFIX}es`).setLabel("Español").setEmoji("🇪🇸").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`${PICKER_PREFIX}pt`).setLabel("Português").setEmoji("🇧🇷").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`${PICKER_PREFIX}tr`).setLabel("Türkçe").setEmoji("🇹🇷").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`${PICKER_PREFIX}ru`).setLabel("Русский").setEmoji("🇷🇺").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`${PICKER_PREFIX}ja`).setLabel("日本語").setEmoji("🇯🇵").setStyle(ButtonStyle.Success),
      ),
    );

  const rules = new ContainerBuilder()
    .setAccentColor(GREEN)
    .addMediaGalleryComponents(banner("rules.png"))
    .addTextDisplayComponents(text(t.rules))
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(text(t.agreeNote))
    .addActionRowComponents(
      row(
        link(t.termsButton, TERMS_URL, "📄"),
        link(t.privacyButton, PRIVACY_URL, "🔒"),
      ),
    );

  const start = new ContainerBuilder()
    .setAccentColor(GREEN)
    .addMediaGalleryComponents(banner("start.png"))
    .addTextDisplayComponents(
      text(t.stepsTitle),
      text(t.stepsIntro),
    )
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(
      text(t.step1Title),
      text(t.step1Body),
    )
    .addActionRowComponents(row(link(t.step1Button, "https://www.blkbox.pro/signup", E.Glow)))
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(
      text(t.step2Title),
      text(
        [
          t.step2Why1,
          "",
          t.step2Why2,
          "",
          t.step2Why3,
        ].join("\n"),
      ),
      text(
        [
          t.startHereTitle,
          t.regionEurope,
          t.regionKorea,
          t.regionIndonesia,
          t.regionJapan,
          t.regionElse,
        ].join("\n"),
      ),
      text(
        [
          t.whoTitle,
          "",
          t.whoBybit,
          "\ud83c\uddec\ud83c\udde7 \ud83c\uddea\ud83c\uddfa \ud83c\uddef\ud83c\uddf5 \ud83c\uddf0\ud83c\uddf7 \ud83c\uddee\ud83c\udde9",
          "",
          t.whoBitget,
          "\ud83c\uddec\ud83c\udde7 \ud83c\uddee\ud83c\udde9",
          "",
          t.whoBlofin,
          "\ud83c\uddec\ud83c\udde7 \ud83c\uddea\ud83c\uddfa \ud83c\uddef\ud83c\uddf5 \ud83c\uddf0\ud83c\uddf7 \ud83c\uddee\ud83c\udde9",
          "",
          t.whoMexc,
          "\ud83c\uddea\ud83c\uddfa \ud83c\uddef\ud83c\uddf5 \ud83c\uddf0\ud83c\uddf7 \ud83c\uddee\ud83c\udde9",
          "",
          t.whoToobit,
          "\ud83c\uddea\ud83c\uddfa \ud83c\uddef\ud83c\uddf5 \ud83c\uddf0\ud83c\uddf7 \ud83c\uddee\ud83c\udde9",
        ].join("\n"),
      ),
      text(t.usCanada),
      text(t.availability),
    )
    .addActionRowComponents(
      row(
        link("Bitget", "https://partner.bitget.com/bg/G91HYQ", E.Bitget),
        link("Blofin", "https://partner.blofin.com/d/BLKBox", E.Blofin),
        link("Bybit", "https://partner.bybit.com/b/90136", E.Bybit),
        // Placeholders until the affiliate links exist.
        new ButtonBuilder().setStyle(ButtonStyle.Secondary).setLabel(t.mexcSoon).setCustomId("placeholder:mexc").setDisabled(true),
        new ButtonBuilder().setStyle(ButtonStyle.Secondary).setLabel(t.toobitSoon).setCustomId("placeholder:toobit").setDisabled(true),
      ),
    )
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(
      text(t.step3Title),
      text(t.step3Body),
      text(t.step3Note),
    )
    .addActionRowComponents(row(link(t.step3Button, "https://app.blkbox.pro", E.BLK)));

  const community = new ContainerBuilder()
    .setAccentColor(GREEN)
    .addMediaGalleryComponents(banner("community.png"))
    .addTextDisplayComponents(text(`### ${E.YT}  YouTube`))
    .addActionRowComponents(
      row(
        link("Baloo's Crypto Jungle", "https://www.youtube.com/@TheFinancialSummit?Sub_Confirmation=1", E.YT),
        link("Bear Trap TV", "https://www.youtube.com/channel/UCJG_wbsUX52Rr60FPm7Cnew?Sub_Confirmation=1", E.YT),
        link("Tone Vays", "https://www.youtube.com/@tonevays", E.YT),
      ),
    )
    .addTextDisplayComponents(text(`### ${E.X}  X`))
    .addActionRowComponents(
      row(
        link("Baloo", "https://x.com/JtBlkbox", E.X),
        link("Matt", "https://x.com/AlphanumetriX", E.X),
        link("Tone Vays", "https://x.com/ToneVays", E.X),
        link("BLKBöX", "https://x.com/blkboxbot", E.X),
      ),
    )
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(
      text(t.helpTitle),
      text(t.helpBody),
    )
    .addActionRowComponents(
      row(
        link(t.helpButton, opts.helpDeskUrl, "☎️"),
        new ButtonBuilder().setStyle(ButtonStyle.Success).setLabel(t.ticketButton).setEmoji("🎟️").setCustomId("placeholder:ticket").setDisabled(true),
      ),
    );

  // The picker channel is the front door and the only thing a newcomer sees:
  // the rules with the terms they accept by entering, then the language buttons.
  if (opts.picker) {
    const terms = new ContainerBuilder()
      .setAccentColor(GREEN)
      .addMediaGalleryComponents(banner("rules.png"))
      .addTextDisplayComponents(text(RULES))
      .addSeparatorComponents(divider())
      .addTextDisplayComponents(
        text(
          [
            "### Before you enter",
            "**Entering this server means you accept its terms.**",
            "**Nobody here is responsible for your funds.** You decide what you trade, and the risk is yours alone.",
            "**Nothing in this server is financial advice.** Alerts, bots, calls and chat are education and opinion.",
            "**Read the full Terms of Service before you enter.**",
          ].join("\n"),
        ),
        text(
          [
            "-# 中文 进入本服务器即表示接受其条款。任何人都不对你的资金负责，这里的内容都不构成投资建议。进入前请阅读完整的服务条款。",
            "-# 한국어 서버에 입장하면 이용약관에 동의하는 것입니다. 누구도 여러분의 자금에 책임지지 않으며, 이 서버의 어떤 내용도 투자 조언이 아닙니다. 입장 전에 전체 이용약관을 읽어 주세요.",
            "-# Bahasa Indonesia Masuk ke server ini berarti kamu menerima ketentuannya. Tidak ada yang bertanggung jawab atas dana kamu, dan tidak ada isi server ini yang merupakan nasihat keuangan. Baca Ketentuan Layanan lengkap sebelum masuk.",
            "-# Tiếng Việt Vào server này nghĩa là bạn chấp nhận các điều khoản. Không ai chịu trách nhiệm về tiền của bạn, và không nội dung nào ở đây là lời khuyên tài chính. Hãy đọc đầy đủ Điều khoản dịch vụ trước khi vào.",
            "-# Español Entrar en este servidor significa aceptar sus términos. Nadie es responsable de tus fondos y nada aquí es asesoramiento financiero. Lee los Términos de Servicio completos antes de entrar.",
            "-# Português Entrar neste servidor significa aceitar os termos. Ninguém é responsável pelos seus fundos e nada aqui é recomendação financeira. Leia os Termos de Serviço completos antes de entrar.",
            "-# Türkçe Bu sunucuya girmek şartlarını kabul etmek demektir. Fonlarından kimse sorumlu değildir ve buradaki hiçbir şey yatırım tavsiyesi değildir. Girmeden önce Hizmet Şartları'nın tamamını oku.",
            "-# 日本語 このサーバーに入ると利用規約に同意したことになります。誰もあなたの資金に責任を負わず、ここにある内容はすべて投資助言ではありません。入る前に利用規約全文を読んでください。",
            "-# Русский Входя на сервер, вы принимаете его условия. Никто не несёт ответственности за ваши средства, и ничто здесь не является финансовым советом. Прочитайте полные Условия использования перед входом.",
          ].join("\n"),
        ),
      )
      .addActionRowComponents(row(link("Terms of Service", TERMS_URL, "📄"), link("Privacy Policy", PRIVACY_URL, "🔒")));
    return [
      { components: [terms], files: [asset("rules.png")], flags: V2 },
      { components: [language], files: [asset("language.png")], flags: V2 },
    ];
  }

  // start-here is only seen after a language is picked, so it drops the picker.
  return [
    { components: [welcome], files: [asset("hero.png", opts.lang)], flags: V2 },
    { components: [rules], files: [asset("rules.png", opts.lang)], flags: V2 },
    { components: [start], files: [asset("start.png", opts.lang)], flags: V2 },
    { components: [community], files: [asset("community.png", opts.lang)], flags: V2 },
  ];
}
