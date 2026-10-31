/**
 * Runs the infographic pipeline locally: extract → translate → render, no Discord.
 *
 *   railway run npx tsx scripts/infographic-try.ts --image ./guide.png --langs ja,es [--from en]
 *   npx tsx scripts/infographic-try.ts --make-sample ./sample.png   (plain English test image)
 *
 * Writes infographic-out/<name>.<lang>.png and <name>.extraction.json.
 * Chromium: CHROMIUM_PATH, else the Playwright headless shell in ~/Library/Caches/ms-playwright.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { isLang, type Lang } from "../src/config.js";
import { extractInfographic, mimeFromName } from "../src/infographic/extract.js";
import { Renderer } from "../src/infographic/render.js";
import { InfographicLocalizer } from "../src/infographic/index.js";
import { providerFromSpec, Translator } from "../src/translate/index.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function findChromium(): string | undefined {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const base = join(homedir(), "Library/Caches/ms-playwright");
  if (!existsSync(base)) return undefined;
  for (const d of readdirSync(base).filter((d) => d.startsWith("chromium_headless_shell")).sort().reverse()) {
    for (const sub of readdirSync(join(base, d))) {
      const p = join(base, d, sub, "chrome-headless-shell");
      if (existsSync(p)) return p;
      const q = join(base, d, sub, "headless_shell");
      if (existsSync(q)) return q;
    }
  }
  return undefined;
}

const SAMPLE = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;width:900px;padding:56px;font-family:Helvetica,Arial,sans-serif;background:#fff;color:#111;box-sizing:border-box}
h1{font-size:44px;margin:0 0 8px}p.s{color:#555;font-size:22px;margin:0 0 32px}
.st{display:flex;gap:20px;margin:18px 0;padding:20px;border:2px solid #ddd;border-radius:12px}
.n{width:44px;height:44px;border-radius:50%;background:#0a7;color:#fff;font:700 24px/44px Helvetica;text-align:center;flex:none}
h3{margin:0 0 6px;font-size:26px}.st p{margin:0;font-size:20px;color:#444}.f{margin-top:28px;color:#777;font-size:18px}
</style></head><body><h1>Connect your exchange to BLKBöX</h1><p class="s">Set up in under five minutes</p>
<div class="st"><div class="n">1</div><div><h3>Create an API key</h3><p>Open your exchange settings and create a new API key.</p></div></div>
<div class="st"><div class="n">2</div><div><h3>Paste it into BLKBöX</h3><p>Go to Settings → Exchanges and paste the key and secret.</p></div></div>
<div class="st"><div class="n">3</div><div><h3>Verify your UID</h3><p>Run /verify in Discord to unlock the trading floor.</p></div></div>
<p class="f">Need help? Ask in #help-desk</p></body></html>`;

async function main() {
  const renderer = new Renderer(findChromium());
  try {
    const sampleOut = arg("make-sample");
    if (sampleOut) {
      writeFileSync(sampleOut, await renderer.renderHtml(SAMPLE));
      console.log("wrote", sampleOut);
      return;
    }
    const image = arg("image");
    if (!image) throw new Error("usage: --image <path> --langs ja,es [--from en]  |  --make-sample <out.png>");
    const from = (arg("from") ?? "en") as Lang;
    const langs = (arg("langs") ?? "ja").split(",").map((s) => s.trim()).filter(isLang);
    const mime = mimeFromName(image);
    if (!mime || !isLang(from)) throw new Error("image must be png/jpg/webp and --from a known lang");

    const buf = readFileSync(image);
    const outDir = join(process.cwd(), "infographic-out");
    mkdirSync(outDir, { recursive: true });
    const name = basename(image).replace(/\.[^.]+$/, "");

    // Extract once here so the JSON can be inspected; the localizer reuses it.
    const ex = await extractInfographic(buf, mime);
    writeFileSync(join(outDir, `${name}.extraction.json`), JSON.stringify(ex, null, 2));
    if (!ex) {
      console.log("not an infographic: the bot would keep the original image");
      return;
    }
    const translator = new Translator({ primary: providerFromSpec(process.env.TRANSLATION_PROVIDER ?? "anthropic:claude-sonnet-5") });
    const loc = new InfographicLocalizer({ translator, renderer, extract: async () => ex });
    const glossary = [{ term: "BLKBöX", note: "brand name" }];
    const per = await loc.localizeOne(buf, mime, from, langs, glossary);
    for (const [lang, png] of per) {
      const p = join(outDir, `${name}.${lang}.png`);
      writeFileSync(p, png);
      console.log("wrote", p);
    }
    // English re-render too, to compare branding against the source.
    writeFileSync(join(outDir, `${name}.${from}.png`), await renderer.render(ex, from));
  } finally {
    await renderer.close();
  }
}

main().catch((e) => { console.error("FAIL:", e instanceof Error ? e.message : e); process.exit(1); });
