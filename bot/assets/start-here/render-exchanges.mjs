// Renders the exchange strip (exchanges.png) for English and each translated language.
//   node render-exchanges.mjs
import { chromium } from "playwright-core";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
const langs = ["en", "zh", "ko", "id", "vi", "es", "pt", "tr", "ru", "ja"];
const en = { tileBybit: "Easiest start", tileBlofin: "No ID check", tileBitget: "Copy trading" };
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 260 } });
await page.goto("file://" + process.cwd() + "/exchanges.html");
for (const w of [600, 800]) await page.addStyleTag({ url: "file://" + process.cwd() + `/node_modules/@fontsource/noto-sans/${w}.css` });
for (const lang of langs) {
  const f = `../i18n/guide/${lang}.json`;
  const t = { ...en, ...(lang !== "en" && existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {}) };
  await page.evaluate((t) => { t1.textContent = t.tileBybit; t2.textContent = t.tileBlofin; t3.textContent = t.tileBitget; }, t);
  await page.evaluate(() => document.fonts.ready);
  const out = lang === "en" ? "exchanges.png" : `${lang}/exchanges.png`;
  if (lang !== "en") mkdirSync(lang, { recursive: true });
  await page.screenshot({ path: out });
  console.log("rendered", out);
}
await browser.close();
