// Renders <name>-<lang>.png from <name>.html and <name>.json, for mess (pardon our mess) and channels
// (show all channels).   node render.mjs [chromium path] [name ...]
import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";
const dir = new URL(".", import.meta.url).pathname;
const args = process.argv.slice(2);
const exe = args[0] && args[0].includes("/") ? args.shift() : undefined;
const SIZES = { mess: { width: 1200, height: 675 }, channels: { width: 1200, height: 630 } };
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
for (const name of args.length ? args : Object.keys(SIZES)) {
  const t = JSON.parse(readFileSync(dir + `${name}.json`, "utf8"));
  const page = await browser.newPage({ viewport: SIZES[name], deviceScaleFactor: 1 });
  await page.goto("file://" + dir + `${name}.html`);
  for (const w of [600, 700, 800]) await page.addStyleTag({ url: "file://" + dir + `../../node_modules/@fontsource/noto-sans/${w}.css` });
  for (const [lang, s] of Object.entries(t)) {
    await page.evaluate((s) => window.draw(s), s);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: dir + `${name}-${lang}.png` });
    console.log("drew", name, lang);
  }
  await page.close();
}
await browser.close();
