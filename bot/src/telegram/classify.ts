/**
 * Picks which Discord channel a Telegram post goes to.
 * Order: explicit tag, then keywords, then (optionally) a small model, else general.
 * Replies and sticky follow-ups are decided by the bridge before this runs.
 */

export const CHANNELS = ["general", "bitcoin", "stocks", "crypto"] as const;
export type ChannelKey = (typeof CHANNELS)[number];

export function isChannelKey(x: string): x is ChannelKey {
  return (CHANNELS as readonly string[]).includes(x);
}

const TAGS: Record<string, ChannelKey> = {
  general: "general",
  gen: "general",
  bitcoin: "bitcoin",
  btc: "bitcoin",
  stocks: "stocks",
  stock: "stocks",
  crypto: "crypto",
  alts: "crypto",
};

export interface Tagged {
  channel: ChannelKey;
  /** The text with the tag taken out. */
  text: string;
}

/** `/btc text`, `#btc text`, or `text #btc` (also /bitcoin, /stocks, /crypto, /general, /alts). */
export function explicitTag(text: string): Tagged | null {
  const lead = text.match(/^\s*[/#]([a-z]+)(?:@\w+)?\b\s*/i);
  if (lead && TAGS[lead[1].toLowerCase()]) return { channel: TAGS[lead[1].toLowerCase()], text: text.slice(lead[0].length).trim() };
  const trail = text.match(/\s+#([a-z]+)\s*$/i);
  if (trail && TAGS[trail[1].toLowerCase()]) return { channel: TAGS[trail[1].toLowerCase()], text: text.slice(0, trail.index).trim() };
  return null;
}

const BITCOIN = [
  /\bbtc\b/i, /\bbitcoin\b/i, /\bsats?\b/i, /\bsatoshi/i, /\bhalving\b/i, /\bsaylor\b/i, /\bmstr\b/i, /\bmicrostrategy\b/i,
  /\bhash ?rate\b/i, /\bminers?\b/i, /\blightning\b/i, /\bibit\b/i, /\bspot etf/i, /\bxbt\b/i, /₿/,
];
const STOCKS = [
  /\bstocks?\b/i, /\bequit(y|ies)\b/i, /\bs&p\b/i, /\bspx\b/i, /\bspy\b/i, /\bqqq\b/i, /\bnasdaq\b/i, /\bndx\b/i, /\bdow\b/i,
  /\bnyse\b/i, /\bearnings\b/i, /\bfed\b/i, /\bfomc\b/i, /\bpowell\b/i, /\bcpi\b/i, /\brate (cut|hike)s?\b/i, /\btreasur(y|ies)\b/i,
  /\byields?\b/i, /\bgold\b/i, /\bsilver\b/i, /\boil\b/i, /\bdxy\b/i, /\bnvda\b/i, /\btsla\b/i, /\baapl\b/i, /\bshares\b/i,
];
const CRYPTO = [
  /\balts?\b/i, /\baltcoins?\b/i, /\beth(ereum)?\b/i, /\bsol(ana)?\b/i, /\bxrp\b/i, /\bdoge\b/i, /\bbnb\b/i, /\bada\b/i,
  /\bmemecoins?\b/i, /\bdefi\b/i, /\bnfts?\b/i, /\btokens?\b/i, /\bairdrops?\b/i, /\busdt\b/i, /\busdc\b/i, /\bstablecoins?\b/i,
  /\baltseason\b/i, /\bbtc\.?d\b/i, /\bdominance\b/i, /\bshitcoins?\b/i, /\bavax\b/i, /\bsui\b/i, /\bpepe\b/i,
];

function hits(text: string, rules: RegExp[]) {
  return rules.reduce((n, r) => n + (r.test(text) ? 1 : 0), 0);
}

/** Keyword vote. Null when nothing matches or two channels tie. */
export function keywordChannel(text: string): ChannelKey | null {
  // $AAPL style cashtags of 1–5 letters that aren't known coins count as stocks.
  const cashtags = [...text.matchAll(/\$([A-Za-z]{1,5})\b/g)].map((m) => m[1].toUpperCase());
  const coinTags = new Set(["BTC", "ETH", "SOL", "XRP", "DOGE", "BNB", "ADA", "LINK", "AVAX", "SUI", "PEPE", "USDT", "USDC"]);
  const scores: [ChannelKey, number][] = [
    ["bitcoin", hits(text, BITCOIN) + cashtags.filter((t) => t === "BTC").length],
    ["stocks", hits(text, STOCKS) + cashtags.filter((t) => !coinTags.has(t)).length],
    ["crypto", hits(text, CRYPTO) + cashtags.filter((t) => coinTags.has(t) && t !== "BTC").length],
  ];
  scores.sort((a, b) => b[1] - a[1]);
  if (scores[0][1] === 0 || scores[0][1] === scores[1][1]) return null;
  return scores[0][0];
}

export type ModelPick = (text: string) => Promise<{ channel: ChannelKey; confidence: number } | null>;

export interface Route {
  channel: ChannelKey;
  text: string;
  by: "reply" | "tag" | "sticky" | "keywords" | "model" | "default";
}

/** Tag, keywords, model, default. `minConfidence` is the bar for the model's answer. */
export async function classify(text: string, model?: ModelPick, minConfidence = 0.6): Promise<Route> {
  const tagged = explicitTag(text);
  if (tagged) return { channel: tagged.channel, text: tagged.text, by: "tag" };
  const kw = keywordChannel(text);
  if (kw) return { channel: kw, text, by: "keywords" };
  if (model && text.trim().length >= 12) {
    const pick = await model(text).catch(() => null);
    if (pick && pick.confidence >= minConfidence) return { channel: pick.channel, text, by: "model" };
  }
  return { channel: "general", text, by: "default" };
}

export const MODEL_PROMPT = `You route chat messages from two crypto/markets livestream hosts (Tone Vays and Matt McGregor of "The Daily High") into one of four Discord channels:
- bitcoin: anything about Bitcoin itself (price, charts, on-chain, mining, ETFs, Saylor, halving).
- stocks: equities, indices, macro, the Fed, rates, commodities, gold, oil.
- crypto: altcoins, Ethereum, Solana, memecoins, DeFi, the wider crypto market other than Bitcoin.
- general: greetings, the show itself, banter, anything that fits none of the above.
Answer with JSON only: {"channel": "<general|bitcoin|stocks|crypto>", "confidence": <0 to 1>}`;

/** Parses the model's reply; tolerant of code fences and stray words. */
export function parseModelPick(raw: string): { channel: ChannelKey; confidence: number } | null {
  const json = raw.match(/\{[\s\S]*\}/)?.[0];
  if (!json) return null;
  try {
    const v = JSON.parse(json) as { channel?: string; confidence?: number };
    if (!v.channel || !isChannelKey(v.channel)) return null;
    const c = Number(v.confidence);
    return { channel: v.channel, confidence: Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : 0 };
  } catch {
    return null;
  }
}
