/**
 * The migration-night announcements, posted by the bot into every language's
 * announcements channel, each in that channel's language. The bot never
 * mirrors its own posts, so it writes all ten itself.
 *
 *   npx tsx scripts/announce.ts --post progress            # dry run: shows where each would go
 *   npx tsx scripts/announce.ts --post progress --apply    # 20:00 UTC, as the window opens (no ping)
 *   npx tsx scripts/announce.ts --post live --apply        # once the final checks pass (@everyone)
 *   npx tsx scripts/announce.ts --post mess --apply        # before the window: "pardon our mess", with its
 *                                                          # infographic (assets/announce), in the languages it has
 *
 * Each person only sees their own language's announcements channel, so the
 * @everyone in "live" pings everyone once. The bot is given Mention @everyone
 * on those channels alone (a channel overwrite), never server-wide.
 * Re-running skips a channel that already has the post.
 */
import { PermissionFlagsBits as P, OverwriteType, ChannelType, type TextChannel, type NewsChannel } from "discord.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LANGS, type Lang } from "../src/config.js";
import { connect } from "../src/lib/client.js";

/** Each language's announcements channel, as the onboarding script names it (a ┣ may come in front). */
const CHANNEL: Record<Lang, string> = {
  en: "📢・announcements", zh: "📢・公告", ko: "📢・공지사항", id: "📢・pengumuman", vi: "📢・thông-báo",
  es: "📢・anuncios", pt: "📢・anúncios", tr: "📢・duyurular", ru: "📢・объявления", ja: "📢・お知らせ",
};

const PROGRESS: Record<Lang, string> = {
  en: "🛠️ **The upgrade has started.** Channels are moving for the next few hours. Hang tight, we'll post here as soon as the new Trading Floor is live. ⚡",
  zh: "🛠️ **升级已经开始。** 接下来几个小时频道会陆续调整。请稍候，新的交易大厅上线后我们会第一时间在这里通知。⚡",
  ko: "🛠️ **업그레이드가 시작됐습니다.** 앞으로 몇 시간 동안 채널이 이동합니다. 조금만 기다려 주세요. 새 트레이딩 플로어가 열리면 바로 여기에 알려드릴게요. ⚡",
  id: "🛠️ **Upgrade sudah dimulai.** Kanal-kanal akan berpindah selama beberapa jam ke depan. Tunggu sebentar, kami akan kabari di sini begitu Trading Floor yang baru aktif. ⚡",
  vi: "🛠️ **Quá trình nâng cấp đã bắt đầu.** Các kênh sẽ được sắp xếp lại trong vài giờ tới. Bạn chờ chút nhé, chúng tôi sẽ báo ngay tại đây khi Trading Floor mới hoạt động. ⚡",
  es: "🛠️ **La actualización ha comenzado.** Los canales se moverán durante las próximas horas. Aguanta un poco, avisaremos aquí en cuanto el nuevo Trading Floor esté en marcha. ⚡",
  pt: "🛠️ **A atualização começou.** Os canais vão mudar de lugar nas próximas horas. Aguenta aí, avisamos aqui assim que o novo Trading Floor estiver no ar. ⚡",
  tr: "🛠️ **Güncelleme başladı.** Önümüzdeki birkaç saat boyunca kanallar yer değiştirecek. Biraz sabır, yeni Trading Floor açılır açılmaz burada haber vereceğiz. ⚡",
  ru: "🛠️ **Обновление началось.** В ближайшие несколько часов каналы будут переезжать. Немного терпения: как только новый Trading Floor заработает, мы сообщим здесь. ⚡",
  ja: "🛠️ **アップグレードを開始しました。** これから数時間、チャンネルの移動が続きます。新しいTrading Floorが公開され次第、ここでお知らせします。しばらくお待ちください。⚡",
};

