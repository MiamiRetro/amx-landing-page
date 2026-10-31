// Renders mess-<lang>.png from mess.html and mess.json.   node render.mjs [chromium path]
import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";
const dir = new URL(".", import.meta.url).pathname;
const exe = process.argv[2];
const t = JSON.parse(readFileSync(dir + "mess.json", "utf8"));
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
const page = await browser.newPage({ viewport: { width: 1200, height: 675 }, deviceScaleFactor: 1 });
await page.goto("file://" + dir + "mess.html");
for (const w of [600, 700, 800]) await page.addStyleTag({ url: "file://" + dir + `../../node_modules/@fontsource/noto-sans/${w}.css` });
for (const [lang, s] of Object.entries(t)) {
  await page.evaluate((s) => window.draw(s), s);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: dir + `mess-${lang}.png` });
  console.log("drew", lang);
}
await browser.close();
