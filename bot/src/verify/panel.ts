import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type GuildMember,
  type ModalSubmitInteraction,
  type TextChannel,
} from "discord.js";
import type { Lang } from "../config.js";
import { log, errInfo } from "../log.js";
import type { LanguageRoles } from "../roles.js";
import type { VerifyService } from "./service.js";
import { EXCHANGE_SIGNUP, isExchange, type ExchangeId } from "./types.js";

export const VERIFY_BUTTON = "verify:start";
export const VERIFY_MODAL = "verify:submit";
const FIELD_EXCHANGE = "exchange";
const GUIDE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", "verify", "uid-guide.png");

/**
 * The three-step picture, attached wherever a member might be hunting for their
 * UID. Read once at startup: a missing file costs a picture, never the reply
 * the member is waiting on.
 */
const guideBytes = (() => {
  try {
    return readFileSync(GUIDE);
  } catch (e) {
    log.warn("uid guide image missing; replies will go out without it", { path: GUIDE, ...errInfo(e) });
    return null;
  }
})();

const uidGuide = () => (guideBytes ? [new AttachmentBuilder(guideBytes, { name: "uid-guide.png" })] : []);

const FIELD_UID = "uid";

const signupRow = () =>
  new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("Bitget").setURL(EXCHANGE_SIGNUP.bitget),
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("Blofin").setURL(EXCHANGE_SIGNUP.blofin),
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("Bybit").setURL(EXCHANGE_SIGNUP.bybit),
  );

type PanelText = { title: string; body: string[]; bitcoin: string[]; button: string; note: string };

/** Panel copy per language. The popup and the replies after it are still English. */
const PANEL: Record<Lang, PanelText> = {
  en: {
    title: "Verify your exchange UID",
    body: [
      "The Trading Floor opens once we can see that your exchange account was opened through one of our links.",
      "",
      "Press the button, pick your exchange and paste your UID. It takes a second and nothing else is asked of you.",
    ],
    bitcoin: [
      "Bitcoin chat is for verified members.",
      "",
      "Verify your exchange UID below and this channel opens, along with the full alerts, trader chat and the rest of the Trading Floor.",
    ],
    button: "Verify my UID",
    note: "Your UID is an account number, not a password. Never share an API key or a password with anyone here.",
  },
  zh: {
    title: "验证你的交易所 UID",
    body: [
      "只要确认你的交易所账户是通过我们的链接注册的，交易大厅就会为你开放。",
      "",
      "点击下方按钮，选择交易所并粘贴你的 UID，一秒钟就能完成，不需要提供其他任何信息。",
    ],
    bitcoin: [
      "比特币频道仅对已验证会员开放。",
      "",
      "在下方验证你的交易所 UID，即可解锁本频道，以及完整的交易提醒、交易者聊天和交易大厅的其他频道。",
    ],
    button: "验证我的 UID",
    note: "UID 是账户编号，不是密码。永远不要向任何人透露 API 密钥或密码。",
  },
  ko: {
    title: "거래소 UID 인증",
    body: [
      "거래소 계정이 저희 링크를 통해 개설된 것이 확인되면 트레이딩 플로어가 열립니다.",
      "",
      "버튼을 누르고 거래소를 선택한 뒤 UID를 붙여 넣으세요. 몇 초면 끝나고, 다른 정보는 요구하지 않아요.",
    ],
    bitcoin: [
      "비트코인 채널은 인증된 멤버 전용입니다.",
      "",
      "아래에서 거래소 UID를 인증하면 이 채널과 함께 전체 매매신호, 트레이더 채팅 등 트레이딩 플로어 전체가 열립니다.",
    ],
    button: "내 UID 인증하기",
    note: "UID는 계정 번호이지 비밀번호가 아닙니다. API 키나 비밀번호는 절대 누구에게도 알려주지 마세요.",
  },
  id: {
    title: "Verifikasi UID exchange kamu",
    body: [
      "Trading Floor terbuka setelah kami bisa melihat akun exchange kamu dibuat lewat salah satu link kami.",
      "",
      "Tekan tombolnya, pilih exchange dan tempel UID kamu. Cuma sedetik dan tidak ada data lain yang diminta.",
    ],
    bitcoin: [
      "Kanal Bitcoin khusus untuk member terverifikasi.",
      "",
      "Verifikasi UID exchange kamu di bawah, dan kanal ini terbuka bersama sinyal trading lengkap, obrolan trader, dan seluruh Trading Floor.",
    ],
    button: "Verifikasi UID saya",
    note: "UID adalah nomor akun, bukan kata sandi. Jangan pernah bagikan API key atau kata sandi ke siapa pun di sini.",
  },
};

/**
 * The message that carries the verify button. `bitcoin` is the same button
 * behind a "verified members only" lead-in, for the locked bitcoin channel.
 */
export function verifyPanel(lang: Lang = "en", variant: "verify" | "bitcoin" = "verify") {
  const t = PANEL[lang];
  return {
    content: [`## ${variant === "bitcoin" ? "🔒 " : ""}${t.title}`, ...(variant === "bitcoin" ? t.bitcoin : t.body), "", `-# ${t.note}`].join("\n"),
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(VERIFY_BUTTON).setStyle(ButtonStyle.Success).setLabel(t.button).setEmoji("🔑"),
      ),
    ],
    files: uidGuide(),
  };
}

export async function postVerifyPanel(channel: TextChannel, lang: Lang = "en", variant: "verify" | "bitcoin" = "verify") {
  return channel.send(verifyPanel(lang, variant));
}

