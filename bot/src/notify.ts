import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  StringSelectMenuBuilder,
  type ButtonInteraction,
  type Guild,
  type Role,
  type StringSelectMenuInteraction,
} from "discord.js";
import type { Lang } from "./config.js";
import type { Db } from "./db/index.js";
import { errInfo, log } from "./log.js";
import type { LanguageRoles } from "./roles.js";

/**
 * The notification center: members pick which pings they want, and each pick
 * is a role. Moderators and alert bots mention the role instead of @everyone,
 * and the mirror carries the mention into every language's copy, so each
 * member is pinged once, in their own language.
 */
export const NOTIFY_OPEN = "notify:open";
export const NOTIFY_SET = "notify:set";
export const NOTIFY_PREFIX = "notify:";

export const NOTIFY_TOPICS = ["announcements", "alphanumetrix", "botalerts", "tradealerts", "events", "videos"] as const;
export type NotifyTopic = (typeof NOTIFY_TOPICS)[number];

/** Role per topic. The names are what moderators type after @, so they stay English. */
export const NOTIFY_ROLES: Record<NotifyTopic, { name: string; emoji: string }> = {
  announcements: { name: "🔔 Announcements", emoji: "📢" },
  alphanumetrix: { name: "🔔 AlphanumetriX", emoji: "🟢" },
  botalerts: { name: "🔔 Bot Alerts", emoji: "🤖" },
  tradealerts: { name: "🔔 Trade Alerts", emoji: "⚡" },
  events: { name: "🔔 Events & Giveaways", emoji: "🎉" },
  videos: { name: "🔔 Videos & Streams", emoji: "📺" },
};

interface NotifyText {
  title: string;
  body: string;
  button: string;
  pick: string;
  placeholder: string;
  saved: string;
  none: string;
  verifiedOnly: string;
  topics: Record<NotifyTopic, [label: string, description: string]>;
}

