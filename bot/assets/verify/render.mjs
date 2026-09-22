import { chromium } from "playwright-core";
const browser = await chromium.launch({ executablePath: process.argv[2], args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 672 }, deviceScaleFactor: 1 });
await page.goto("file://" + process.cwd() + "/uid-guide.html");
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: "out/uid-guide.png", type: "png" });
console.log("rendered uid-guide.png");
await browser.close();