/** The popup: exchange picker plus the UID field, in one modal. */
function verifyModal(exchanges: ExchangeId[]) {
  const select = new StringSelectMenuBuilder().setCustomId(FIELD_EXCHANGE).setPlaceholder("Pick your exchange").addOptions(
    exchanges.map((id) => ({ label: id.charAt(0).toUpperCase() + id.slice(1), value: id })),
  );
  return new ModalBuilder()
    .setCustomId(VERIFY_MODAL)
    .setTitle("Verify your exchange UID")
    .addLabelComponents(
      new LabelBuilder().setLabel("Exchange").setDescription("Where you opened the account").setStringSelectMenuComponent(select),
      new LabelBuilder()
        .setLabel("Your UID")
        .setDescription("Account number from the exchange, not an API key")
        .setTextInputComponent(
          new TextInputBuilder().setCustomId(FIELD_UID).setStyle(TextInputStyle.Short).setMinLength(4).setMaxLength(32).setPlaceholder("e.g. 12345678").setRequired(true),
        ),
    );
}

export async function handleVerifyButton(i: ButtonInteraction, deps: { verify: VerifyService; roles: LanguageRoles }) {
  if (!i.inCachedGuild()) return;
  const member = await i.guild.members.fetch(i.user.id);
  // The popup is for people who are not in yet. Existing members get told so
  // rather than being handed a form that would overwrite their record.
  if (deps.roles.isVerified(member)) {
    await i.reply({
      content: "You are already verified, so there is nothing to do here. If your access looks wrong, ask in help-desk and a moderator will sort it out.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const exchanges = deps.verify.exchanges;
  if (exchanges.length === 0) {
    await i.reply({ content: "Verification is offline for a moment. Try again shortly.", flags: MessageFlags.Ephemeral });
    return;
  }
  await i.showModal(verifyModal(exchanges));
}

export async function handleVerifySubmit(i: ModalSubmitInteraction, deps: { verify: VerifyService; roles: LanguageRoles; memberRoleId: string | null }) {
  if (!i.inCachedGuild()) return;
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const member = await i.guild.members.fetch(i.user.id);
    const picked = i.fields.getStringSelectValues(FIELD_EXCHANGE)[0] ?? "";
    const uid = i.fields.getTextInputValue(FIELD_UID);
    if (!isExchange(picked)) {
      await i.editReply("Pick one of the exchanges from the list and try again.");
      return;
    }
    const res = await deps.verify.verify({ userId: i.user.id, alreadyMember: deps.roles.isVerified(member), exchange: picked, uid });
    await i.editReply(await reply(res, member, deps));
  } catch (e) {
    log.error("verify submit failed", errInfo(e));
    await i.editReply("Something broke on our side. Try again in a minute, and tell us in help-desk if it keeps happening.").catch(() => {});
  }
}

async function reply(
  res: Awaited<ReturnType<VerifyService["verify"]>>,
  member: GuildMember,
  deps: { roles: LanguageRoles; memberRoleId: string | null },
) {
  const label = res.exchange.charAt(0).toUpperCase() + res.exchange.slice(1);
  switch (res.outcome) {
    case "verified": {
      if (deps.memberRoleId) await member.roles.add(deps.memberRoleId, `UID verified on ${res.exchange}`).catch((e) => log.error("grant member role failed", errInfo(e)));
      // Swap the language role for its member twin so the full channels open
      // and this verify channel disappears. GuildMemberUpdate would get there
      // too; doing it here means the reply is true the moment it is read.
      await member.fetch(true).then((m) => deps.roles.sync(m)).catch((e) => log.warn("language tier sync failed", errInfo(e)));
      return {
        content: [
          `## You're in`,
          `Your ${label} UID checked out. The Trading Floor is open to you now.`,
          "",
          "Say hello in general.",
        ].join("\n"),
      };
    }
    case "already_member":
      return { content: "You are already verified. Nothing to do here." };
    case "bad_uid":
      return {
        content: [
          "That does not look like a UID.",
          "",
          `A ${label} UID is the account number shown in your profile, usually 7 to 10 digits. It is not your email, your username or an API key. Here is where to find it.`,
        ].join("\n"),
        files: uidGuide(),
      };
    case "rate_limited":
      return { content: "That is a lot of tries in a short time. Wait fifteen minutes and have another go, or ask in help-desk and someone will check it with you." };
    case "already_claimed":
      return {
        content: [
          "That UID is already linked to another Discord account.",
          "",
          "If it is yours and you have changed accounts, open a ticket in help-desk and a moderator will move it across.",
        ].join("\n"),
      };
    case "not_referred":
      return {
        content: [
          `## We cannot see that UID under our ${label} account`,
          "",
          "Two things are usually behind this.",
          "",
          "**The UID is wrong.** Check it in your exchange profile and paste it again. It is the account number, not your username or email.",
          "",
          `**The account was not opened through our link.** The server only opens for accounts that signed up under BLKBöX. If you already had a ${label} account, or you signed up somewhere else, it will not show up for us and we cannot let you in on it.`,
          "",
          `Open a fresh account through the button below, then come back and verify that UID. If you think this is a mistake, ask in help-desk and we will look it up with you.`,
        ].join("\n"),
        components: [signupRow()],
        files: uidGuide(),
      };
    case "not_configured":
      return {
        content: [
          `## ${label} checks are not switched on yet`,
          "",
          "Your UID is fine. We simply cannot check it against ${label} automatically at the moment, so nothing you type here will let you in yet.",
          "",
          "Ask in help-desk and a moderator will verify you by hand, or come back once this is live.",
        ].join("\n").replace("${label}", label),
      };
    case "provider_error":
    default:
      log.warn("verification provider error", { exchange: res.exchange, error: res.error });
      return { content: `${label} did not answer just now. This is on us, not you. Give it a few minutes and press the button again.` };
  }
}
