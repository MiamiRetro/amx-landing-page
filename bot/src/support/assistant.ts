import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { LANG_NAMES, type Lang } from "../config.js";
import { GUIDES, MAX_GUIDES } from "./guides.js";

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
  /** Infographics to attach, named on the "Guide:" lines of the FAQ entries the reply used. */
  guides: z.array(z.enum(GUIDES)),
});
export type Answer = z.infer<typeof Answer>;

export interface Turn {
  from: "member" | "assistant" | "moderator";
  text: string;
  /** Screenshots the member attached, as URLs the model can fetch. */
  images?: string[];
  /** Guides the assistant attached to this message. */
  guides?: string[];
}

/** Screenshots sent to the model per answer, newest first; older ones stay in the thread for the moderators. */
const MAX_IMAGES = 3;

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
    "When you can't fully answer, don't ask them to write more or to wait: set handoff and say a moderator is being brought in.",
    "When you do answer, you may end by mentioning the \"Talk to a mod\" button if they still need a person.",
    "Set answered to true only when your reply fully answers the question from the FAQ.",
    "Never quote lines that start with \"Mods:\"; they are notes for moderators.",
    "Members may attach screenshots (an exchange error, their account page) or links. Use them to understand the problem, but never repeat a UID, email or balance you read from one.",
    "summary: one line in English for the moderators saying what the member needs.",
    `guides: when an FAQ entry you answered from has a "Guide:" line, list that guide so the bot attaches the picture; at most ${MAX_GUIDES}, and none when handing off without an answer. Don't describe the picture; one short mention like "see the picture below" is enough.`,
    "Skip a guide the assistant already attached earlier in this thread (shown as [guide: name]).",
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
  /** Entries moderators added through the weekly review, kept in the database, not the file. */
  private learned = "";

  constructor(readonly model = process.env.SUPPORT_MODEL?.trim() || "claude-haiku-5-5", client?: Anthropic, faq?: string) {
    this.client = client ?? new Anthropic();
    this.faq = faq ?? loadFaq();
  }

  setLearned(entries: string[]) {
    this.learned = entries.join("\n\n");
  }

  async answer(lang: Lang, turns: Turn[]): Promise<Answer> {
    const transcript = turns
      .map((t) => `${t.from}: ${t.text}${t.images?.length ? ` [${t.images.length} screenshot(s) attached]` : ""}${t.guides?.map((g) => ` [guide: ${g}]`).join("") ?? ""}`)
      .join("\n");
    const images = turns.flatMap((t) => t.images ?? []).slice(-MAX_IMAGES);
    const response = await this.client.messages.parse({
      model: this.model,
      max_tokens: 1024,
      // The FAQ is the bulk of every call and the same each time, so it is cached.
      system: [{ type: "text", text: systemPrompt(this.learned ? `${this.faq}\n\n# Added by the moderators\n\n${this.learned}` : this.faq, lang), cache_control: { type: "ephemeral" } }],
      messages: [{
        role: "user",
        content: [
          ...images.map((url) => ({ type: "image" as const, source: { type: "url" as const, url } })),
          { type: "text" as const, text: `The help thread so far, oldest first. Answer the member's latest message.${images.length ? " The member's most recent screenshots are attached above." : ""}\n\n<thread>\n${transcript}\n</thread>` },
        ],
      }],
      output_config: { format: zodOutputFormat(Answer) },
    });
    if (response.stop_reason === "refusal") return { reply: "", answered: false, handoff: true, summary: "assistant declined to answer", guides: [] };
    const parsed = response.parsed_output;
    if (!parsed) throw new Error("support answer did not parse as JSON");
    return { ...parsed, guides: [...new Set(parsed.guides)].slice(0, MAX_GUIDES) };
  }
}
