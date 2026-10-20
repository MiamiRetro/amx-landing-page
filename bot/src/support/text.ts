import type { Lang } from "../config.js";

export interface SupportText {
  panelTitle: string;
  panelBody: string;
  openButton: string;
  /** First message in a new thread; {user} is the member's mention. */
  intro: string;
  humanButton: string;
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
    panelBody: "Press the button to open a private thread with the support assistant. It answers common questions straight away, and brings in a moderator when it can't.",
    openButton: "Get help",
    intro: "Hi {user}, what can I help with? Ask your question here. Only you and the moderators can see this thread.",
    humanButton: "Talk to a mod",
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
    panelBody: "点击按钮，与支持助手开启一个私密话题。常见问题会立即解答，解答不了时会请管理员加入。",
    openButton: "获取帮助",
    intro: "你好 {user}，有什么可以帮你？请在这里提问。只有你和管理员能看到这个话题。",
    humanButton: "联系管理员",
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
    panelBody: "버튼을 누르면 지원 도우미와 비공개 스레드가 열립니다. 자주 묻는 질문은 바로 답하고, 답할 수 없으면 운영진을 불러옵니다.",
    openButton: "도움 받기",
    intro: "안녕하세요 {user}님, 무엇을 도와드릴까요? 여기에 질문을 남겨 주세요. 이 스레드는 본인과 운영진만 볼 수 있어요.",
    humanButton: "운영진 연결",
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
    panelBody: "Tekan tombol untuk membuka thread pribadi dengan asisten support. Pertanyaan umum langsung dijawab, dan moderator dipanggil kalau asisten tidak bisa menjawab.",
    openButton: "Minta bantuan",
    intro: "Halo {user}, ada yang bisa dibantu? Tulis pertanyaanmu di sini. Thread ini hanya bisa dilihat kamu dan moderator.",
    humanButton: "Hubungi moderator",
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
    panelBody: "Bấm nút để mở một luồng riêng với trợ lý hỗ trợ. Câu hỏi thường gặp được trả lời ngay, và trợ lý sẽ gọi quản trị viên khi không trả lời được.",
    openButton: "Nhận hỗ trợ",
    intro: "Chào {user}, mình có thể giúp gì? Hãy đặt câu hỏi ở đây. Chỉ bạn và quản trị viên thấy được luồng này.",
    humanButton: "Gặp quản trị viên",
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
    panelBody: "Pulsa el botón para abrir un hilo privado con el asistente de soporte. Responde al momento las preguntas frecuentes y llama a un moderador cuando no puede.",
    openButton: "Pedir ayuda",
    intro: "Hola {user}, ¿en qué te ayudo? Escribe tu pregunta aquí. Solo tú y los moderadores ven este hilo.",
    humanButton: "Hablar con un mod",
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
    panelBody: "Toque no botão para abrir um tópico privado com o assistente de suporte. Ele responde na hora as perguntas frequentes e chama um moderador quando não consegue.",
    openButton: "Pedir ajuda",
    intro: "Oi {user}, como posso ajudar? Escreva sua pergunta aqui. Só você e os moderadores veem este tópico.",
    humanButton: "Falar com um mod",
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
    panelBody: "Destek asistanıyla özel bir alt başlık açmak için butona bas. Sık sorulan soruları hemen yanıtlar, yanıtlayamadığında bir moderatör çağırır.",
    openButton: "Yardım al",
    intro: "Merhaba {user}, nasıl yardımcı olabilirim? Sorunu buraya yaz. Bu alt başlığı yalnızca sen ve moderatörler görebilir.",
    humanButton: "Moderatöre bağlan",
    closeButton: "Kapat",
    handedOff: "{mods} bir üyenin yardıma ihtiyacı var. Bir moderatör bu alt başlıkta yanıt verecek.",
    already: "Zaten açık bir yardım alt başlığın var. Geri dönmek için {link} bağlantısına ya da aşağıdaki butona dokun.",
    opened: "Yardım alt başlığın hazır. Girmek için {link} bağlantısına ya da aşağıdaki butona dokun, sonra sorunu oraya yaz.",
    goButton: "Yardım alt başlığımı aç",
    closed: "Bu alt başlık kapatıldı. İstediğin zaman yardım kanalında Yardım al'a basarak yenisini açabilirsin.",
    unavailable: "Asistan şu an çevrimdışı, bir moderatör çağırdım.",
  },
  ru: {
    panelTitle: "Нужна помощь?",
    panelBody: "Нажмите кнопку, чтобы открыть личную ветку с ассистентом поддержки. Он сразу отвечает на частые вопросы, а если не может, зовёт модератора.",
    openButton: "Получить помощь",
    intro: "Здравствуйте, {user}! Чем помочь? Задайте вопрос здесь. Эту ветку видите только вы и модераторы.",
    humanButton: "Позвать модератора",
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
    panelBody: "ボタンを押すと、サポートアシスタントとの非公開スレッドが開きます。よくある質問にはすぐ答え、答えられないときはモデレーターを呼びます。",
    openButton: "ヘルプを依頼",
    intro: "{user} さん、こんにちは。どうしましたか？ここに質問を書いてください。このスレッドはあなたとモデレーターだけが見られます。",
    humanButton: "モデレーターと話す",
    closeButton: "閉じる",
    handedOff: "{mods} サポートが必要なメンバーがいます。モデレーターがこのスレッドで返信します。",
    already: "すでに開いているヘルプスレッドがあります。{link} か下のボタンをタップして戻れます。",
    opened: "ヘルプスレッドの準備ができました。{link} か下のボタンをタップして移動し、そこに質問を書いてください。",
    goButton: "ヘルプスレッドを開く",
    closed: "このスレッドは閉じられました。いつでもヘルプチャンネルの「ヘルプを依頼」から新しく開けます。",
    unavailable: "アシスタントが今オフラインのため、モデレーターを呼びました。",
  },
};
