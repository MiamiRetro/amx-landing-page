import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import type { Lang } from "../config.js";
import type { Extraction } from "./schema.js";

/** Bot root: two levels up from src/infographic or dist/infographic. */
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

const CJK: Partial<Record<Lang, string>> = {
  zh: `"Noto Sans CJK SC","Noto Sans SC","PingFang SC","Hiragino Sans GB","Microsoft YaHei"`,
  ja: `"Noto Sans CJK JP","Noto Sans JP","Hiragino Sans","Hiragino Kaku Gothic ProN","Yu Gothic"`,
  ko: `"Noto Sans CJK KR","Noto Sans KR","Apple SD Gothic Neo","Malgun Gothic"`,
};

/**
 * Font stack per language. Sora (the brand face) has no Cyrillic or Vietnamese
 * stacked diacritics, so ru/vi use embedded Noto Sans throughout instead of a
 * glyph-by-glyph mix; CJK falls through to the system Noto CJK of that script.
 */
export function fontStack(lang: Lang): string {
  const tail = `${CJK[lang] ? CJK[lang] + "," : ""}"Noto Sans CJK SC","Noto Sans","Apple SD Gothic Neo",sans-serif`;
  if (lang === "ru" || lang === "vi") return `"Noto Sans Embed",${tail}`;
  if (CJK[lang]) return `Sora,${CJK[lang]},"Noto Sans Embed",sans-serif`;
  return `Sora,"Noto Sans Embed",${tail}`;
}

export interface Card {
  index: number;
  heading?: string;
  body?: string;
  bullets: string[];
  value?: string;
}

export interface TemplateData {
  lang: Lang;
  layout: Extraction["layout"];
  title: string;
  subtitle?: string;
  footer?: string;
  cards: Card[];
  /** grid columns for the card area */
  columns: 1 | 2 | 3;
  fontStack: string;
}

const clean = (s: string | undefined) => (s && s.trim() ? s.trim() : undefined);

