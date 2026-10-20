import type { Lang } from "../config.js";

export interface SupportText {
  panelTitle: string;
  panelBody: string;
  openButton: string;
  /** First message in a new thread; {user} is the member's mention. */
  intro: string;
  humanButton: string;
  /** Added under an answer when the bot, not the assistant, decides to show the moderator button. */
  offerHint: string;
  closeButton: string;
  /** Posted when the thread goes to the moderators; {mods} is the role mention. */
  handedOff: string;
  /** Ephemeral reply when the member already has an open thread; {link} is its URL. */
  already: string;
  /** Ephemeral reply once the thread is made; {link} is its URL. */
  opened: string;
  /** Link button under the opened/already reply, for people new to Discord. */
  goButton: string;
  closed: string;
  /** The assistant could not be reached; the thread goes straight to a moderator. */
  unavailable: string;
}

/** Help-desk copy per language. The assistant's answers are written in the member's language by the model. */
export const SUPPORT_TEXT: Record<Lang, SupportText> = {
  en: {
    panelTitle: "Need help?",
    panelBody: "Press the button to open a private thread with the support assistant. It answers your questions straight away and walks you through anything you're stuck on.",
    openButton: "Get help",
    intro: "Hi {user}, what can I help with? Ask your question here. This thread is private.",
    humanButton: "Talk to a mod",
    offerHint: "If you'd like a person to take a look, tap the button below.",
    closeButton: "Close",
    handedOff: "{mods} a member needs a hand here. A moderator will reply in this thread.",
    already: "You already have a help thread open. Tap {link} or the button below to go back to it.",
    opened: "Your help thread is ready. Tap {link} or the button below to go to it, then type your question there.",
    goButton: "Open my help thread",
    closed: "This thread is closed. Press Get help in help-desk any time to open a new one.",
    unavailable: "The assistant is offline right now, so I've asked a moderator to join.",
  },
  zh: {
    panelTitle: "需要帮助？",
    panelBody: "点击按钮，与支持助手开启一个私密话题。它会立即回答你的问题，并一步步带你解决遇到的困难。",
    openButton: "获取帮助",
    intro: "你好 {user}，有什么可以帮你？请在这里提问。这个话题是私密的。",
    humanButton: "联系管理员",
    offerHint: "如果你希望由真人来帮你看看，请点下面的按钮。",
    closeButton: "关闭",
    handedOff: "{mods} 有成员需要帮助，管理员会在这个话题里回复。",
    already: "你已经有一个打开的帮助话题。点击 {link} 或下面的按钮回到话题。",
    opened: "你的帮助话题已开启。点击 {link} 或下面的按钮进入话题，然后在里面输入你的问题。",
    goButton: "打开我的帮助话题",
    closed: "这个话题已关闭。需要时可随时在帮助台点击「获取帮助」开启新话题。",
    unavailable: "助手暂时离线，我已请管理员加入。",
  },
  ko: {
    panelTitle: "도움이 필요하신가요?",
    panelBody: "버튼을 누르면 지원 도우미와 비공개 스레드가 열립니다. 질문에 바로 답하고, 막히는 부분을 단계별로 안내해 드려요.",
    openButton: "도움 받기",
    intro: "안녕하세요 {user}님, 무엇을 도와드릴까요? 여기에 질문을 남겨 주세요. 이 스레드는 비공개예요.",
    humanButton: "운영진 연결",
    offerHint: "직접 사람이 확인해 드리길 원하시면 아래 버튼을 눌러 주세요.",
    closeButton: "닫기",
    handedOff: "{mods} 도움이 필요한 멤버가 있어요. 운영진이 이 스레드에서 답변해 드릴 거예요.",
    already: "이미 열려 있는 도움 스레드가 있어요. {link} 또는 아래 버튼을 눌러 돌아가세요.",
    opened: "도움 스레드가 준비됐어요. {link} 또는 아래 버튼을 눌러 이동한 뒤, 거기에 질문을 입력해 주세요.",
    goButton: "내 도움 스레드 열기",
    closed: "이 스레드는 닫혔어요. 필요하면 언제든 도움말 채널에서 「도움 받기」를 눌러 새로 여세요.",
    unavailable: "도우미가 지금 오프라인이라 운영진을 불렀어요.",
  },
  id: {
    panelTitle: "Butuh bantuan?",
    panelBody: "Tekan tombol untuk membuka thread pribadi dengan asisten support. Pertanyaanmu langsung dijawab, dan kamu dipandu langkah demi langkah.",
    openButton: "Minta bantuan",
    intro: "Halo {user}, ada yang bisa dibantu? Tulis pertanyaanmu di sini. Thread ini bersifat pribadi.",
    humanButton: "Hubungi moderator",
    offerHint: "Kalau kamu ingin dibantu langsung oleh tim, tekan tombol di bawah.",
    closeButton: "Tutup",
    handedOff: "{mods} ada member yang butuh bantuan. Moderator akan membalas di thread ini.",
    already: "Kamu sudah punya thread bantuan yang terbuka. Ketuk {link} atau tombol di bawah untuk kembali ke sana.",
    opened: "Thread bantuanmu sudah siap. Ketuk {link} atau tombol di bawah untuk masuk, lalu tulis pertanyaanmu di sana.",
    goButton: "Buka thread bantuanku",
    closed: "Thread ini sudah ditutup. Tekan Minta bantuan di kanal bantuan kapan saja untuk membuka yang baru.",
    unavailable: "Asisten sedang offline, jadi saya sudah memanggil moderator.",
  },
  vi: {
    panelTitle: "Cần hỗ trợ?",
    panelBody: "Bấm nút để mở một luồng riêng với trợ lý hỗ trợ. Trợ lý trả lời ngay câu hỏi của bạn và hướng dẫn bạn từng bước.",
    openButton: "Nhận hỗ trợ",
    intro: "Chào {user}, mình có thể giúp gì cho bạn? Hãy đặt câu hỏi ở đây. Luồng này là riêng tư.",
    humanButton: "Gặp quản trị viên",
    offerHint: "Nếu bạn muốn có người trực tiếp xem giúp, hãy bấm nút bên dưới.",
    closeButton: "Đóng",
    handedOff: "{mods} có thành viên cần hỗ trợ. Quản trị viên sẽ trả lời trong luồng này.",
    already: "Bạn đã có một luồng hỗ trợ đang mở. Chạm vào {link} hoặc nút bên dưới để quay lại.",
    opened: "Luồng hỗ trợ của bạn đã sẵn sàng. Chạm vào {link} hoặc nút bên dưới để vào, rồi gõ câu hỏi ở đó.",
    goButton: "Mở luồng hỗ trợ của tôi",
    closed: "Luồng này đã đóng. Bấm Nhận hỗ trợ trong kênh hỗ trợ bất cứ lúc nào để mở luồng mới.",
    unavailable: "Trợ lý đang ngoại tuyến, mình đã gọi quản trị viên vào.",
  },
  es: {
    panelTitle: "¿Necesitas ayuda?",
    panelBody: "Pulsa el botón para abrir un hilo privado con el asistente de soporte. Responde tus preguntas al momento y te guía paso a paso.",
    openButton: "Pedir ayuda",
    intro: "Hola {user}, ¿en qué te ayudo? Escribe tu pregunta aquí. Este hilo es privado.",
    humanButton: "Hablar con un mod",
    offerHint: "Si prefieres que lo revise una persona, pulsa el botón de abajo.",
    closeButton: "Cerrar",
    handedOff: "{mods} un miembro necesita ayuda. Un moderador responderá en este hilo.",
    already: "Ya tienes un hilo de ayuda abierto. Toca {link} o el botón de abajo para volver a él.",
    opened: "Tu hilo de ayuda está listo. Toca {link} o el botón de abajo para entrar y escribe ahí tu pregunta.",
    goButton: "Abrir mi hilo de ayuda",
    closed: "Este hilo está cerrado. Pulsa Pedir ayuda en el canal de ayuda cuando quieras abrir otro.",
    unavailable: "El asistente no está disponible ahora, así que he llamado a un moderador.",
  },
  pt: {
    panelTitle: "Precisa de ajuda?",
    panelBody: "Toque no botão para abrir um tópico privado com o assistente de suporte. Ele responde suas perguntas na hora e te guia passo a passo.",
    openButton: "Pedir ajuda",
    intro: "Oi {user}, como posso ajudar? Escreva sua pergunta aqui. Este tópico é privado.",
    humanButton: "Falar com um mod",
    offerHint: "Se preferir que uma pessoa veja isso, toque no botão abaixo.",
    closeButton: "Fechar",
    handedOff: "{mods} um membro precisa de ajuda. Um moderador vai responder neste tópico.",
    already: "Você já tem um tópico de ajuda aberto. Toque em {link} ou no botão abaixo para voltar a ele.",
    opened: "Seu tópico de ajuda está pronto. Toque em {link} ou no botão abaixo para entrar e escreva sua pergunta lá.",
    goButton: "Abrir meu tópico de ajuda",
    closed: "Este tópico foi fechado. Toque em Pedir ajuda no canal de ajuda quando quiser abrir outro.",
    unavailable: "O assistente está fora do ar agora, então chamei um moderador.",
  },
  tr: {
    panelTitle: "Yardım mı lazım?",
    panelBody: "Destek asistanıyla özel bir alt başlık açmak için butona basın. Sorularınızı hemen yanıtlar ve takıldığınız yerde adım adım yol gösterir.",
    openButton: "Yardım al",
    intro: "Merhaba {user}, size nasıl yardımcı olabilirim? Sorunuzu buraya yazın. Bu alt başlık özeldir.",
    humanButton: "Moderatöre bağlan",
    offerHint: "Bir kişinin bakmasını isterseniz aşağıdaki butona dokunun.",
    closeButton: "Kapat",
    handedOff: "{mods} bir üyenin yardıma ihtiyacı var. Bir moderatör bu alt başlıkta yanıt verecek.",
    already: "Zaten açık bir yardım alt başlığınız var. Geri dönmek için {link} bağlantısına ya da aşağıdaki butona dokunun.",
    opened: "Yardım alt başlığınız hazır. Girmek için {link} bağlantısına ya da aşağıdaki butona dokunun, sonra sorunuzu oraya yazın.",
    goButton: "Yardım alt başlığımı aç",
    closed: "Bu alt başlık kapatıldı. İstediğiniz zaman yardım kanalında Yardım al'a basarak yenisini açabilirsiniz.",
    unavailable: "Asistan şu an çevrimdışı, bir moderatör çağırdım.",
  },
  ru: {
    panelTitle: "Нужна помощь?",
    panelBody: "Нажмите кнопку, чтобы открыть личную ветку с ассистентом поддержки. Он сразу отвечает на ваши вопросы и пошагово помогает разобраться.",
    openButton: "Получить помощь",
    intro: "Здравствуйте, {user}! Чем помочь? Задайте вопрос здесь. Эта ветка личная.",
    humanButton: "Позвать модератора",
    offerHint: "Если хотите, чтобы этим занялся человек, нажмите кнопку ниже.",
    closeButton: "Закрыть",
    handedOff: "{mods} участнику нужна помощь. Модератор ответит в этой ветке.",
    already: "У вас уже есть открытая ветка помощи. Нажмите {link} или кнопку ниже, чтобы вернуться в неё.",
    opened: "Ваша ветка помощи готова. Нажмите {link} или кнопку ниже, чтобы перейти в неё, и напишите там свой вопрос.",
    goButton: "Открыть мою ветку помощи",
    closed: "Ветка закрыта. Нажмите «Получить помощь» в канале помощи, чтобы открыть новую.",
    unavailable: "Ассистент сейчас недоступен, поэтому я позвал модератора.",
  },
  ja: {
    panelTitle: "お困りですか？",
    panelBody: "ボタンを押すと、サポートアシスタントとの非公開スレッドが開きます。質問にすぐ答え、つまずいているところを一つずつ案内します。",
    openButton: "ヘルプを依頼",
    intro: "{user} さん、こんにちは。どうしましたか？ここに質問を書いてください。このスレッドは非公開です。",
    humanButton: "モデレーターと話す",
    offerHint: "担当者に確認してほしい場合は、下のボタンを押してください。",
    closeButton: "閉じる",
    handedOff: "{mods} サポートが必要なメンバーがいます。モデレーターがこのスレッドで返信します。",
    already: "すでに開いているヘルプスレッドがあります。{link} か下のボタンをタップして戻れます。",
    opened: "ヘルプスレッドの準備ができました。{link} か下のボタンをタップして移動し、そこに質問を書いてください。",
    goButton: "ヘルプスレッドを開く",
    closed: "このスレッドは閉じられました。いつでもヘルプチャンネルの「ヘルプを依頼」から新しく開けます。",
    unavailable: "アシスタントが今オフラインのため、モデレーターを呼びました。",
  },
};
