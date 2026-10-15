import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, type ButtonInteraction, type TextChannel } from "discord.js";
import { isLang, type Lang } from "./config.js";
import type { LanguageRoles } from "./roles.js";

export const PICKER_PREFIX = "lang:";

/** The language picker message: one embed, four buttons. Posted by the bot user so it is never mirrored. */
export function pickerMessage() {
  const embed = new EmbedBuilder()
    .setColor(0x1f4fd8)
    .setTitle("🌐  Choose your language")
    .setDescription(
      [
        "Pick the language you want the community in. Your channels open straight away.",
        "By picking, you agree to the server rules.",
        "",
        "**中文** 选择你的语言。选择即表示你同意服务器规则。",
        "**한국어** 언어를 선택하세요. 선택하면 서버 규칙에 동의하는 것으로 간주됩니다.",
        "**Bahasa Indonesia** Pilih bahasamu. Dengan memilih, kamu menyetujui aturan server.",
        "",
        "-# Your choice is final. A moderator can change it later if you need.",
      ].join("\n"),
    );
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${PICKER_PREFIX}en`).setLabel("English").setEmoji("🇬🇧").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`${PICKER_PREFIX}zh`).setLabel("中文").setEmoji("🇨🇳").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`${PICKER_PREFIX}ko`).setLabel("한국어").setEmoji("🇰🇷").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`${PICKER_PREFIX}id`).setLabel("Bahasa Indonesia").setEmoji("🇮🇩").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`${PICKER_PREFIX}vi`).setLabel("Tiếng Việt").setEmoji("🇻🇳").setStyle(ButtonStyle.Success),
  );
  // Discord allows five buttons per row.
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${PICKER_PREFIX}es`).setLabel("Español").setEmoji("🇪🇸").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`${PICKER_PREFIX}pt`).setLabel("Português").setEmoji("🇧🇷").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`${PICKER_PREFIX}tr`).setLabel("Türkçe").setEmoji("🇹🇷").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`${PICKER_PREFIX}ru`).setLabel("Русский").setEmoji("🇷🇺").setStyle(ButtonStyle.Success),
  );
  return { embeds: [embed], components: [row, row2] };
}

export async function postPicker(channel: TextChannel) {
  return channel.send(pickerMessage());
}

export async function handlePickerButton(i: ButtonInteraction, roles: LanguageRoles) {
  const lang = i.customId.slice(PICKER_PREFIX.length);
  if (!isLang(lang) || !i.inCachedGuild()) return;
  await i.deferReply({ ephemeral: true });
  try {
    const member = await i.guild.members.fetch(i.user.id);
    await i.editReply(await roles.pick(member, lang as Lang));
  } catch (e) {
    await i.editReply(`Something went wrong: ${e instanceof Error ? e.message : String(e)}`);
  }
}
