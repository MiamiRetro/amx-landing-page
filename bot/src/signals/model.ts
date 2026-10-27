import type { APIEmbed } from "discord.js";

/**
 * The AlphanumetriX BTC model as the signal cards present it: three signals,
 * each a light, and a reading from how many of them are bullish. The words
 * here are English; the cards translate them per channel, and the images
 * (assets/signals) carry none.
 */
export const SIGNALS = ["Weekly Diamond", "3-Day Cross", "Wave Flip"] as const;
export type SignalName = (typeof SIGNALS)[number];
const KEYS: Record<string, SignalName> = { weekly_diamond: "Weekly Diamond", three_day_cross: "3-Day Cross", wave_flip: "Wave Flip" };
export const EMOJI: Record<SignalName, string> = { "Weekly Diamond": "💎", "3-Day Cross": "📈", "Wave Flip": "🌊" };

/** By bullish count, from blkbox-frontend's btcStrategyScale. */
export const READINGS = [
  { icon: "🔴🔴", label: "Strong Bear Trend", detail: "All three signals are bearish. This is the strategy at its weakest posture, and further downside has been the high-probability outcome from this configuration. Rallies tend to get sold until at least one signal flips back." },
  { icon: "🔴🟡", label: "Leaning Bearish", detail: "Two of three signals are bearish. The downtrend is not fully confirmed, but momentum favors sellers. A second bullish flip would shift the picture back toward a bull trend." },
  { icon: "🟡🟢", label: "Leaning Bullish", detail: "Two of three signals are bullish, which is already a strong bull signal. A flip of the remaining signal would complete full alignment, while losing another one would weaken the setup considerably." },
  { icon: "🟢🟢", label: "Strong Bull Trend", detail: "All three signals are bullish. This is the strategy at its strongest posture, and trend continuation has been the high-probability outcome from this configuration. Risk is highest if any one signal flips back, which would partially break the alignment." },
];
export const WEEKLY_DIAMOND_NOTE = "The Weekly Diamond fires about once per market cycle, and every time it has fired so far, it has marked the cycle bottom.";
export const FOOTER = "Past signals don't guarantee future results · Not financial advice";
export const GREEN = 0x22c55e, RED = 0xef4444;

/** A row of blkbox.tradingview_signal_events. */
export interface EventRow { id: number; symbol: string; signal: string; direction: string; fired_at: string; price: string | number | null; received_at: string; raw?: { seed?: boolean } | null }

export interface SignalEvent {
  id: number;
  n: number;
  name: SignalName;
  bull: boolean;
  /** YYYY-MM-DD the chart period fired. */
  fired: string;
  /** YYYY-MM-DD the alert arrived; absent for the hand-entered history. */
  confirmed?: string;
  price: number | null;
}

export interface Light { bull: boolean; none?: boolean; since?: string }
export type Board = Record<SignalName, Light>;

const day = (iso: string) => new Date(iso).toISOString().slice(0, 10);

/** BTC events, oldest first and numbered, with the hand-entered seed rows marked as unconfirmed. */
export function toEvents(rows: EventRow[]): SignalEvent[] {
  return rows
    .filter((r) => r.symbol === "BTC" && KEYS[r.signal])
    .sort((a, b) => a.id - b.id)
    .map((r, i) => ({
      id: r.id,
      n: i + 1,
      name: KEYS[r.signal],
      bull: r.direction === "bullish",
      fired: day(r.fired_at),
      // The hand-entered history has no alert price (and the feed RPC does not return raw).
      confirmed: r.raw?.seed || r.price === null || r.price === undefined ? undefined : day(r.received_at),
      price: r.price === null || r.price === undefined ? null : Number(r.price),
    }));
}

/** The lights after the given events. A signal that never fired is dark and counts as bearish. */
export function boardAfter(events: SignalEvent[]): { board: Board; count: number } {
  const board = Object.fromEntries(SIGNALS.map((n) => [n, { bull: false, none: true }])) as Board;
  for (const e of events) board[e.name] = { bull: e.bull, since: e.confirmed ?? e.fired };
  return { board, count: SIGNALS.filter((n) => board[n].bull).length };
}

const ts = (d: string) => `<t:${Math.floor(Date.parse(d + "T00:00:00Z") / 1000)}:D>`;
export const usd = (p: number) => "$" + p.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const reading = (count: number) => `${READINGS[count].icon} ${READINGS[count].label} · ${count}/3`;

/** The card for a newly arrived signal, in English. */
export function signalEmbed(events: SignalEvent[], i: number): APIEmbed {
  const e = events[i];
  const before = boardAfter(events.slice(0, i)).count, after = boardAfter(events.slice(0, i + 1)).count;
  const dir = e.bull ? "bullish" : "bearish";
  const move = before === after ? `stays at **${READINGS[after].label}**` : `moves from ${READINGS[before].label} to **${READINGS[after].label}**`;
  const lines = [
    `**${e.name}** just turned ${dir}. ${after} of 3 signals are now bullish, so the model ${move}.`,
    ...(e.name === "Weekly Diamond" && e.bull ? [WEEKLY_DIAMOND_NOTE] : []),
    READINGS[after].detail,
  ];
  return {
    color: e.bull ? GREEN : RED,
    title: `${e.bull ? "🟢" : "🔴"} #${e.n} · ${e.name} flipped ${dir}`,
    description: lines.join("\n\n"),
    fields: [
      { name: e.confirmed ? "📅 Confirmed" : "📅 Fired", value: ts(e.confirmed ?? e.fired), inline: true },
      { name: "💰 BTC", value: e.price === null ? "—" : usd(e.price), inline: true },
      { name: "🚦 Model", value: reading(after), inline: true },
    ],
    footer: { text: FOOTER },
  };
}

/** The pinned board: where each light stands and what the reading means. */
export function boardEmbed(events: SignalEvent[]): APIEmbed {
  const { board, count } = boardAfter(events);
  const line = (n: SignalName) => {
    const l = board[n];
    if (l.none) return `⚫ ${EMOJI[n]} **${n}**: no signal yet`;
    return `${l.bull ? "🟢" : "🔴"} ${EMOJI[n]} **${n}**: ${l.bull ? "bullish" : "bearish"} since ${ts(l.since!)}`;
  };
  return {
    color: count >= 2 ? GREEN : RED,
    title: "🚦 Where the model stands now",
    description: `${SIGNALS.map(line).join("\n")}\n\n**${count} of 3 bullish → ${READINGS[count].icon} ${READINGS[count].label}.** ${READINGS[count].detail}`,
    fields: [{ name: "📊 Live model", value: "https://dash.blkbox.pro" }],
    footer: { text: FOOTER },
  };
}

/** What assets/signals/signals.html draws for a card or the board. */
export function cardSpec(events: SignalEvent[], i: number) {
  const e = events[i];
  const { board, count } = boardAfter(events.slice(0, i + 1));
  const price = e.price === null ? "" : Math.round(e.price).toLocaleString("en-US");
  return { mode: "signal", w: 900, h: 240, n: e.n, name: e.name, bull: e.bull, price, date: e.confirmed ?? e.fired, board, count };
}
export function boardSpec(events: SignalEvent[]) {
  return { mode: "board", w: 900, h: 340, ...boardAfter(events) };
}
