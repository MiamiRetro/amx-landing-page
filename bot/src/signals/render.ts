import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser } from "playwright-core";

/** assets/signals/signals.html, from src/signals (tsx) or dist/signals (build) alike. */
const PAGE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", "signals", "signals.html");

/** Draws a signal card or the board with the same page assets/signals/render.mjs uses. */
export async function renderSignalImage(spec: { w: number; h: number }, executablePath = process.env.CHROMIUM_PATH): Promise<Buffer> {
  const { chromium } = await import("playwright-core");
  const browser: Browser = await chromium.launch({ executablePath, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try {
    const page = await browser.newPage({ viewport: { width: spec.w, height: spec.h }, deviceScaleFactor: 2 });
    await page.goto("file://" + PAGE);
    await page.evaluate((s) => (window as unknown as { draw: (s: unknown) => void }).draw(s), spec);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForLoadState("networkidle");
    return await page.screenshot({ type: "png" });
  } finally {
    await browser.close().catch(() => {});
  }
}
