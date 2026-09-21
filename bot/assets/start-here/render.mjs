import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";
const exe = process.argv[2];
const specs = [
  { file: "language.png", kicker: "Step 1", title: "Choose your<br>language", sub: "选择语言 · 언어 선택 · Pilih bahasa", sm: true },
  { file: "rules.png", kicker: "Step 2", title: "The rules", sub: "Seven lines. Keep it clean." },
  { file: "start.png", kicker: "Step 3", title: "Get started", sub: "Account · Exchange · Trade" },
  { file: "community.png", kicker: "Stay close", title: "Follow &amp; get help", sub: "YouTube · X · Help-desk", sm: true },
];
const browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1200, height: 300 }, deviceScaleFactor: 1 });
await page.goto("file://" + process.cwd() + "/banner.html");
for (const s of specs) {
  await page.evaluate((s) => { document.getElementById("kicker").textContent = s.kicker; document.getElementById("title").innerHTML = s.title; document.getElementById("title").className = "title" + (s.sm ? " sm" : ""); document.getElementById("sub").textContent = s.sub; }, s);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: "out/" + s.file, type: "png" });
  console.log("rendered", s.file);
}
await browser.close();
