import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { LANGS, type Lang } from "../config.js";
import { LANG_BUTTONS } from "../picker.js";

/**
 * Wrong-language recovery in a help thread. A member who picked the wrong
 * language usually finds out in help-desk: they write in another language, or
 * say they can't read this one. The assistant notices, the bot shows the
 * language buttons once, and the member switches themselves:
 *
 *   unverified  →  tap a language: switched at once, the help thread moves to
 *                  that language's help-desk, the answer follows in it, and the
 *                  🔒 Verify panel there is in the new language.
 *   verified    →  tap a language, then confirm: the UID verification carries
 *                  over (they land on "<lang> Member"), and #mod-chat is told.
 *
 * One self-switch per member. After that the buttons point to a moderator,
 * who can still move anyone with `/language member`.
 */
export const SWITCH_PICK = "support:lang:";
export const SWITCH_CONFIRM = "support:langok:";
export const SWITCH_CANCEL = "support:langno:";

/** Settings key that records a member's self-switch, so it happens once. */
export const switchKey = (userId: string) => `support_lang_switch:${userId}`;

export interface SwitchText {
  /** Over the language buttons, in the language the member wrote in. */
  offer: string;
  /** Verified members confirm first; {lang} is the language they tapped. */
  confirm: string;
  confirmButton: string;
  cancelButton: string;
  cancelled: string;
  /** Ephemeral reply once switched; {link} is the new help thread, or the old one if it stays. */
  switched: string;
  /** Added for unverified members: their Verify panel is now in the new language. */
  verifyHint: string;
  /** Added for verified members. */
  keptVerified: string;
  /** First line of the new help thread; {user} is the member, {lang} the new language. */
  intro: string;
  /** Left in the old thread before it closes; {link} is the new one. */
  moved: string;
  /** The member already used their one self-switch. */
  used: string;
}

const NAME: Record<Lang, string> = Object.fromEntries(LANGS.map((l) => [l, LANG_BUTTONS[l].label])) as Record<Lang, string>;

export function langName(lang: Lang) {
  return NAME[lang];
}

