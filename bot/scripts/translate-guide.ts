/**
 * Writes assets/i18n/guide/<lang>.json: the server-guide cards translated from
 * GUIDE_EN by Claude, for a native speaker to review afterwards.
 *
 *   railway run npx tsx scripts/translate-guide.ts            # every language
 *   railway run npx tsx scripts/translate-guide.ts ja es      # just these
 */
import Anthropic from "@anthropic-ai/sdk";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LANG_NAMES, LANGS, type Lang } from "../src/config.js";
import { GUIDE_EN } from "../src/i18n/guide.js";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "i18n", "guide");
const MODEL = process.env.GUIDE_MODEL ?? "claude-sonnet-5-5";

const SYSTEM = `You translate the welcome guide of BLKBöX Trading Floor, a crypto trading Discord, from English.
Rules:
- Keep Discord markdown exactly: **bold**, *italic*, "## ", "### ", "-# " prefixes, line breaks (\\n).
- Keep every emoji, flag, arrow (→) and middle dot (·) where it is.
- Never translate: BLKBöX, AlphanumetriX, Trading Floor, Bybit, Bitget, Blofin, MEXC, Toobit, UID, API, help-desk.
- Country/region names go into the target language.
- Tone: direct and friendly, the register crypto traders use with each other online; button labels short (under 30 characters).
- Reply with one JSON object with exactly the same keys, values translated. No commentary.`;

async function main() {
  const want = (process.argv.slice(2).filter((a) => (LANGS as readonly string[]).includes(a)) as Lang[]);
  const langs = (want.length ? want : LANGS.filter((l) => l !== "en")) as Lang[];
  const client = new Anthropic();
  for (const lang of langs) {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 8000,
      system: SYSTEM,
      messages: [{ role: "user", content: `Target language: ${LANG_NAMES[lang]}.\n\n${JSON.stringify(GUIDE_EN, null, 2)}` }],
    });
    const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as Record<string, string>;
    const missing = Object.keys(GUIDE_EN).filter((k) => typeof json[k] !== "string");
    if (missing.length) throw new Error(`${lang}: missing ${missing.join(", ")}`);
    writeFileSync(join(OUT, `${lang}.json`), JSON.stringify(json, null, 2) + "\n");
    console.log(`${lang}: ${Object.keys(json).length} strings`);
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
