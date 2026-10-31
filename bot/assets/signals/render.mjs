// Renders the AlphanumetriX signal infographics: one card per signal, the 3-light board and the
// timeline. They carry no words (icons, lights, numbers, ISO dates) so every language channel can
// use the same image; the explanation goes in the translated embed.
//   node assets/signals/render.mjs [chromium path]   (run from bot/)
import { chromium } from "playwright-core";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const exe = process.argv[2] ?? process.env.CHROMIUM_PATH;
const events = JSON.parse(readFileSync(join(here, "data.json"), "utf8"));
const prices = JSON.parse(readFileSync(join(here, "btc-daily.json"), "utf8"));
const NAMES = ["Weekly Diamond", "3-Day Cross", "Wave Flip"];
const board = Object.fromEntries(NAMES.map((n) => [n, { bull: false, none: true }]));
const specs = [], regimes = [];
for (const e of events) {
  board[e.name] = { bull: e.bull, since: e.confirmed ?? e.fired };
  const count = NAMES.filter((n) => board[n].bull).length;
  e.count = count;
  if (regimes.at(-1)?.from === e.fired) regimes.at(-1).count = count; else regimes.push({ from: e.fired, count });
  specs.push({ file: `signal-${e.n}.png`, mode: "signal", w: 900, h: 240, ...e, board: structuredClone(board), date: e.confirmed ?? e.fired });
}
specs.push({ file: "board.png", mode: "board", w: 900, h: 340, board, count: events.at(-1).count });
const closes = Object.fromEntries(prices);
specs.push({ file: "timeline.png", mode: "chart", w: 1100, h: 520, prices: prices.filter((p) => p[0] >= events[0].fired), regimes,
  events: events.map((e) => ({ name: e.name, bull: e.bull, date: e.fired, close: closes[e.fired] })) });
mkdirSync(join(here, "out"), { recursive: true });
const browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 900, height: 300 }, deviceScaleFactor: 2 });
await page.goto("file://" + join(here, "signals.html"));
for (const s of specs) {
  await page.setViewportSize({ width: s.w, height: s.h });
  await page.evaluate((s) => window.draw(s), s);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: join(here, "out", s.file), type: "png" });
  console.log("rendered", s.file);
}
await browser.close();
