// Renders the guide banners (hero, rules, start, community) for each language into <lang>/.
// Headlines come from ../i18n/guide/<lang>.json. The white glowing logo is lifted from the
// English hero.png, since logo-white.png is not in the repo.
//   node render-i18n.mjs [chromium path] [lang ...]
import { chromium } from "playwright-core";
import { readFileSync, mkdirSync, existsSync } from "node:fs";
const args = process.argv.slice(2);
const exe = args[0] && args[0].includes("/") ? args.shift() : undefined;
const langs = args.length ? args : ["zh", "ko", "id", "vi", "es", "pt", "tr", "ru", "ja"];
const FONTS = `Sora,"Noto Sans","Helvetica Neue",Arial,"PingFang SC","Hiragino Sans","Apple SD Gothic Neo",sans-serif`;
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
const page = await browser.newPage({ viewport: { width: 1200, height: 520 }, deviceScaleFactor: 1 });
await page.goto("file://" + process.cwd() + "/banner.html");
// Cut the logo (and its glow) out of the English hero and fade the edges into the backdrop.
const shot = await browser.newPage({ viewport: { width: 1200, height: 520 } });
await shot.goto("file://" + process.cwd() + "/hero.png");
const logo = "data:image/png;base64," + (await shot.screenshot({ clip: { x: 490, y: 50, width: 220, height: 200 } })).toString("base64");
await shot.close();
// Sora is Latin only: Noto Sans carries Cyrillic and Vietnamese at the same weights.
for (const w of [600, 700, 800]) await page.addStyleTag({ url: "file://" + process.cwd() + `/node_modules/@fontsource/noto-sans/${w}.css` });
await page.addStyleTag({ content: `
  body{font-family:${FONTS}}
  .logo{background:url(${logo}) center/contain no-repeat !important;filter:none !important;
        -webkit-mask-image:radial-gradient(closest-side,#000 70%,transparent 100%);mask-image:radial-gradient(closest-side,#000 70%,transparent 100%)}
  .logo{width:190px !important;height:173px !important}
  body.hero .logo{width:220px !important;height:200px !important;margin-bottom:-14px}
  body.hero .bloom{display:none}
` });
for (const lang of langs) {
  const file = `../i18n/guide/${lang}.json`;
  if (!existsSync(file)) { console.log("skip", lang); continue; }
  const t = JSON.parse(readFileSync(file, "utf8"));
  const specs = [
    { file: "hero.png", mode: "hero", w: 1200, h: 520, kicker: "BLKBöX Trading Floor", title: `${t.bannerHeroLine1}<br><span class="accent">${t.bannerHeroLine2}</span>`, sub: t.bannerHeroSub },
    { file: "rules.png", w: 1200, h: 300, kicker: t.bannerRulesKicker, title: t.bannerRulesTitle, sub: t.bannerRulesSub },
    { file: "start.png", w: 1200, h: 300, kicker: t.bannerStartKicker, title: t.bannerStartTitle, sub: t.bannerStartSub },
    { file: "community.png", w: 1200, h: 300, kicker: t.bannerCommunityKicker, title: t.bannerCommunityTitle.replace("&", "&amp;"), sub: t.bannerCommunitySub, sm: true },
  ];
  mkdirSync(lang, { recursive: true });
  for (const s of specs) {
    await page.setViewportSize({ width: s.w, height: s.h });
    await page.evaluate((s) => {
      document.body.className = s.mode ?? "";
      document.querySelector(".hero-only").style.display = s.mode === "hero" ? "block" : "none";
      document.querySelector(".side-only").style.display = s.mode === "hero" ? "none" : "block";
      document.getElementById("kicker").textContent = s.kicker ?? "";
      document.getElementById("title").innerHTML = s.title ?? "";
      // Long translations shrink rather than run into the logo.
      const el = document.getElementById("title");
      el.className = "title" + (s.sm ? " sm" : "");
      el.style.fontSize = "";
      const max = s.mode === "hero" ? 1100 : 860;
      for (let size = parseFloat(getComputedStyle(el).fontSize); el.scrollWidth > max && size > 30; size -= 2) el.style.fontSize = size + "px";
      document.getElementById("sub").textContent = s.sub ?? "";
    }, s);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: `${lang}/${s.file}`, type: "png" });
  }
  console.log("rendered", lang);
}
await browser.close();
