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
import type { Funnel } from "../funnel.js";
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
  vi: {
    title: "Xác minh UID sàn của bạn",
    body: [
      "Trading Floor sẽ mở khi chúng tôi thấy tài khoản sàn của bạn được tạo qua một trong các link của chúng tôi.",
      "",
      "Bấm nút, chọn sàn và dán UID của bạn. Chỉ mất một giây, không cần thêm thông tin nào khác.",
    ],
    bitcoin: [
      "Kênh Bitcoin chỉ dành cho thành viên đã xác minh.",
      "",
      "Xác minh UID sàn bên dưới để mở kênh này, cùng với tín hiệu đầy đủ, kênh trader và toàn bộ Trading Floor.",
    ],
    button: "Xác minh UID",
    note: "UID là số tài khoản, không phải mật khẩu. Đừng bao giờ chia sẻ API key hay mật khẩu với bất kỳ ai ở đây.",
  },
  es: {
    title: "Verifica tu UID del exchange",
    body: [
      "El Trading Floor se abre cuando vemos que tu cuenta del exchange se abrió con uno de nuestros enlaces.",
      "",
      "Pulsa el botón, elige tu exchange y pega tu UID. Tarda un segundo y no te pedimos nada más.",
    ],
    bitcoin: [
      "El chat de Bitcoin es solo para miembros verificados.",
      "",
      "Verifica tu UID abajo y se abre este canal, junto con las alertas completas, el chat de traders y el resto del Trading Floor.",
    ],
    button: "Verificar mi UID",
    note: "Tu UID es un número de cuenta, no una contraseña. Nunca compartas una API key ni una contraseña con nadie aquí.",
  },
  pt: {
    title: "Verifique seu UID da corretora",
    body: [
      "O Trading Floor abre quando vemos que sua conta na corretora foi criada por um dos nossos links.",
      "",
      "Toque no botão, escolha a corretora e cole seu UID. Leva um segundo e não pedimos mais nada.",
    ],
    bitcoin: [
      "O chat de Bitcoin é só para membros verificados.",
      "",
      "Verifique seu UID abaixo e este canal abre, junto com os alertas completos, o chat de traders e todo o Trading Floor.",
    ],
    button: "Verificar meu UID",
    note: "Seu UID é um número de conta, não uma senha. Nunca compartilhe API key ou senha com ninguém aqui.",
  },
  tr: {
    title: "Borsa UID'ni doğrula",
    body: [
      "Borsa hesabının bizim linklerimizden biriyle açıldığını gördüğümüzde Trading Floor açılır.",
      "",
      "Butona bas, borsanı seç ve UID'ni yapıştır. Bir saniye sürer, başka hiçbir şey istemiyoruz.",
    ],
    bitcoin: [
      "Bitcoin sohbeti yalnızca doğrulanmış üyeler içindir.",
      "",
      "Aşağıdan UID'ni doğrula; bu kanal, tam sinyaller, trader sohbeti ve tüm Trading Floor ile birlikte açılır.",
    ],
    button: "UID'mi doğrula",
    note: "UID bir hesap numarasıdır, şifre değil. API anahtarını veya şifreni burada kimseyle paylaşma.",
  },
  ru: {
    title: "Подтвердите UID биржи",
    body: [
      "Trading Floor откроется, как только мы увидим, что ваш аккаунт на бирже открыт по одной из наших ссылок.",
      "",
      "Нажмите кнопку, выберите биржу и вставьте UID. Это займёт секунду, больше ничего не нужно.",
    ],
    bitcoin: [
      "Чат о биткоине только для подтверждённых участников.",
      "",
      "Подтвердите UID ниже, и откроется этот канал, а вместе с ним полные сигналы, чат трейдеров и весь Trading Floor.",
    ],
    button: "Подтвердить UID",
    note: "UID это номер аккаунта, а не пароль. Никогда никому здесь не сообщайте API-ключ или пароль.",
  },
  ja: {
    title: "取引所UIDを認証する",
    body: [
      "あなたの取引所アカウントが私たちのリンクから開設されたことを確認できると、Trading Floor が開きます。",
      "",
      "ボタンを押して取引所を選び、UIDを貼り付けてください。数秒で終わり、ほかの情報は一切不要です。",
    ],
    bitcoin: [
      "ビットコインチャンネルは認証済みメンバー専用です。",
      "",
      "下でUIDを認証すると、このチャンネルとフルのシグナル、トレーダーチャット、Trading Floor 全体が開きます。",
    ],
    button: "UIDを認証する",
    note: "UIDは口座番号であり、パスワードではありません。APIキーやパスワードは絶対に誰にも教えないでください。",
  },
};

