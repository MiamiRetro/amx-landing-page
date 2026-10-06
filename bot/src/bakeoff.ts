/**
 * Blind translation bake-off.
 *
 *   npm run bakeoff -- run --channel <id> [--count 200] [--targets zh,ko,id] \
 *        [--providers anthropic:claude-sonnet-5,gemini:gemini-3.7-flash,openai:gpt-5.6-terra,openrouter:tencent/hy-mt2-7b] \
 *        [--out bakeoff/<date>]
 *   npm run bakeoff -- score <dir>
 *
 * `run` samples real human messages from a channel, translates each with every
 * provider, and writes one rating sheet per target language where the provider
 * order is shuffled per row and labelled A/B/C/D. Native speakers fill in
 * `ratings-<lang>.csv` (row,letter,score 1-5,note). `score` joins ratings with
 * the hidden key and prints the average per provider and language.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { isLang, type Lang } from "./config.js";
import { connect } from "./lib/client.js";
import { detokenize, hasTranslatableText, tokenize } from "./mirror/placeholders.js";
import { providerFromSpec } from "./translate/index.js";
import type { TranslationProvider } from "./translate/provider.js";

function flag(args: string[], name: string, fallback?: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
}

const LETTERS = "ABCDEFGH";

async function run(args: string[]) {
  const channelId = flag(args, "channel");
  if (!channelId) throw new Error("--channel <id> is required");
  const count = Number(flag(args, "count", "200"));
  const targets = (flag(args, "targets", "zh,ko,id") ?? "").split(",").filter(isLang) as Lang[];
  const specs = (flag(args, "providers", "anthropic:claude-sonnet-5") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const out = flag(args, "out", `bakeoff/${new Date().toISOString().slice(0, 10)}`)!;
  const providers: TranslationProvider[] = specs.map(providerFromSpec);

  const { client, guild } = await connect();
  try {
    const ch = await guild.channels.fetch(channelId);
    if (!ch || !ch.isTextBased()) throw new Error("channel is not text");
    const samples: { id: string; author: string; text: string }[] = [];
    let before: string | undefined;
    while (samples.length < count * 3) {
      const page = await ch.messages.fetch({ limit: 100, before });
      if (page.size === 0) break;
      for (const m of page.values()) {
        if (m.author.bot || m.webhookId || !m.content) continue;
        if (!hasTranslatableText(tokenize(m.content).text)) continue;
        samples.push({ id: m.id, author: m.member?.displayName ?? m.author.username, text: m.content });
      }
      before = page.last()!.id;
      if (page.size < 100) break;
    }
    // even spread across the fetched range
    const step = Math.max(1, Math.floor(samples.length / count));
    const chosen = samples.filter((_s, i) => i % step === 0).slice(0, count);
    console.log(`Sampled ${chosen.length} messages from #${ch.name}; translating with ${providers.map((p) => p.id).join(", ")}`);

    const tokenized = chosen.map((s) => tokenize(s.text));
    const results: Record<string, Partial<Record<Lang, string[]>>> = {};
    for (const p of providers) {
      const per: Partial<Record<Lang, string[]>> = {};
      for (const t of targets) per[t] = new Array(chosen.length).fill("");
      for (let i = 0; i < chosen.length; i += 10) {
        const batch = tokenized.slice(i, i + 10);
        try {
          const r = await p.translate({ segments: batch.map((b) => b.text), sourceLang: "en", targets, glossary: [] });
          for (const t of targets) r.translations[t]!.forEach((s, k) => (per[t]![i + k] = detokenize(s, batch[k].entities)));
        } catch (e) {
          console.error(`${p.id} batch ${i} failed: ${e instanceof Error ? e.message : e}`);
          for (const t of targets) batch.forEach((_b, k) => (per[t]![i + k] = "(failed)"));
        }
        process.stdout.write(`  ${p.id}: ${Math.min(i + 10, chosen.length)}/${chosen.length}\r`);
      }
      console.log();
      results[p.id] = per;
    }

    mkdirSync(out, { recursive: true });
    const key: Record<Lang, Record<number, Record<string, string>>> = {} as never;
    for (const t of targets) {
      key[t] = {};
      const sheet: string[] = [`# Translation bake-off — ${t}`, "", "Rate each lettered translation 1 (wrong or unnatural) to 5 (reads like a native wrote it). Fill in ratings-" + t + ".csv.", ""];
      const csv: string[] = ["row,letter,score,note"];
      chosen.forEach((s, row) => {
        const order = providers.map((p) => p.id).sort(() => Math.random() - 0.5);
        key[t][row] = {};
        sheet.push(`## ${row}`, "", `> **${s.author}**: ${s.text.replace(/\n/g, "\n> ")}`, "");
        order.forEach((pid, k) => {
          const letter = LETTERS[k];
          key[t][row][letter] = pid;
          sheet.push(`**${letter}.** ${results[pid][t]![row]}`, "");
          csv.push(`${row},${letter},,`);
        });
      });
      writeFileSync(join(out, `sheet-${t}.md`), sheet.join("\n"));
      writeFileSync(join(out, `ratings-${t}.csv`), csv.join("\n") + "\n");
    }
    writeFileSync(join(out, "key.json"), JSON.stringify({ providers: providers.map((p) => p.id), targets, key }, null, 2));
    writeFileSync(join(out, "samples.json"), JSON.stringify(chosen, null, 2));
    console.log(`Wrote ${out}/sheet-<lang>.md, ratings-<lang>.csv and key.json (keep key.json away from raters).`);
  } finally {
    await client.destroy();
  }
}

function score(args: string[]) {
  const dir = args.find((a) => !a.startsWith("--"));
  if (!dir) throw new Error("score needs the bake-off directory");
  const key = JSON.parse(readFileSync(join(dir, "key.json"), "utf8")) as { providers: string[]; targets: Lang[]; key: Record<Lang, Record<string, Record<string, string>>> };
  for (const t of key.targets) {
    const file = join(dir, `ratings-${t}.csv`);
    if (!existsSync(file)) continue;
    const totals: Record<string, { sum: number; n: number }> = {};
    for (const line of readFileSync(file, "utf8").split("\n").slice(1)) {
      const [row, letter, scoreStr] = line.split(",");
      const s = Number(scoreStr);
      if (!row || !letter || !Number.isFinite(s) || s <= 0) continue;
      const pid = key.key[t]?.[row]?.[letter];
      if (!pid) continue;
      totals[pid] ??= { sum: 0, n: 0 };
      totals[pid].sum += s;
      totals[pid].n++;
    }
    console.log(`\n${t}:`);
    for (const [pid, v] of Object.entries(totals).sort((a, b) => b[1].sum / b[1].n - a[1].sum / a[1].n)) {
      console.log(`  ${(v.sum / v.n).toFixed(2)}  (${v.n} ratings)  ${pid}`);
    }
  }
}

const [cmd, ...rest] = process.argv.slice(2);
(cmd === "run" ? run(rest) : cmd === "score" ? Promise.resolve(score(rest)) : Promise.reject(new Error("usage: bakeoff run|score"))).catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
