import type { Message } from "discord.js";
import type { Lang } from "../config.js";
import { log, errInfo } from "../log.js";
import { detokenize, tokenize } from "../mirror/placeholders.js";

/** What thread translation needs from the translator: the same polite, glossary-aware one the mirror uses. */
export interface ThreadTranslator {
  translate(segments: string[], entities: string[][], sourceLang: Lang, targets: Lang[], glossary: { term: string; note: string | null }[]): Promise<{ translations: Record<Lang, string[]>; translated: boolean }>;
}

/**
 * Points channel tags and Discord links at the reader's language twin (an English
 * channel becomes its Japanese twin for a Japanese reader). The mirror's remapForTarget.
 */
export type ChannelLocalizer = (text: string, lang: Lang) => Promise<string>;

/**
 * One text translated with its channel tags, mentions, links and code kept intact,
 * then re-pointed at the reader's language. Translation failing leaves the original
 * words, still re-pointed. `translated` says whether the words changed language.
 */
export async function translateForReader(
  translator: ThreadTranslator | null,
  text: string,
  from: Lang,
  to: Lang,
  localize: ChannelLocalizer | null,
): Promise<{ text: string; translated: boolean }> {
  let out = text, translated = false;
  if (translator && from !== to && text.trim()) {
    const tok = tokenize(text);
    const r = await translator.translate([tok.text], [tok.entities], from, [to], []).catch((e) => {
      log.warn("thread translation failed", errInfo(e));
      return null;
    });
    const t = r?.translated ? r.translations[to]?.[0] : undefined;
    if (t) { out = detokenize(t, tok.entities); translated = true; }
  }
  if (localize) out = await localize(out, to).catch(() => out);
  return { text: out, translated };
}

const FLAG: Record<Lang, string> = { en: "🇬🇧", zh: "🇨🇳", ko: "🇰🇷", id: "🇮🇩", vi: "🇻🇳", es: "🇪🇸", pt: "🇧🇷", tr: "🇹🇷", ru: "🇷🇺", ja: "🇯🇵" };
/** Under a translated message, in the language it was translated into. */
const TRANSLATED: Record<Lang, string> = {
  en: "Auto-translated for the team", zh: "自动翻译", ko: "자동 번역", id: "Diterjemahkan otomatis", vi: "Đã dịch tự động",
  es: "Traducido automáticamente", pt: "Traduzido automaticamente", tr: "Otomatik çevrildi", ru: "Автоматический перевод", ja: "自動翻訳",
};

/**
 * In a private thread between a member and the English-speaking team, posts a translation under a message:
 * the member's into English, anyone else's into the member's language. Nothing for English members, and
 * nothing when the translation fails or comes back unchanged.
 */
export async function relayTranslation(translator: ThreadTranslator | null, m: Message, memberId: string, memberLang: Lang | null, localize: ChannelLocalizer | null = null) {
  if (!translator || !memberLang || memberLang === "en" || !m.content.trim()) return;
  const fromMember = m.author.id === memberId;
  const [from, to]: [Lang, Lang] = fromMember ? [memberLang, "en"] : ["en", memberLang];
  try {
    const r = await translateForReader(translator, m.content, from, to, localize);
    const text = r.text.trim();
    if (!r.translated || !text || text === m.content.trim()) return;
    await m.reply({
      embeds: [{ description: text.slice(0, 4000), color: 0x22d3ee, footer: { text: `${FLAG[to]} ${TRANSLATED[to]}` } }],
      allowedMentions: { parse: [], repliedUser: false },
    });
  } catch (e) {
    log.warn("thread translation failed", { thread: m.channelId, ...errInfo(e) });
  }
}
