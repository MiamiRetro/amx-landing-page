/**
 * Asks the help-desk assistant sample questions without Discord, to check the FAQ and the prompt.
 *
 *   npx tsx scripts/support-try.ts                       # the built-in samples
 *   npx tsx scripts/support-try.ts ko "UID가 인증이 안 돼요"   # one question, in a language
 */
import Anthropic from "@anthropic-ai/sdk";
import { isLang, type Lang } from "../src/config.js";
import { askAssistant } from "../src/support/desk.js";

const SAMPLES: [Lang, string][] = [
  ["en", "how do i unlock the locked channels?"],
  ["en", "where do i find my uid on bybit"],
  ["en", "should I long BTC right now?"],
  ["en", "I paid for VIP but didn't get the role"],
  ["es", "mi UID no se verifica, ya lo intenté 3 veces"],
  ["ko", "미국에 살아도 가입할 수 있나요?"],
  ["ja", "言語を変えたいです"],
  ["en", "someone DMed me saying they're from the team and asked for my API key"],
];

const [langArg, ...rest] = process.argv.slice(2);
const cases: [Lang, string][] = langArg && isLang(langArg) ? [[langArg, rest.join(" ")]] : SAMPLES;
const client = new Anthropic();
const model = process.env.SUPPORT_MODEL?.trim() || "claude-haiku-4-5";
for (const [lang, q] of cases) {
  const out = await askAssistant(client, model, lang, [{ role: "user", content: q }]);
  console.log(`\n[${lang}] ${q}\n→ handoff=${out?.handoff ?? "refused"}\n${out?.reply ?? ""}`);
}
