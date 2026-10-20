import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { LANG_NAMES, type Lang } from "../config.js";

// assets/ sits two levels above both src/support and dist/support, so dev and the built bot read the same file.
const FAQ_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", "support", "faq.md");

export function loadFaq(path = FAQ_PATH): string {
  return readFileSync(path, "utf8");
}

export const Answer = z.object({
  /** What to post in the thread, in the member's language. Empty when handing off without a word. */
  reply: z.string(),
  /** The FAQ covered the question and the reply answers it. */
  answered: z.boolean(),
  /** A moderator should take over: not covered, asked for a person, account-specific, or a safety report. */
  handoff: z.boolean(),
  /** One line in English for the moderators: what the member needs. */
  summary: z.string(),
});
export type Answer = z.infer<typeof Answer>;

export interface Turn {
  from: "member" | "assistant" | "moderator";
  text: string;
}

export function systemPrompt(faq: string, lang: Lang) {
  return [
    "You are the support assistant in the help-desk of the BLKBöX Trading Floor, a Discord server for crypto traders.",
    `Reply in ${LANG_NAMES[lang]}, in two to four short sentences, friendly and plain. Discord markdown is fine.`,
    "Answer only from the FAQ below. Never invent features, prices, links, dates or policies, and never give trading or financial advice.",
    "Never ask for passwords, API keys, seed phrases or personal documents. A UID is fine.",
    "Set handoff to true, and say in your reply that a moderator will join, when any of these hold:",
    "- the FAQ does not cover the question, or only partly covers it;",
    "- the member asks for a person, a moderator or staff;",
    "- the question is about their own account and needs someone to look something up or change something (the FAQ says to ask for a moderator);",
    "- they report a scam, harassment, a security problem or someone asking for their keys;",
    "- they are still stuck after your earlier answers.",
    "Set answered to true only when your reply fully answers the question from the FAQ.",
    "Never quote lines that start with \"Mods:\"; they are notes for moderators.",
    "summary: one line in English for the moderators saying what the member needs.",
    "",
    "<faq>",
    faq,
    "</faq>",
  ].join("\n");
}

/** Claude with the FAQ as its only source. One call per member message. */
export class SupportAssistant {
  private client: Anthropic;
  private faq: string;

  constructor(readonly model = process.env.SUPPORT_MODEL?.trim() || "claude-haiku-5-5", client?: Anthropic, faq?: string) {
    this.client = client ?? new Anthropic();
    this.faq = faq ?? loadFaq();
  }

  async answer(lang: Lang, turns: Turn[]): Promise<Answer> {
    const transcript = turns.map((t) => `${t.from}: ${t.text}`).join("\n");
    const response = await this.client.messages.parse({
      model: this.model,
      max_tokens: 1024,
      system: systemPrompt(this.faq, lang),
      messages: [{ role: "user", content: `The help thread so far, oldest first. Answer the member's latest message.\n\n<thread>\n${transcript}\n</thread>` }],
      output_config: { format: zodOutputFormat(Answer) },
    });
    if (response.stop_reason === "refusal") return { reply: "", answered: false, handoff: true, summary: "assistant declined to answer" };
    const parsed = response.parsed_output;
    if (!parsed) throw new Error("support answer did not parse as JSON");
    return parsed;
  }
}