/** The lock channels' lead-in: what is behind the lock, in each language. `{topic}` is the channel's own name. */
const LOCKED: Record<Lang, string> = {
  en: "**{topic}** is for verified members. Verify your exchange UID below to unlock it, along with every other locked channel on the Trading Floor.",
  zh: "**{topic}** 仅对已验证会员开放。在下方验证你的交易所 UID 即可解锁本频道，以及交易大厅所有带锁的频道。",
  ko: "**{topic}** 채널은 인증된 멤버 전용입니다. 아래에서 거래소 UID를 인증하면 이 채널과 트레이딩 플로어의 모든 잠긴 채널이 열립니다.",
  id: "**{topic}** khusus untuk member terverifikasi. Verifikasi UID exchange kamu di bawah untuk membukanya, bersama semua kanal terkunci lain di Trading Floor.",
  vi: "**{topic}** chỉ dành cho thành viên đã xác minh. Xác minh UID sàn bên dưới để mở kênh này cùng mọi kênh bị khóa khác trên Trading Floor.",
  es: "**{topic}** es solo para miembros verificados. Verifica tu UID abajo para desbloquearlo, junto con todos los demás canales bloqueados del Trading Floor.",
  pt: "**{topic}** é só para membros verificados. Verifique seu UID abaixo para liberar, junto com todos os outros canais bloqueados do Trading Floor.",
  tr: "**{topic}** yalnızca doğrulanmış üyeler içindir. Aşağıdan UID'ni doğrula; bu kanal ve Trading Floor'daki diğer tüm kilitli kanallar açılır.",
  ru: "**{topic}** только для подтверждённых участников. Подтвердите UID ниже, и откроется этот канал вместе со всеми закрытыми каналами Trading Floor.",
  ja: "**{topic}** は認証済みメンバー専用です。下でUIDを認証すると、このチャンネルとTrading Floorのすべてのロック中チャンネルが開きます。",
};

/**
 * The message that carries the verify button. `bitcoin` and `locked` are the same
 * button behind a "verified members only" lead-in, for the lock channels;
 * `locked` names the channel it stands in for (`topic`).
 */
export function verifyPanel(lang: Lang = "en", variant: "verify" | "bitcoin" | "locked" = "verify", topic = "") {
  const t = PANEL[lang];
  const lead = variant === "locked" ? [LOCKED[lang].replace("{topic}", topic)] : variant === "bitcoin" ? t.bitcoin : t.body;
  return {
    content: [`## ${variant === "verify" ? "" : "🔒 "}${t.title}`, ...lead, "", `-# ${t.note}`].join("\n"),
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(VERIFY_BUTTON).setStyle(ButtonStyle.Primary).setLabel(t.button).setEmoji("🔑"),
      ),
    ],
    files: uidGuide(),
  };
}

export async function postVerifyPanel(channel: TextChannel, lang: Lang = "en", variant: "verify" | "bitcoin" | "locked" = "verify", topic = "") {
  return channel.send(verifyPanel(lang, variant, topic));
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

export async function handleVerifyButton(i: ButtonInteraction, deps: { verify: VerifyService; roles: LanguageRoles; funnel?: Funnel }) {
  if (!i.inCachedGuild()) return;
  deps.funnel?.record(i.user.id, "verify_opened");
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

export async function handleVerifySubmit(i: ModalSubmitInteraction, deps: { verify: VerifyService; roles: LanguageRoles; memberRoleId: string | null; funnel?: Funnel }) {
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
    deps.funnel?.record(i.user.id, "verify_result", { lang: deps.roles.langOf(member), detail: { outcome: res.outcome, exchange: res.exchange } });
    if (res.outcome === "verified") deps.funnel?.record(i.user.id, "verified", { lang: deps.roles.langOf(member) });
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