export const NOTIFY_TEXT: Record<Lang, NotifyText> = {
  en: {
    title: "### 🔔 Notifications",
    body: "We never ping @everyone. Pick the pings you want, change them any time.",
    button: "Choose notifications",
    pick: "Pick what you want to be pinged for. Untick anything to stop it.",
    placeholder: "Choose your notifications",
    saved: "Saved. You'll be pinged for: {list}",
    none: "Saved. You won't be pinged for anything.",
    verifiedOnly: "(verified members)",
    topics: {
      announcements: ["Announcements", "News and updates from the team"],
      alphanumetrix: ["AlphanumetriX", "When the flagship indicator changes"],
      botalerts: ["Bot alerts", "Alerts from the BLKBöX bots"],
      tradealerts: ["Trade alerts", "New trade signals"],
      events: ["Events & giveaways", "Live events, AMAs and giveaways"],
      videos: ["Videos & streams", "New videos and live streams"],
    },
  },
  zh: {
    title: "### 🔔 通知",
    body: "我们从不使用 @everyone。选择你想接收的提醒，随时可以更改。",
    button: "选择通知",
    pick: "选择你想被提醒的内容。取消勾选即可停止。",
    placeholder: "选择你的通知",
    saved: "已保存。你会收到以下提醒：{list}",
    none: "已保存。你不会收到任何提醒。",
    verifiedOnly: "（已验证会员）",
    topics: {
      announcements: ["公告", "团队的新闻和更新"],
      alphanumetrix: ["AlphanumetriX", "旗舰指标变化时"],
      botalerts: ["机器人提醒", "来自 BLKBöX 机器人的提醒"],
      tradealerts: ["交易提醒", "新的交易信号"],
      events: ["活动与抽奖", "直播活动、AMA 和抽奖"],
      videos: ["视频与直播", "新视频和直播"],
    },
  },
  ko: {
    title: "### 🔔 알림",
    body: "저희는 @everyone 알림을 쓰지 않아요. 받고 싶은 알림을 고르고 언제든 바꿀 수 있어요.",
    button: "알림 선택",
    pick: "알림을 받고 싶은 항목을 고르세요. 체크를 해제하면 꺼집니다.",
    placeholder: "알림 선택하기",
    saved: "저장했어요. 다음 알림을 받아요: {list}",
    none: "저장했어요. 어떤 알림도 받지 않아요.",
    verifiedOnly: "(인증 멤버)",
    topics: {
      announcements: ["공지", "팀의 소식과 업데이트"],
      alphanumetrix: ["AlphanumetriX", "플래그십 지표가 바뀔 때"],
      botalerts: ["봇 알림", "BLKBöX 봇의 알림"],
      tradealerts: ["매매 알림", "새 매매 신호"],
      events: ["이벤트 & 경품", "라이브 이벤트, AMA, 경품"],
      videos: ["영상 & 방송", "새 영상과 라이브 방송"],
    },
  },
  id: {
    title: "### 🔔 Notifikasi",
    body: "Kami tidak pernah ping @everyone. Pilih notifikasi yang kamu mau, bisa diubah kapan saja.",
    button: "Pilih notifikasi",
    pick: "Pilih apa saja yang ingin kamu terima. Hapus centang untuk berhenti.",
    placeholder: "Pilih notifikasimu",
    saved: "Tersimpan. Kamu akan di-ping untuk: {list}",
    none: "Tersimpan. Kamu tidak akan di-ping untuk apa pun.",
    verifiedOnly: "(member terverifikasi)",
    topics: {
      announcements: ["Pengumuman", "Berita dan update dari tim"],
      alphanumetrix: ["AlphanumetriX", "Saat indikator flagship berubah"],
      botalerts: ["Alert bot", "Alert dari bot BLKBöX"],
      tradealerts: ["Sinyal trading", "Sinyal trading baru"],
      events: ["Event & giveaway", "Event live, AMA dan giveaway"],
      videos: ["Video & live", "Video baru dan siaran langsung"],
    },
  },
  vi: {
    title: "### 🔔 Thông báo",
    body: "Chúng tôi không bao giờ ping @everyone. Hãy chọn thông báo bạn muốn, đổi lúc nào cũng được.",
    button: "Chọn thông báo",
    pick: "Chọn những gì bạn muốn được báo. Bỏ chọn để tắt.",
    placeholder: "Chọn thông báo của bạn",
    saved: "Đã lưu. Bạn sẽ được báo về: {list}",
    none: "Đã lưu. Bạn sẽ không nhận thông báo nào.",
    verifiedOnly: "(thành viên đã xác minh)",
    topics: {
      announcements: ["Thông báo", "Tin tức và cập nhật từ đội ngũ"],
      alphanumetrix: ["AlphanumetriX", "Khi chỉ báo chủ lực thay đổi"],
      botalerts: ["Cảnh báo bot", "Cảnh báo từ các bot BLKBöX"],
      tradealerts: ["Tín hiệu giao dịch", "Tín hiệu giao dịch mới"],
      events: ["Sự kiện & quà tặng", "Sự kiện trực tiếp, AMA và quà tặng"],
      videos: ["Video & livestream", "Video mới và livestream"],
    },
  },
  es: {
    title: "### 🔔 Notificaciones",
    body: "Nunca usamos @everyone. Elige los avisos que quieres y cámbialos cuando quieras.",
    button: "Elegir notificaciones",
    pick: "Elige de qué quieres recibir aviso. Desmarca algo para dejar de recibirlo.",
    placeholder: "Elige tus notificaciones",
    saved: "Guardado. Recibirás avisos de: {list}",
    none: "Guardado. No recibirás ningún aviso.",
    verifiedOnly: "(miembros verificados)",
    topics: {
      announcements: ["Anuncios", "Noticias y novedades del equipo"],
      alphanumetrix: ["AlphanumetriX", "Cuando cambia el indicador principal"],
      botalerts: ["Alertas de bots", "Alertas de los bots de BLKBöX"],
      tradealerts: ["Alertas de trading", "Nuevas señales de trading"],
      events: ["Eventos y sorteos", "Eventos en vivo, AMAs y sorteos"],
      videos: ["Videos y directos", "Videos nuevos y transmisiones en vivo"],
    },
  },
  pt: {
    title: "### 🔔 Notificações",
    body: "Nunca usamos @everyone. Escolha os avisos que quer e mude quando quiser.",
    button: "Escolher notificações",
    pick: "Escolha sobre o que quer ser avisado. Desmarque para parar.",
    placeholder: "Escolha suas notificações",
    saved: "Salvo. Você será avisado sobre: {list}",
    none: "Salvo. Você não receberá nenhum aviso.",
    verifiedOnly: "(membros verificados)",
    topics: {
      announcements: ["Anúncios", "Notícias e novidades da equipe"],
      alphanumetrix: ["AlphanumetriX", "Quando o indicador principal muda"],
      botalerts: ["Alertas de bots", "Alertas dos bots da BLKBöX"],
      tradealerts: ["Alertas de trade", "Novos sinais de trade"],
      events: ["Eventos e sorteios", "Eventos ao vivo, AMAs e sorteios"],
      videos: ["Vídeos e lives", "Vídeos novos e transmissões ao vivo"],
    },
  },
  tr: {
    title: "### 🔔 Bildirimler",
    body: "@everyone ile asla etiketlemiyoruz. İstediğiniz bildirimleri seçin, istediğiniz zaman değiştirin.",
    button: "Bildirimleri seç",
    pick: "Hangi konularda bildirim almak istediğinizi seçin. Durdurmak için işareti kaldırın.",
    placeholder: "Bildirimlerinizi seçin",
    saved: "Kaydedildi. Şunlar için bildirim alacaksınız: {list}",
    none: "Kaydedildi. Hiçbir bildirim almayacaksınız.",
    verifiedOnly: "(doğrulanmış üyeler)",
    topics: {
      announcements: ["Duyurular", "Ekipten haberler ve güncellemeler"],
      alphanumetrix: ["AlphanumetriX", "Amiral gösterge değiştiğinde"],
      botalerts: ["Bot uyarıları", "BLKBöX botlarından uyarılar"],
      tradealerts: ["İşlem uyarıları", "Yeni işlem sinyalleri"],
      events: ["Etkinlik & çekilişler", "Canlı etkinlikler, AMA'lar ve çekilişler"],
      videos: ["Videolar & yayınlar", "Yeni videolar ve canlı yayınlar"],
    },
  },
  ru: {
    title: "### 🔔 Уведомления",
    body: "Мы никогда не используем @everyone. Выберите нужные уведомления и меняйте их когда угодно.",
    button: "Выбрать уведомления",
    pick: "Выберите, о чём вас уведомлять. Снимите галочку, чтобы отключить.",
    placeholder: "Выберите уведомления",
    saved: "Сохранено. Вы будете получать: {list}",
    none: "Сохранено. Уведомлений не будет.",
    verifiedOnly: "(подтверждённые участники)",
    topics: {
      announcements: ["Объявления", "Новости и обновления от команды"],
      alphanumetrix: ["AlphanumetriX", "Когда меняется флагманский индикатор"],
      botalerts: ["Алерты ботов", "Алерты от ботов BLKBöX"],
      tradealerts: ["Торговые сигналы", "Новые торговые сигналы"],
      events: ["События и розыгрыши", "Эфиры, AMA и розыгрыши"],
      videos: ["Видео и стримы", "Новые видео и прямые эфиры"],
    },
  },
  ja: {
    title: "### 🔔 通知",
    body: "@everyone での通知は使いません。受け取りたい通知を選び、いつでも変更できます。",
    button: "通知を選ぶ",
    pick: "通知を受け取りたい項目を選んでください。チェックを外すと止まります。",
    placeholder: "通知を選ぶ",
    saved: "保存しました。次の通知を受け取ります：{list}",
    none: "保存しました。通知は届きません。",
    verifiedOnly: "（認証済みメンバー）",
    topics: {
      announcements: ["お知らせ", "チームからのニュースと更新"],
      alphanumetrix: ["AlphanumetriX", "フラッグシップ指標が変わったとき"],
      botalerts: ["ボットアラート", "BLKBöX ボットからのアラート"],
      tradealerts: ["トレードアラート", "新しいトレードシグナル"],
      events: ["イベント＆プレゼント", "ライブイベント、AMA、プレゼント"],
      videos: ["動画＆配信", "新しい動画とライブ配信"],
    },
  },
};