export const SWITCH_TEXT: Record<Lang, SwitchText> = {
  en: {
    offer: "It looks like another language would suit you better. Tap your language below and I'll switch the server to it for you.",
    confirm: "Switch your server language to {lang}? Your channels move to {lang} and your UID verification carries over.",
    confirmButton: "Yes, switch",
    cancelButton: "Cancel",
    cancelled: "No problem, nothing changed.",
    switched: "Done, your server language is now English. Your help thread continues here: {link}",
    verifyHint: "To unlock the full Trading Floor, press “Verify my UID” in any 🔒 channel.",
    keptVerified: "You're still verified, so there's nothing else to do.",
    intro: "Hi {user}, your server language is now {lang}. Here is my answer to your question:",
    moved: "This conversation continues in English here: {link}",
    used: "You've already changed your language once. A moderator can change it again for you; tap the button below.",
  },
  zh: {
    offer: "看起来你更习惯使用其他语言。请点击下面你的语言，我会帮你把服务器切换过去。",
    confirm: "要把你的服务器语言切换为{lang}吗？你的频道会换成{lang}，UID 验证会保留。",
    confirmButton: "确认切换",
    cancelButton: "取消",
    cancelled: "好的，什么都没有改。",
    switched: "已完成，你的服务器语言现在是中文。你的帮助话题在这里继续：{link}",
    verifyHint: "在任意 🔒 频道点击「验证我的 UID」，即可解锁完整的交易大厅。",
    keptVerified: "你的验证依然有效，不需要再做任何操作。",
    intro: "你好 {user}，你的服务器语言现在是{lang}。下面是对你问题的回答：",
    moved: "对话已移到这里，用中文继续：{link}",
    used: "你已经自己更改过一次语言了。管理员可以再帮你更改，请点下面的按钮。",
  },
  ko: {
    offer: "다른 언어가 더 편하신 것 같아요. 아래에서 사용하실 언어를 누르시면 서버 언어를 바꿔 드릴게요.",
    confirm: "서버 언어를 {lang}(으)로 바꾸시겠어요? 채널이 {lang}(으)로 바뀌고 UID 인증은 그대로 유지됩니다.",
    confirmButton: "네, 바꿀게요",
    cancelButton: "취소",
    cancelled: "알겠습니다. 아무것도 바뀌지 않았어요.",
    switched: "완료되었습니다. 서버 언어가 이제 한국어예요. 도움 스레드는 여기에서 이어집니다: {link}",
    verifyHint: "🔒 채널에서 「내 UID 인증하기」를 누르시면 트레이딩 플로어 전체가 열립니다.",
    keptVerified: "인증은 그대로 유지되니 더 하실 일은 없어요.",
    intro: "안녕하세요 {user}님, 서버 언어가 이제 {lang}입니다. 질문에 대한 답변입니다:",
    moved: "대화는 여기에서 한국어로 이어집니다: {link}",
    used: "이미 한 번 직접 언어를 바꾸셨어요. 운영진이 다시 바꿔 드릴 수 있으니 아래 버튼을 눌러 주세요.",
  },
  id: {
    offer: "Sepertinya bahasa lain lebih cocok untukmu. Tekan bahasamu di bawah, nanti server saya ganti ke bahasa itu.",
    confirm: "Ganti bahasa server-mu ke {lang}? Kanalmu pindah ke {lang} dan verifikasi UID-mu tetap berlaku.",
    confirmButton: "Ya, ganti",
    cancelButton: "Batal",
    cancelled: "Oke, tidak ada yang berubah.",
    switched: "Selesai, bahasa server-mu sekarang Bahasa Indonesia. Thread bantuanmu berlanjut di sini: {link}",
    verifyHint: "Untuk membuka seluruh Trading Floor, tekan “Verifikasi UID saya” di kanal 🔒 mana pun.",
    keptVerified: "Kamu masih terverifikasi, jadi tidak perlu melakukan apa-apa lagi.",
    intro: "Halo {user}, bahasa server-mu sekarang {lang}. Ini jawaban untuk pertanyaanmu:",
    moved: "Percakapan ini berlanjut dalam Bahasa Indonesia di sini: {link}",
    used: "Kamu sudah pernah mengganti bahasa sendiri. Moderator bisa menggantinya lagi; tekan tombol di bawah.",
  },
  vi: {
    offer: "Có vẻ bạn quen dùng một ngôn ngữ khác hơn. Bấm vào ngôn ngữ của bạn bên dưới, mình sẽ đổi máy chủ sang ngôn ngữ đó cho bạn.",
    confirm: "Đổi ngôn ngữ máy chủ của bạn sang {lang}? Các kênh của bạn sẽ chuyển sang {lang} và xác minh UID vẫn được giữ.",
    confirmButton: "Đồng ý đổi",
    cancelButton: "Hủy",
    cancelled: "Được rồi, không có gì thay đổi.",
    switched: "Xong, ngôn ngữ máy chủ của bạn giờ là tiếng Việt. Chủ đề hỗ trợ của bạn tiếp tục ở đây: {link}",
    verifyHint: "Để mở toàn bộ Trading Floor, bấm “Xác minh UID” trong bất kỳ kênh 🔒 nào.",
    keptVerified: "Bạn vẫn đã được xác minh, nên không cần làm gì thêm.",
    intro: "Chào {user}, ngôn ngữ máy chủ của bạn giờ là {lang}. Đây là câu trả lời cho câu hỏi của bạn:",
    moved: "Cuộc trò chuyện tiếp tục bằng tiếng Việt ở đây: {link}",
    used: "Bạn đã tự đổi ngôn ngữ một lần rồi. Quản trị viên có thể đổi lại cho bạn; hãy bấm nút bên dưới.",
  },
  es: {
    offer: "Parece que te sientes más cómodo en otro idioma. Toca tu idioma abajo y cambio el servidor a ese idioma por ti.",
    confirm: "¿Cambiar el idioma del servidor a {lang}? Tus canales pasan a {lang} y tu verificación de UID se mantiene.",
    confirmButton: "Sí, cambiar",
    cancelButton: "Cancelar",
    cancelled: "De acuerdo, no cambió nada.",
    switched: "Listo, el idioma de tu servidor ahora es español. Tu hilo de ayuda sigue aquí: {link}",
    verifyHint: "Para desbloquear todo el Trading Floor, pulsa «Verificar mi UID» en cualquier canal 🔒.",
    keptVerified: "Sigues verificado, así que no tienes que hacer nada más.",
    intro: "Hola {user}, el idioma de tu servidor ahora es {lang}. Esta es la respuesta a tu pregunta:",
    moved: "Esta conversación sigue en español aquí: {link}",
    used: "Ya cambiaste tu idioma una vez. Un moderador puede cambiarlo de nuevo; toca el botón de abajo.",
  },
  pt: {
    offer: "Parece que outro idioma é melhor para você. Toque no seu idioma abaixo e eu mudo o servidor para ele.",
    confirm: "Mudar o idioma do servidor para {lang}? Seus canais passam para {lang} e sua verificação de UID continua valendo.",
    confirmButton: "Sim, mudar",
    cancelButton: "Cancelar",
    cancelled: "Tudo bem, nada mudou.",
    switched: "Pronto, o idioma do seu servidor agora é português. Seu tópico de ajuda continua aqui: {link}",
    verifyHint: "Para liberar todo o Trading Floor, toque em “Verificar meu UID” em qualquer canal 🔒.",
    keptVerified: "Você continua verificado, então não precisa fazer mais nada.",
    intro: "Olá {user}, o idioma do seu servidor agora é {lang}. Aqui está a resposta para a sua pergunta:",
    moved: "Esta conversa continua em português aqui: {link}",
    used: "Você já mudou seu idioma uma vez. Um moderador pode mudar de novo; toque no botão abaixo.",
  },
  tr: {
    offer: "Başka bir dil size daha uygun görünüyor. Aşağıdan dilinize dokunun, sunucuyu sizin için o dile çevireyim.",
    confirm: "Sunucu dilinizi {lang} olarak değiştirmek ister misiniz? Kanallarınız {lang} olur ve UID doğrulamanız korunur.",
    confirmButton: "Evet, değiştir",
    cancelButton: "İptal",
    cancelled: "Tamam, hiçbir şey değişmedi.",
    switched: "Tamam, sunucu diliniz artık Türkçe. Yardım konunuz burada devam ediyor: {link}",
    verifyHint: "Tüm Trading Floor'u açmak için herhangi bir 🔒 kanalında “UID'mi doğrula”ya basın.",
    keptVerified: "Doğrulamanız devam ediyor, başka bir şey yapmanıza gerek yok.",
    intro: "Merhaba {user}, sunucu diliniz artık {lang}. Sorunuzun cevabı:",
    moved: "Bu konuşma burada Türkçe devam ediyor: {link}",
    used: "Dilinizi zaten bir kez değiştirdiniz. Bir moderatör tekrar değiştirebilir; aşağıdaki düğmeye dokunun.",
  },
  ru: {
    offer: "Похоже, вам удобнее другой язык. Нажмите на свой язык ниже, и я переключу сервер на него.",
    confirm: "Сменить язык сервера на {lang}? Ваши каналы перейдут на {lang}, а подтверждение UID сохранится.",
    confirmButton: "Да, сменить",
    cancelButton: "Отмена",
    cancelled: "Хорошо, ничего не изменилось.",
    switched: "Готово, язык вашего сервера теперь русский. Ваша ветка помощи продолжается здесь: {link}",
    verifyHint: "Чтобы открыть весь Trading Floor, нажмите «Подтвердить UID» в любом 🔒 канале.",
    keptVerified: "Ваше подтверждение сохранилось, больше ничего делать не нужно.",
    intro: "Здравствуйте, {user}, язык вашего сервера теперь {lang}. Вот ответ на ваш вопрос:",
    moved: "Разговор продолжается на русском здесь: {link}",
    used: "Вы уже один раз меняли язык сами. Модератор может сменить его снова; нажмите кнопку ниже.",
  },
  ja: {
    offer: "別の言語のほうが使いやすいようですね。下からご自身の言語を押していただければ、サーバーの言語を切り替えます。",
    confirm: "サーバーの言語を{lang}に切り替えますか？チャンネルが{lang}に変わり、UID認証はそのまま引き継がれます。",
    confirmButton: "はい、切り替えます",
    cancelButton: "キャンセル",
    cancelled: "承知しました。何も変更していません。",
    switched: "完了しました。サーバーの言語は日本語になりました。ヘルプスレッドはこちらで続きます：{link}",
    verifyHint: "Trading Floor 全体を開くには、🔒 チャンネルの「UIDを認証する」を押してください。",
    keptVerified: "認証はそのままですので、ほかに必要な操作はありません。",
    intro: "{user} さん、サーバーの言語は{lang}になりました。ご質問への回答です：",
    moved: "この会話は日本語でこちらに続きます：{link}",
    used: "言語はすでに一度ご自身で変更されています。モデレーターがもう一度変更できますので、下のボタンを押してください。",
  },
};

/** The language buttons: every language but the current one, the suggested one first. Two rows of up to five. */
export function switchButtons(current: Lang, suggested: Lang | null) {
  const order = [...(suggested && suggested !== current ? [suggested] : []), ...LANGS.filter((l) => l !== current && l !== suggested)];
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < order.length; i += 5) {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      order.slice(i, i + 5).map((l) => new ButtonBuilder().setCustomId(`${SWITCH_PICK}${l}`).setLabel(LANG_BUTTONS[l].label).setEmoji(LANG_BUTTONS[l].emoji).setStyle(ButtonStyle.Primary)),
    ));
  }
  return rows;
}

/** Yes/cancel for a verified member, written in the language they tapped. */
export function confirmButtons(lang: Lang) {
  const t = SWITCH_TEXT[lang];
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${SWITCH_CONFIRM}${lang}`).setLabel(t.confirmButton).setEmoji(LANG_BUTTONS[lang].emoji).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`${SWITCH_CANCEL}${lang}`).setLabel(t.cancelButton).setStyle(ButtonStyle.Primary),
  )];
}
