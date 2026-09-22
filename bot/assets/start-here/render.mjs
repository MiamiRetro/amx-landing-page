import { chromium } from "playwright-core";
const exe = process.argv[2];
const specs = [
  { file: "hero.png", mode: "hero", w: 1200, h: 520, kicker: "BLKBöX Trading Floor", title: "The crypto trader's<br><span class=\"accent\">command center.</span>", sub: "Market intelligence · Proprietary signals · Multi-exchange execution" },
  { file: "language.png", w: 1200, h: 300, kicker: "Step 1", title: "Choose your<br>language", sub: "选择语言 · 언어 선택 · Pilih bahasa", sm: true },
  { file: "rules.png", w: 1200, h: 300, kicker: "Step 2", title: "The rules", sub: "Seven lines. Keep it clean." },
  { file: "start.png", w: 1200, h: 300, kicker: "Step 3", title: "Get started", sub: "Account · Exchange · Trade" },
  { file: "community.png", w: 1200, h: 300, kicker: "Stay close", title: "Follow &amp; get help", sub: "YouTube · X · Help-desk", sm: true },
  { file: "logo.png", mode: "tile", w: 512, h: 512 },
];
const browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1200, height: 300 }, deviceScaleFactor: 1 });
await page.goto("file://" + process.cwd() + "/banner.html");
for (const s of specs) {
  await page.setViewportSize({ width: s.w, height: s.h });
  await page.evaluate((s) => {
    document.body.className = s.mode ?? "";
    document.querySelector(".hero-only").style.display = s.mode === "hero" ? "block" : "none";
    document.querySelector(".side-only").style.display = s.mode === "hero" ? "none" : "block";
    document.getElementById("kicker").textContent = s.kicker ?? "";
    document.getElementById("title").innerHTML = s.title ?? "";
    document.getElementById("title").className = "title" + (s.sm ? " sm" : "");
    document.getElementById("sub").textContent = s.sub ?? "";
  }, s);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: "out/" + s.file, type: "png" });
  console.log("rendered", s.file);
}
await browser.close();