const LIVE: Record<Lang, string[]> = {
  en: [
    "✅ **The new BLKBöX Trading Floor is live** 🌐",
    "🧭 Start with the **Server Guide** at the top. It shows where everything is.",
    "🔔 Pick your notifications there too, so you only hear about what you care about.",
    "🟢 Check **AlphanumetriX** for the latest signals and the 3-light board.",
    "🌍 You're in **English** by default. To switch, open a thread in **help-desk** and tap your language.",
    "☎️ Need help? **Help-desk** opens a private thread just for you.",
    "10 languages. One trading floor. Zero lost in translation. 🚀",
  ],
  zh: [
    "✅ **全新的 BLKBöX 交易大厅正式上线** 🌐",
    "🧭 从顶部的 **服务器指南** 开始，所有频道一目了然。",
    "🔔 也可以在那里设置通知，只接收你关心的内容。",
    "🟢 前往 **AlphanumetriX** 查看最新信号和三灯看板。",
    "🌍 想换语言？在 **帮助台** 开一个帖子，点选你的语言即可。",
    "☎️ 需要帮助？**帮助台** 会为你单独开一个私密帖子。",
    "10 种语言，一个交易大厅，沟通零障碍。🚀",
  ],
  ko: [
    "✅ **새로운 BLKBöX 트레이딩 플로어가 열렸습니다** 🌐",
    "🧭 맨 위의 **서버 가이드**부터 확인하세요. 모든 채널의 위치가 나와 있어요.",
    "🔔 알림도 거기서 고르면, 관심 있는 소식만 받을 수 있어요.",
    "🟢 **AlphanumetriX**에서 최신 시그널과 3색 신호등 보드를 확인하세요.",
    "🌍 다른 언어로 바꾸고 싶다면 **도움말** 채널에서 스레드를 열고 언어를 누르세요.",
    "☎️ 도움이 필요하세요? **도움말** 채널에서 나만의 비공개 스레드가 열립니다.",
    "10개 언어. 하나의 트레이딩 플로어. 번역 손실 제로. 🚀",
  ],
  id: [
    "✅ **Trading Floor BLKBöX yang baru sudah aktif** 🌐",
    "🧭 Mulai dari **Panduan Server** di paling atas. Semua kanal ada di sana.",
    "🔔 Atur notifikasimu di sana juga, supaya kamu hanya dapat kabar yang penting buatmu.",
    "🟢 Cek **AlphanumetriX** untuk sinyal terbaru dan papan 3 lampu.",
    "🌍 Mau ganti bahasa? Buka thread di **bantuan** lalu ketuk bahasamu.",
    "☎️ Butuh bantuan? **Bantuan** membuka thread pribadi khusus untukmu.",
    "10 bahasa. Satu trading floor. Tidak ada yang hilang dalam terjemahan. 🚀",
  ],
  vi: [
    "✅ **Trading Floor mới của BLKBöX đã chính thức hoạt động** 🌐",
    "🧭 Bắt đầu với **Hướng dẫn server** ở trên cùng, mọi kênh đều có ở đó.",
    "🔔 Chọn luôn thông báo ở đó để chỉ nhận những gì bạn quan tâm.",
    "🟢 Xem **AlphanumetriX** để cập nhật tín hiệu mới nhất và bảng 3 đèn.",
    "🌍 Muốn đổi ngôn ngữ? Mở một thread trong **hỗ trợ** và chọn ngôn ngữ của bạn.",
    "☎️ Cần giúp đỡ? **Hỗ trợ** sẽ mở một thread riêng chỉ dành cho bạn.",
    "10 ngôn ngữ. Một Trading Floor. Không gì bị mất khi dịch. 🚀",
  ],
  es: [
    "✅ **El nuevo Trading Floor de BLKBöX ya está en marcha** 🌐",
    "🧭 Empieza por la **Guía del servidor**, arriba del todo. Ahí verás dónde está cada cosa.",
    "🔔 Elige también tus notificaciones ahí, para enterarte solo de lo que te interesa.",
    "🟢 Mira **AlphanumetriX** para ver las últimas señales y el tablero de 3 luces.",
    "🌍 ¿Quieres otro idioma? Abre un hilo en **ayuda** y toca tu idioma.",
    "☎️ ¿Necesitas ayuda? **Ayuda** abre un hilo privado solo para ti.",
    "10 idiomas. Un solo Trading Floor. Nada se pierde en la traducción. 🚀",
  ],
  pt: [
    "✅ **O novo Trading Floor da BLKBöX está no ar** 🌐",
    "🧭 Comece pelo **Guia do servidor**, lá no topo. Ele mostra onde fica tudo.",
    "🔔 Escolha suas notificações lá também, para receber só o que te interessa.",
    "🟢 Confira o **AlphanumetriX** para ver os sinais mais recentes e o painel de 3 luzes.",
    "🌍 Quer outro idioma? Abra um tópico em **ajuda** e toque no seu idioma.",
    "☎️ Precisa de ajuda? **Ajuda** abre um tópico privado só para você.",
    "10 idiomas. Um só Trading Floor. Nada se perde na tradução. 🚀",
  ],
  tr: [
    "✅ **Yeni BLKBöX Trading Floor yayında** 🌐",
    "🧭 En üstteki **Sunucu Rehberi** ile başla. Her şeyin nerede olduğunu gösteriyor.",
    "🔔 Bildirimlerini de oradan seç, sadece ilgilendiğin şeylerden haberdar ol.",
    "🟢 En yeni sinyaller ve 3 ışıklı pano için **AlphanumetriX**'e göz at.",
    "🌍 Başka bir dil mi istiyorsun? **Yardım** kanalında bir konu aç ve dilini seç.",
    "☎️ Yardıma mı ihtiyacın var? **Yardım** sana özel bir konu açar.",
    "10 dil. Tek bir Trading Floor. Çeviride hiçbir şey kaybolmaz. 🚀",
  ],
  ru: [
    "✅ **Новый BLKBöX Trading Floor запущен** 🌐",
    "🧭 Начните с **Гида по серверу** в самом верху: там видно, где что находится.",
    "🔔 Там же выберите уведомления, чтобы получать только то, что вам интересно.",
    "🟢 Загляните в **AlphanumetriX**: свежие сигналы и табло из трёх огней.",
    "🌍 Нужен другой язык? Откройте ветку в канале **помощь** и выберите свой язык.",
    "☎️ Нужна помощь? **Помощь** откроет личную ветку только для вас.",
    "10 языков. Один Trading Floor. Ничего не теряется при переводе. 🚀",
  ],
  ja: [
    "✅ **新しい BLKBöX Trading Floor がオープンしました** 🌐",
    "🧭 まずは一番上の **サーバーガイド** から。どこに何があるか一目でわかります。",
    "🔔 通知もそこで選べるので、気になる情報だけを受け取れます。",
    "🟢 最新シグナルと3灯ボードは **AlphanumetriX** でチェック。",
    "🌍 言語を変えたいときは、**ヘルプ** でスレッドを開いて言語を選んでください。",
    "☎️ お困りですか？**ヘルプ** ではあなた専用の非公開スレッドが開きます。",
    "10言語。ひとつのTrading Floor。翻訳で失われるものはゼロ。🚀",
  ],
};