/** Topics whose channels only verified members can see. */
const VERIFIED_ONLY: NotifyTopic[] = ["alphanumetrix", "botalerts", "tradealerts"];

/** The button that opens the picker; it sits on the server guide. */
export function notifyButton(lang: Lang) {
  return new ButtonBuilder().setCustomId(NOTIFY_OPEN).setStyle(ButtonStyle.Success).setLabel(NOTIFY_TEXT[lang].button).setEmoji("🔔");
}

export class NotifyCenter {
  constructor(private guild: Guild, private db: Db, private roles: LanguageRoles) {}

  /** The topic's role: recorded by the onboarding notify step, found by name otherwise. */
  private async role(topic: NotifyTopic): Promise<Role | undefined> {
    const id = await this.db.getSetting(this.guild.id, `notify_role:${topic}`);
    return (id ? this.guild.roles.cache.get(id) : undefined) ?? this.guild.roles.cache.find((r) => r.name === NOTIFY_ROLES[topic].name);
  }

  private async topicRoles() {
    const out: { topic: NotifyTopic; role: Role }[] = [];
    for (const topic of NOTIFY_TOPICS) {
      const role = await this.role(topic);
      if (role) out.push({ topic, role });
    }
    return out;
  }

  async onButton(i: ButtonInteraction<"cached">) {
    const lang = this.roles.langOf(i.member) ?? "en";
    const t = NOTIFY_TEXT[lang];
    const available = await this.topicRoles();
    if (!available.length) return void i.reply({ content: "Notifications aren't set up yet.", flags: MessageFlags.Ephemeral });
    const menu = new StringSelectMenuBuilder()
      .setCustomId(NOTIFY_SET)
      .setPlaceholder(t.placeholder)
      .setMinValues(0)
      .setMaxValues(available.length)
      .addOptions(
        available.map(({ topic, role }) => {
          const [label, description] = t.topics[topic];
          return {
            label,
            description: `${description}${VERIFIED_ONLY.includes(topic) ? ` ${t.verifiedOnly}` : ""}`.slice(0, 100),
            value: topic,
            emoji: NOTIFY_ROLES[topic].emoji,
            default: i.member.roles.cache.has(role.id),
          };
        }),
      );
    await i.reply({ content: t.pick, components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)], flags: MessageFlags.Ephemeral });
  }

  async onSelect(i: StringSelectMenuInteraction<"cached">) {
    const lang = this.roles.langOf(i.member) ?? "en";
    const t = NOTIFY_TEXT[lang];
    const want = new Set(i.values);
    const available = await this.topicRoles();
    const add = available.filter(({ topic, role }) => want.has(topic) && !i.member.roles.cache.has(role.id)).map((x) => x.role.id);
    const remove = available.filter(({ topic, role }) => !want.has(topic) && i.member.roles.cache.has(role.id)).map((x) => x.role.id);
    try {
      if (add.length) await i.member.roles.add(add, "notification center");
      if (remove.length) await i.member.roles.remove(remove, "notification center");
    } catch (e) {
      log.warn("notify roles failed", { user: i.user.id, ...errInfo(e) });
      return void i.update({ content: "Something went wrong saving that. Please try again in a minute.", components: [] });
    }
    const chosen = available.filter(({ topic }) => want.has(topic)).map(({ topic }) => `${NOTIFY_ROLES[topic].emoji} ${t.topics[topic][0]}`);
    log.info("notifications set", { user: i.user.id, topics: [...want] });
    await i.update({ content: chosen.length ? t.saved.replace("{list}", chosen.join(", ")) : t.none, components: [] });
  }
}
