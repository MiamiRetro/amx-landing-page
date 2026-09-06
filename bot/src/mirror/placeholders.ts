/**
 * Replaces everything that must survive translation byte-for-byte with
 * numbered placeholders, and restores them afterwards.
 *
 * Placeholders look like ⟦3⟧. The brackets are U+27E6/U+27E7, which do not
 * occur in chat text and survive every model we have tried.
 */

export interface Tokenized {
  text: string;
  /** Placeholder index → original literal. */
  entities: string[];
}

const PATTERNS: RegExp[] = [
  // fenced code blocks first so their contents never match anything else
  /```[\s\S]*?```/g,
  // inline code
  /`[^`\n]+`/g,
  // Discord entities: <@id> <@!id> <@&id> <#id> <a:name:id> <:name:id> <t:unix> <t:unix:F> </cmd:id> <id:customize> <sound:guild:id>
  /<(?:@[!&]?\d+|#\d+|a?:[\w~]+:\d+|t:-?\d+(?::[a-zA-Z])?|\/[\w\- ]+:\d+|id:\w+|sound:\d+:\d+)>/g,
  // suppressed-embed links <https://...>
  /<https?:\/\/[^\s>]+>/g,
  // bare URLs (trailing punctuation excluded)
  /https?:\/\/[^\s<]+?(?=[.,;:!?)\]]*(?:\s|$))/g,
  // tickers: $BTC, $eth  (2–10 letters)
  /\$[A-Za-z]{2,10}\b/g,
  // @everyone / @here
  /@(?:everyone|here)\b/g,
  // Discord unicode emoji shortcodes like :fire: are rendered by Discord, keep them
  /:[a-z0-9_+\-]{2,}:/g,
];

const PH = (i: number) => `⟦${i}⟧`;
const PH_RE = /⟦(\d+)⟧/g;

export function tokenize(text: string): Tokenized {
  const entities: string[] = [];
  let out = text;
  for (const re of PATTERNS) {
    out = out.replace(re, (m) => {
      // never tokenize inside an existing placeholder
      entities.push(m);
      return PH(entities.length - 1);
    });
  }
  return { text: out, entities };
}

export function detokenize(text: string, entities: string[]): string {
  return text.replace(PH_RE, (m, n: string) => entities[Number(n)] ?? m);
}

/** True when the translated text carries every placeholder exactly once and no extras. */
export function placeholdersIntact(translated: string, entities: string[]): boolean {
  const seen = new Map<number, number>();
  for (const m of translated.matchAll(PH_RE)) {
    const n = Number(m[1]);
    seen.set(n, (seen.get(n) ?? 0) + 1);
  }
  if (seen.size !== entities.length) return false;
  for (let i = 0; i < entities.length; i++) if (seen.get(i) !== 1) return false;
  return true;
}

/**
 * Whether anything is left to translate after placeholders are removed.
 * Emoji-only, mention-only, URL-only and very short messages are not worth an API call.
 */
export function hasTranslatableText(tokenizedText: string): boolean {
  const stripped = tokenizedText
    .replace(PH_RE, "")
    .replace(/\p{Extended_Pictographic}|\p{Emoji_Modifier}|‍|️/gu, "")
    .replace(/[\d\s.,!?;:'"()\-–—_*~|>#+=%/\\[\]{}^&$@]/g, "");
  return stripped.length >= 3;
}

/** Discord message limit. Splits on line breaks, then spaces, never inside a placeholder. */
export function splitForDiscord(text: string, limit = 2000): string[] {
  if (text.length <= limit) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf(" ", limit);
    if (cut < limit * 0.5) cut = limit;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, "");
  }
  if (rest) parts.push(rest);
  return parts;
}