/** "Pardon our mess": text and infographic per language, from assets/announce (render.mjs draws the images). */
const ANNOUNCE = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "announce");
const MESS = JSON.parse(readFileSync(join(ANNOUNCE, "mess.json"), "utf8")) as Partial<Record<Lang, { text: string[] }>>;

type Post = { ping: boolean; text: (l: Lang) => string | null; file?: (l: Lang) => string };
const POSTS: Record<string, Post> = {
  progress: { ping: false, text: (l) => PROGRESS[l] },
  live: { ping: true, text: (l) => ["@everyone", "", LIVE[l][0], "", ...LIVE[l].slice(1, -1), "", LIVE[l].at(-1)!].join("\n") },
  mess: { ping: false, text: (l) => MESS[l]?.text.join("\n") ?? null, file: (l) => join(ANNOUNCE, `mess-${l}.png`) },
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : undefined;
}

async function main() {
  const which = arg("post");
  if (!which || !(which in POSTS)) throw new Error(`--post must be one of ${Object.keys(POSTS).join(", ")}`);
  const apply = process.argv.includes("--apply");
  const post = POSTS[which];
  const { client, guild } = await connect();
  try {
    console.log(`${apply ? "POSTING" : "DRY RUN (add --apply to post)"} "${which}" on ${guild.name}`);
    const me = guild.members.me ?? (await guild.members.fetchMe());
    let missing = 0;
    for (const lang of LANGS) {
      const ch = guild.channels.cache.find(
        (c): c is TextChannel | NewsChannel =>
          (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement) && c.name.replace(/^[┣┗]/u, "") === CHANNEL[lang],
      );
      if (!ch) { console.log(`  ${lang}: no #${CHANNEL[lang]} (skipped)`); if (which === "live") missing++; continue; }
      const text = post.text(lang);
      if (text === null) { console.log(`  ${lang}: no text for "${which}" (skipped)`); continue; }
      // Already posted: the bot's own message with the same headline in the last day.
      const headline = text.split("\n").find((l) => l && l !== "@everyone")!;
      const recent = await ch.messages.fetch({ limit: 30 }).catch(() => null);
      if (recent?.some((m) => m.author.id === me.id && m.content.includes(headline) && Date.now() - m.createdTimestamp < 86_400_000)) {
        console.log(`  ${lang}: already posted in #${ch.name}`);
        continue;
      }
      const canPing = ch.permissionsFor(me).has(P.MentionEveryone);
      console.log(`  ${lang}: post in #${ch.name}${post.ping && !canPing ? " (first allows the bot to @everyone in this channel)" : ""}`);
      if (!apply) continue;
      if (post.ping && !canPing) {
        await ch.permissionOverwrites.edit(me.id, { MentionEveryone: true }, { type: OverwriteType.Member, reason: "migration announcement" });
      }
      await ch.send({ content: text, files: post.file ? [{ attachment: post.file(lang), name: `${which}-${lang}.png` }] : [], allowedMentions: { parse: post.ping ? ["everyone"] : [] } });
    }
    if (missing) console.log(`\n! ${missing} language(s) had no announcements channel: has the migration's channels step run?`);
  } finally {
    await client.destroy();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });
