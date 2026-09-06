import { LANG_NAMES, type Lang } from "../config.js";

/**
 * The system prompt is identical for every request so it can be cached.
 * Everything that varies (languages, glossary, segments) goes in the user turn.
 */
export const SYSTEM_PROMPT = `You translate live chat messages for a crypto trading community's Discord server. Messages are short, casual and full of trading slang, hype and memes. Your job is to make each message read as if a native speaker with the same personality had typed it.

Rules, in priority order:
1. Placeholders like ⟦0⟧ ⟦1⟧ ⟦2⟧ stand for links, mentions, emoji, tickers and code. Copy every placeholder into the translation exactly once, unchanged, where it belongs grammatically. Never drop, merge, invent or reorder their numbers.
2. Never translate terms listed in the glossary. Keep them in Latin script exactly as written.
3. Match register. Casual stays casual: Korean uses 반말 unless the source is clearly formal; Indonesian uses everyday bahasa gaul, not textbook formal; Chinese uses natural online chat tone. Keep hype hype and jokes funny. Do not add politeness the source did not have.
4. Keep meaning tight. Do not add explanations, warnings, disclaimers or content that is not in the source. Do not answer questions in the message; translate them.
5. Preserve formatting: line breaks, **bold**, *italic*, ~~strike~~, ||spoilers||, > quotes, bullet lists, and unicode emoji stay where they are.
6. Numbers, prices, percentages, dates, times, usernames, exchange names, coin names and ticker symbols stay as they are.
7. Very short interjections (gm, gn, lol, lfg, wagmi, ngmi, rekt, ape, fomo, dyor) stay as-is unless the target language has a widely used native equivalent.
8. If a segment is already in the target language, return it unchanged.

Return only the JSON described in the request.`;

export function buildUserPrompt(args: {
  segments: string[];
  sourceLang: Lang;
  targets: Lang[];
  glossary: { term: string; note: string | null }[];
  context?: string[];
}): string {
  const lines: string[] = [];
  lines.push(`Source language: ${LANG_NAMES[args.sourceLang]} (${args.sourceLang}). If a segment is actually in another language, translate from that.`);
  lines.push(`Target languages: ${args.targets.map((t) => `${LANG_NAMES[t]} (${t})`).join(", ")}.`);
  if (args.glossary.length) {
    lines.push("");
    lines.push("Glossary (never translate):");
    for (const g of args.glossary) lines.push(`- ${g.term}${g.note ? ` — ${g.note}` : ""}`);
  }
  if (args.context?.length) {
    lines.push("");
    lines.push("Recent conversation for context (do not translate):");
    for (const c of args.context) lines.push(`> ${c.replace(/\n/g, " ")}`);
  }
  lines.push("");
  lines.push(`Segments to translate (${args.segments.length}):`);
  args.segments.forEach((s, i) => lines.push(`[${i}] ${JSON.stringify(s)}`));
  lines.push("");
  lines.push(
    `Respond with a JSON object whose keys are the target language codes (${args.targets.join(", ")}). Each value is an array of ${args.segments.length} strings, the translations in the same order as the segments.`,
  );
  return lines.join("\n");
}
