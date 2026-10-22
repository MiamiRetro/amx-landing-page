import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { LANG_NAMES, LANGS, type Lang } from "../config.js";
import { GUIDES, MAX_GUIDES } from "./guides.js";
import { SUPPORT_TEXT } from "./text.js";

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
  /** Bring the moderators in now, without waiting: only for a safety report (scam, harassment, someone after their keys). */
  handoff: z.boolean(),
  /** Show the "Talk to a mod" button: the member asked for a person, sounds frustrated, or needs something only staff can do. */
  offerHuman: z.boolean(),
  /** One line in English for the moderators: what the member needs. */
  summary: z.string(),
  /** Infographics to attach, named on the "Guide:" lines of the FAQ entries the reply used. */
  guides: z.array(z.enum(GUIDES)),
  /** The member seems to be on the wrong server language, so the bot shows the language buttons. */
  wrongLanguage: z.boolean(),
  /** The language they write in or ask for, when it can be told. Shown first among the buttons. */
  switchTo: z.enum(LANGS).nullable(),
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
    `Always reply in the language the member's latest message is written in. Tell it from the words they actually wrote, never from what they say about languages: "I don't speak Chinese" written in English is English, so reply in English. If the message is too short to tell (a UID, "ok", an emoji), use the language of their earlier messages, else ${LANG_NAMES[lang]}. Members are often confused, so just help them in their own language. Two to four short sentences, friendly and plain. Discord markdown is fine.`,
    `The member's server language is ${LANG_NAMES[lang]} (${lang}). wrongLanguage: true when their latest message is written in another language than ${LANG_NAMES[lang]}, or they say they don't speak or understand ${LANG_NAMES[lang]}, picked the wrong language, or want another one; false when they write in ${LANG_NAMES[lang]} or only drop a word or trading term from another language. switchTo: the language their message is written in (${LANGS.join(", ")}); if that is ${LANG_NAMES[lang]} but they ask for another language, that one; null when you can't tell. The bot shows language buttons under your reply so they can switch the server, so don't describe them. If they write in a language not in the list, reply in English if you can and offer a moderator.`,
    "Use the polite form of address where the language has one (Korean 존댓말, Japanese です/ます, Vietnamese bạn, Russian вы, Turkish siz, never slang pronouns).",
    "Answer only from the FAQ below. Never invent features, prices, links, dates or policies, and never give trading or financial advice.",
    "Never ask for passwords, API keys, seed phrases or personal documents. A UID is fine.",
    "Guide the member yourself. Do not mention moderators, staff, people or the moderator button unless offerHuman is true.",
    "When the FAQ doesn't fully cover a question, help with what it does cover and ask one short question to narrow it down, instead of giving up.",
    `Set offerHuman to true, and say they can tap the moderator button below, when any of these hold. The button is labelled in the language you reply in: ${LANGS.map((l) => `${l} "${SUPPORT_TEXT[l].humanButton}"`).join(", ")}.`,
    "- they ask for a person, a human, a moderator, staff or an admin;",
    "- they sound frustrated, annoyed or stuck (repeating themselves, complaining that it isn't working, short angry messages);",
    "- the question is about their own account and needs someone to look something up or change something (the FAQ says to ask for a moderator);",
    "- the FAQ can't answer it after you have tried to narrow it down.",
    "Set handoff to true only when they report a scam, harassment, a security problem or someone asking for their keys or passwords; say a moderator is being brought in.",
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
    if (response.stop_reason === "refusal") return { reply: "", answered: false, handoff: true, offerHuman: true, summary: "assistant declined to answer", guides: [], wrongLanguage: false, switchTo: null };
    const parsed = response.parsed_output;
    if (!parsed) throw new Error("support answer did not parse as JSON");
    return { ...parsed, guides: [...new Set(parsed.guides)].slice(0, MAX_GUIDES), switchTo: parsed.switchTo === lang ? null : parsed.switchTo };
  }
}
