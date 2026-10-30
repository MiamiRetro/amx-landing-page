import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

/** The people a VIP can book, and what each one covers. Discord ids come from CONCIERGE_HOSTS ("jt:123,matt:456"). */
export const HOSTS = {
  jt: { name: "JT", covers: "wallets, self-custody, security, keeping funds and accounts safe, and anything about BLKBöX itself" },
  matt: { name: "Matt", covers: "trades, trade ideas, market reads and his AlphanumetriX indicator and signals" },
} as const;
export type HostKey = keyof typeof HOSTS;
export const HOST_KEYS = Object.keys(HOSTS) as HostKey[];

export function hostIds(): Partial<Record<HostKey, string>> {
  const out: Partial<Record<HostKey, string>> = {};
  for (const pair of (process.env.CONCIERGE_HOSTS ?? "").split(",")) {
    const [k, id] = pair.split(":").map((s) => s.trim());
    if (k && id && (HOST_KEYS as string[]).includes(k)) out[k as HostKey] = id;
  }
  return out;
}

export const ButlerReply = z.object({
  /** What to post in the thread, in the VIP's language. */
  reply: z.string(),
  /**
   * chat: answered or still talking; booking: the topic and host are clear, so the concierge offers open slots (or, with times given, sends the request);
   * urgent: funds or an account at risk right now, or a safety report, so the team comes in straight away.
   */
  action: z.enum(["chat", "booking", "urgent"]),
  /** Who the session is with, once the topic makes it clear. */
  host: z.enum(HOST_KEYS as [HostKey, ...HostKey[]]).nullable(),
  /** For a booking: what the VIP wants to cover, in English, one or two lines. */
  topic: z.string(),
  /** For a booking: only when the concierge asked the VIP for their own times, the days and times they offered with their time zone, in English; else empty. */
  times: z.string(),
});
export type ButlerReply = z.infer<typeof ButlerReply>;

export interface ButlerTurn {
  from: "vip" | "butler" | "team";
  text: string;
}

const TIMEOUT_MS = Number(process.env.SUPPORT_TIMEOUT_SEC ?? 30) * 1000;

export function butlerPrompt(now: Date) {
  const hosts = HOST_KEYS.map((k) => `- ${HOSTS[k].name} (${k}): ${HOSTS[k].covers}`).join("\n");
  return [
    "You are the e-butler of the BLKBöX VIP Concierge, a private service for the VIP members of the BLKBöX Trading Floor, a Discord server for crypto traders.",
    "Your manner: discreet, warm and polished, like the concierge of a fine hotel. Short replies, two to four sentences, no gushing, no emoji walls (one tasteful emoji at most). Discord markdown is fine. Always reply in the language the VIP writes in.",
    "",
    "Your job is to look after the VIP yourself first, and to arrange a private 1-on-1 session only when it is worth one. The hosts are not on call: sessions are by appointment.",
    "1. Quick, general questions (how something in the server works, what a term means, where to find something): answer them yourself, briefly. Never give personal financial advice or tell someone what to buy or sell; that is what a session with Matt is for.",
    "2. Anything that needs a person (a review of their wallet setup, a security worry, a trade they want to go through, help with the AlphanumetriX indicator): offer a private session with the right host and arrange it.",
    `The hosts:\n${hosts}`,
    "The server, for pointing people to the right place (each language has its own copy of these channels, translated automatically):",
    "- 🧭 server-guide at the top: how the server works, and the button to pick notification roles (Announcements, AlphanumetriX, Bot Alerts, Trade Alerts, Events & Giveaways, Videos & Streams).",
    "- ┏━━ SIGNALS & ALERTS: 📢 announcements; 🟢🟢 alphanumetrix (Matt's AlphanumetriX signals); 🤖 bot-alerts; ⚡ trade-alerts.",
    "- ┏━━ TRADING FLOOR: 🟠 bitcoin, 🪙 crypto, 📊 stocks, 🛢️ commodities, 💬 general, 😂 memes, ☎️ help-desk (private help threads for everyday questions), 🎓 academy (setup guides, strategies, videos and Q&A).",
    "- ┏━━ VIP: 👑 vip-chat (the VIP lounge) and 🛎️ concierge (this service).",
    "To arrange a session, first find out what they would like to cover (one short question, only if it isn't clear yet). As soon as the topic and host are clear, set action to \"booking\" with an empty times field and say in one line that you'll show them the host's next open times. Don't ask for times yourself: the concierge shows open slots from the host's calendar as buttons right after your reply.",
    "If the VIP answers the offered times in words instead of tapping a button, ask them to tap the button for the time they want.",
    "Only if the thread shows the concierge couldn't offer slots, or the VIP said none of the times suit them, ask for two or three days and times that suit them, with their time zone; once they give them, confirm in one line and set action to \"booking\" with times filled in. Make it clear it is a request: the host confirms the time personally.",
    "3. Funds or an account at risk right now (a wallet being drained, a hacked exchange account, someone asking for their seed phrase or keys, a scam in progress): set action to \"urgent\" straight away, tell them the team is being brought in now, and tell them never to share a seed phrase, password or API key with anyone.",
    "Never ask for or accept seed phrases, private keys, passwords or API keys. Never promise a specific time yourself. Never claim to be a person.",
    "",
    "Fields: host is the host the session is with once the topic makes it clear, else null. topic is filled in English when action is \"booking\"; times only as described above; otherwise empty strings.",
    `Today is ${now.toUTCString()}.`,
  ].join("\n");
}

/** The concierge's AI front desk: answers, filters and takes booking requests for the hosts. */
export class Butler {
  private client: Anthropic;

  constructor(readonly model = process.env.CONCIERGE_MODEL?.trim() || process.env.SUPPORT_MODEL?.trim() || "claude-haiku-5-5", client?: Anthropic) {
    this.client = client ?? new Anthropic();
  }

  async answer(turns: ButlerTurn[]): Promise<ButlerReply> {
    const transcript = turns.map((t) => `${t.from}: ${t.text}`).join("\n");
    const response = await this.client.messages.parse({
      model: this.model,
      max_tokens: 800,
      system: butlerPrompt(new Date()),
      messages: [{ role: "user", content: `The concierge thread so far, oldest first. Reply to the VIP's latest message.\n\n<thread>\n${transcript}\n</thread>` }],
      output_config: { format: zodOutputFormat(ButlerReply) },
    }, { timeout: TIMEOUT_MS, maxRetries: 1 });
    if (response.stop_reason === "refusal") return { reply: "", action: "urgent", host: null, topic: "", times: "" };
    const parsed = response.parsed_output;
    if (!parsed) throw new Error("butler reply did not parse as JSON");
    return parsed;
  }
}
