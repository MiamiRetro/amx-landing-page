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
        "Chat, alerts and announcements will show in the language you pick.",
        "",
        "选择语言 · 언어 선택 · Pilih bahasa",
        "",
        "-# Change it any time with `/language`",
      ].join("\n"),
    );
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${PICKER_PREFIX}en`).setLabel("English").setEmoji("🇬🇧").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`${PICKER_PREFIX}zh`).setLabel("中文").setEmoji("🇨🇳").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`${PICKER_PREFIX}ko`).setLabel("한국어").setEmoji("🇰🇷").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`${PICKER_PREFIX}id`).setLabel("Bahasa Indonesia").setEmoji("🇮🇩").setStyle(ButtonStyle.Success),
  );
  return { embeds: [embed], components: [row] };
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
    await i.editReply(await roles.set(member, lang as Lang));
  } catch (e) {
    await i.editReply(`Something went wrong: ${e instanceof Error ? e.message : String(e)}`);
  }
}