export function buildTemplateData(ex: Extraction, lang: Lang): TemplateData {
  const cards = ex.sections
    .map((s, i) => ({ index: i + 1, heading: clean(s.heading), body: clean(s.body), value: clean(s.value), bullets: (s.bullets ?? []).map((b) => b.trim()).filter(Boolean) }))
    .filter((c) => c.heading || c.body || c.value || c.bullets.length);
  let columns: 1 | 2 | 3 = 1;
  if (ex.layout === "comparison") columns = cards.length >= 3 ? 3 : 2;
  else if (ex.layout === "stat") columns = cards.length === 1 ? 1 : cards.length % 3 === 0 ? 3 : 2;
  else if (ex.layout === "diagram-ish") columns = cards.length > 3 ? 2 : 1;
  return { lang, layout: ex.layout, title: ex.title.trim(), subtitle: clean(ex.subtitle), footer: clean(ex.footer), cards, columns, fontStack: fontStack(lang) };
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

let assetCss: string | null = null;
function assets(): { css: string; logo: string } {
  const b64 = (p: string) => readFileSync(join(ROOT, p)).toString("base64");
  if (!assetCss) {
    const faces: string[] = [];
    for (const w of [400, 600, 700, 800]) {
      for (const sub of ["latin", "latin-ext"]) {
        faces.push(`@font-face{font-family:Sora;font-weight:${w};src:url(data:font/woff2;base64,${b64(`node_modules/@fontsource/sora/files/sora-${sub}-${w}-normal.woff2`)}) format("woff2")}`);
      }
    }
    for (const w of [400, 700]) {
      for (const sub of ["latin", "latin-ext", "cyrillic", "cyrillic-ext", "vietnamese"]) {
        faces.push(`@font-face{font-family:"Noto Sans Embed";font-weight:${w === 700 ? "600 900" : "100 500"};src:url(data:font/woff2;base64,${b64(`node_modules/@fontsource/noto-sans/files/noto-sans-${sub}-${w}-normal.woff2`)}) format("woff2")}`);
      }
    }
    assetCss = faces.join("\n");
  }
  return { css: assetCss, logo: `data:image/png;base64,${b64("assets/start-here/logo.png")}` };
}

function cardHtml(c: Card, d: TemplateData): string {
  const e = escapeHtml;
  const badge = d.layout === "steps" ? `<div class="num">${c.index}</div>` : d.layout === "list" ? `<div class="dot"></div>` : "";
  const value = c.value ? `<div class="value">${e(c.value)}</div>` : "";
  const head = c.heading ? `<div class="h">${e(c.heading)}</div>` : "";
  const body = c.body ? `<div class="b">${e(c.body)}</div>` : "";
  const bullets = c.bullets.length ? `<ul>${c.bullets.map((b) => `<li>${e(b)}</li>`).join("")}</ul>` : "";
  const inner = d.layout === "stat" ? `${value}${head}${body}${bullets}` : `${head}${value}${body}${bullets}`;
  return `<div class="card ${d.layout}">${badge}<div class="inner">${inner}</div></div>`;
}

export function renderHtml(d: TemplateData): string {
  const a = assets();
  const e = escapeHtml;
  const joiner = d.layout === "diagram-ish" && d.columns === 1 ? `<div class="arrow">↓</div>` : "";
  return `<!doctype html><html lang="${d.lang}"><head><meta charset="utf-8"><style>
${a.css}
*{margin:0;padding:0;box-sizing:border-box}
html,body{background:#050d14;overflow:hidden}
body{width:1080px;font-family:${d.fontStack};color:#fff;position:relative;overflow:hidden;-webkit-font-smoothing:antialiased}
.glow1{position:absolute;left:-20%;top:-300px;width:90%;height:900px;background:radial-gradient(48% 50% at 40% 45%,rgba(48,158,168,.30) 0%,rgba(48,158,168,.08) 55%,transparent 100%)}
.glow2{position:absolute;right:-30%;bottom:-400px;width:90%;height:900px;background:radial-gradient(50% 50% at 60% 50%,rgba(16,185,129,.20) 0%,rgba(16,185,129,.05) 55%,transparent 100%)}
.grid{position:absolute;inset:0;background-image:linear-gradient(rgba(34,211,238,.06) 1px,transparent 1px),linear-gradient(90deg,rgba(34,211,238,.06) 1px,transparent 1px);background-size:48px 48px;-webkit-mask-image:radial-gradient(80% 60% at 50% 20%,#000 20%,transparent 100%)}
.line{position:absolute;left:0;right:0;bottom:0;height:4px;background:linear-gradient(90deg,#22d3ee,#10b981 55%,transparent)}
.wrap{position:relative;padding:64px 72px 72px}
.brand{display:flex;align-items:center;gap:16px;margin-bottom:40px}
.brand img{width:64px;height:64px;border-radius:14px}
.brand span{font-family:Sora,sans-serif;font-weight:700;font-size:20px;letter-spacing:.3em;color:#22d3ee;text-transform:uppercase}
h1{font-weight:800;font-size:60px;line-height:1.12;letter-spacing:-.02em;word-break:break-word}
h1 .accent{background:linear-gradient(90deg,#fff 30%,#22d3ee);-webkit-background-clip:text;background-clip:text;color:transparent}
.sub{margin-top:18px;font-weight:600;font-size:26px;line-height:1.45;color:#93a4b3}
.cards{margin-top:48px;display:grid;grid-template-columns:repeat(${d.columns},1fr);gap:20px}
.card{display:flex;gap:24px;align-items:flex-start;padding:28px 32px;border-radius:20px;background:rgba(13,27,38,.78);border:1px solid rgba(34,211,238,.18);box-shadow:inset 0 1px 0 rgba(255,255,255,.04)}
.card.comparison,.card.stat{flex-direction:column}
.card.stat{align-items:center;text-align:center}
.num{flex:none;width:56px;height:56px;border-radius:16px;display:flex;align-items:center;justify-content:center;font-family:Sora,sans-serif;font-weight:800;font-size:26px;color:#050d14;background:linear-gradient(135deg,#22d3ee,#10b981)}
.dot{flex:none;width:14px;height:14px;margin-top:12px;border-radius:50%;background:linear-gradient(135deg,#22d3ee,#10b981);box-shadow:0 0 12px rgba(34,211,238,.6)}
.inner{min-width:0;flex:1}
.h{font-weight:700;font-size:30px;line-height:1.3}
.card.comparison .h{color:#22d3ee;padding-bottom:12px;margin-bottom:6px;border-bottom:1px solid rgba(34,211,238,.18)}
.b{margin-top:8px;font-weight:400;font-size:24px;line-height:1.55;color:#c3cfd9}
.value{font-family:Sora,${d.fontStack};font-weight:800;font-size:64px;line-height:1.1;background:linear-gradient(90deg,#22d3ee,#10b981);-webkit-background-clip:text;background-clip:text;color:transparent}
.card:not(.stat) .value{font-size:36px;margin-top:6px}
ul{list-style:none;margin-top:10px}
li{position:relative;padding-left:26px;font-size:23px;line-height:1.5;color:#c3cfd9;margin-top:6px}
li:before{content:"";position:absolute;left:4px;top:.62em;width:8px;height:8px;border-radius:50%;background:#10b981}
.arrow{text-align:center;color:#22d3ee;font-size:30px;line-height:1;margin:-6px 0}
.foot{margin-top:44px;font-size:21px;line-height:1.5;color:#93a4b3}
</style></head><body>
<div class="glow1"></div><div class="glow2"></div><div class="grid"></div><div class="line"></div>
<div class="wrap">
<div class="brand"><img src="${a.logo}" alt=""><span>BLKBöX</span></div>
<h1><span class="accent">${e(d.title)}</span></h1>
${d.subtitle ? `<div class="sub">${e(d.subtitle)}</div>` : ""}
<div class="cards">${d.cards.map((c) => cardHtml(c, d)).join(joiner)}</div>
${d.footer ? `<div class="foot">${e(d.footer)}</div>` : ""}
</div></body></html>`;
}

/** One shared headless Chromium; a fresh page per render, always closed. */
export class Renderer {
  private browser: Promise<Browser> | null = null;

  constructor(private executablePath = process.env.CHROMIUM_PATH) {}

  private launch(): Promise<Browser> {
    if (!this.browser) {
      this.browser = (async () => {
        const { chromium } = await import("playwright-core");
        const b = await chromium.launch({ executablePath: this.executablePath, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
        b.on("disconnected", () => { this.browser = null; });
        return b;
      })();
      this.browser.catch(() => { this.browser = null; });
    }
    return this.browser;
  }

  async renderHtml(html: string): Promise<Buffer> {
    const browser = await this.launch();
    const page = await browser.newPage({ viewport: { width: 1080, height: 800 }, deviceScaleFactor: 1 });
    try {
      await page.setContent(html, { waitUntil: "load" });
      await page.evaluate(() => document.fonts.ready);
      // Size to the body box: the backdrop glows overflow it on purpose and must not widen the image.
      const box = await page.evaluate(() => { const r = document.body.getBoundingClientRect(); return { w: Math.ceil(r.width), h: Math.ceil(r.height) }; });
      await page.setViewportSize({ width: box.w, height: box.h });
      return await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: box.w, height: box.h } });
    } finally {
      await page.close().catch(() => {});
    }
  }

  async render(ex: Extraction, lang: Lang): Promise<Buffer> {
    return this.renderHtml(renderHtml(buildTemplateData(ex, lang)));
  }

  async close() {
    const b = this.browser;
    this.browser = null;
    if (b) await (await b).close().catch(() => {});
  }
}
