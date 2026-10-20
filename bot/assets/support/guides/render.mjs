// Renders the help-desk guide cards the support assistant attaches to its answers.
// Text lives in text/<lang>.json (English is the source); output goes to <lang>/<key>.png,
// with English at the top level. The bot falls back to English for a missing language.
//   node assets/support/guides/render.mjs [chromium path] [lang ...]   (run from bot/)
import { chromium } from "playwright-core";
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BOT = join(HERE, "..", "..", "..");
const args = process.argv.slice(2);
const exe = args[0]?.includes("/") ? args.shift() : process.env.CHROMIUM_PATH;
const langs = args.length ? args : ["en", "zh", "ko", "id", "vi", "es", "pt", "tr", "ru", "ja"];

const W = 1600;
const H = 900;
// Fonts go in as data URLs: a page set with setContent can't load file:// URLs.
const woff2 = (path) => `url(data:font/woff2;base64,${readFileSync(join(BOT, "node_modules", "@fontsource", path)).toString("base64")}) format("woff2")`;
const font = (w) => `@font-face{font-family:Sora;src:${woff2(`sora/files/sora-latin-${w}-normal.woff2`)};font-weight:${w}}`;
const noto = (w) => `@font-face{font-family:"Noto Sans Embed";src:${woff2(`noto-sans/files/noto-sans-cyrillic-${w}-normal.woff2`)};font-weight:${w};unicode-range:U+0400-04FF}
@font-face{font-family:"Noto Sans Embed";src:${woff2(`noto-sans/files/noto-sans-vietnamese-${w}-normal.woff2`)};font-weight:${w};unicode-range:U+0102-0103,U+0110-0111,U+0128-0129,U+0168-0169,U+01A0-01A1,U+01AF-01B0,U+1EA0-1EF9}`;
const FONTS = `Sora,"Noto Sans Embed","Noto Sans CJK SC","Noto Sans","Noto Color Emoji",sans-serif`;
// Han characters differ between Chinese, Japanese and Korean, so each gets its own CJK face first.
const CJK = { zh: "Noto Sans CJK SC", ja: "Noto Sans CJK JP", ko: "Noto Sans CJK KR" };
const stack = (lang) => (CJK[lang] ? `Sora,"${CJK[lang]}","Noto Color Emoji",sans-serif` : FONTS);

const CSS = `${[500, 600, 700, 800].map(font).join("\n")}
${[500, 600, 700, 800].map(noto).join("\n")}
*{margin:0;box-sizing:border-box}
body{width:${W}px;height:100vh;background:#050d14;font-family:${FONTS};color:#fff;position:relative;overflow:hidden}
.glow1{position:absolute;left:10%;top:-45%;width:80%;height:120%;background:radial-gradient(50% 50% at 50% 50%,rgba(34,211,238,.18) 0%,rgba(34,211,238,.04) 50%,transparent 100%)}
.glow2{position:absolute;right:-15%;bottom:-60%;width:60%;height:120%;background:radial-gradient(50% 50% at 50% 50%,rgba(16,185,129,.14) 0%,transparent 60%)}
.grid{position:absolute;inset:0;background-image:linear-gradient(rgba(34,211,238,.05) 1px,transparent 1px),linear-gradient(90deg,rgba(34,211,238,.05) 1px,transparent 1px);background-size:48px 48px;-webkit-mask-image:radial-gradient(70% 90% at 50% 30%,#000 25%,transparent 100%)}
.line{position:absolute;left:0;right:0;bottom:0;height:4px;background:linear-gradient(90deg,#22d3ee,#10b981 55%,transparent)}
.head{position:relative;text-align:center;padding:46px 60px 0}
.kicker{font-weight:700;font-size:16px;letter-spacing:.3em;color:#22d3ee;text-transform:uppercase}
h1{font-weight:800;font-size:54px;letter-spacing:-.02em;margin-top:12px;line-height:1.1}
.sub{font-weight:600;font-size:21px;color:#93a4b3;margin-top:12px}
.foot{position:absolute;left:60px;right:60px;bottom:30px;text-align:center;font-weight:600;font-size:18px;color:#7a8fa1}
.foot b{color:#cfe9f2}
.row{position:relative;display:flex;gap:30px;padding:40px 60px 0;justify-content:center}
.num{width:44px;height:44px;flex:none;border-radius:50%;background:linear-gradient(135deg,#22d3ee,#10b981);color:#04202b;font-weight:800;font-size:22px;display:flex;align-items:center;justify-content:center}
.step{flex:1;display:flex;flex-direction:column;align-items:center;text-align:center}
.step .top{display:flex;align-items:center;gap:14px;margin-top:22px}
.step h2{font-weight:700;font-size:25px;letter-spacing:-.01em;text-align:left}
.step p{font-weight:500;font-size:18px;line-height:1.45;color:#a7b6c3;margin-top:10px;max-width:420px}
.hot{outline:3px solid #22d3ee;outline-offset:3px;border-radius:8px;box-shadow:0 0 0 8px rgba(34,211,238,.18)}
.dim{color:#64798c}
/* phone */
.phone{text-align:left;width:300px;height:420px;border-radius:36px;background:#0b1620;border:2px solid rgba(255,255,255,.14);padding:14px;position:relative;box-shadow:0 30px 60px rgba(0,0,0,.45)}
.screen{width:100%;height:100%;border-radius:24px;background:#111c26;overflow:hidden;position:relative;display:flex;flex-direction:column}
.pbar{height:52px;display:flex;align-items:center;gap:12px;padding:0 14px;border-bottom:1px solid rgba(255,255,255,.07);font-weight:700;font-size:16px}
.burger{width:28px;height:22px;display:flex;flex-direction:column;justify-content:space-between;padding:2px 3px}
.burger i{display:block;height:3px;border-radius:2px;background:#cfe0ea}
.msg{display:flex;gap:10px;padding:10px 14px}
.av{width:30px;height:30px;border-radius:50%;flex:none;background:rgba(255,255,255,.18)}
.av.c{background:linear-gradient(135deg,#22d3ee,#10b981)}
.lines{flex:1}
.lines i{display:block;height:8px;border-radius:4px;background:rgba(255,255,255,.12);margin-top:6px}
.lines b{display:block;font-size:12px;font-weight:700;color:#cfe0ea}
.input{margin:auto 12px 12px;height:40px;border-radius:20px;background:rgba(255,255,255,.07);display:flex;align-items:center;gap:10px;padding:0 6px;font-size:13px;color:#7a8fa1;font-weight:600}
.plus{width:28px;height:28px;border-radius:50%;background:rgba(255,255,255,.14);display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:700;color:#fff;line-height:1}
.srv{display:flex;height:100%}
.guilds{width:58px;background:#0a131b;display:flex;flex-direction:column;align-items:center;gap:10px;padding-top:12px}
.g{width:40px;height:40px;border-radius:14px;background:rgba(255,255,255,.12)}
.g.on{background:linear-gradient(135deg,#22d3ee,#10b981)}
.chs{flex:1;padding:12px 10px;font-size:13.5px;font-weight:600;color:#a7b6c3}
.chs .name{font-weight:800;color:#fff;font-size:14px;padding:2px 4px 10px;border-bottom:1px solid rgba(255,255,255,.07);margin-bottom:8px}
.cat{font-size:11px;font-weight:800;letter-spacing:.06em;color:#64798c;margin:10px 4px 5px;text-transform:uppercase}
.ch{padding:5px 6px;border-radius:6px;white-space:nowrap;overflow:hidden}
.ch.on{background:rgba(34,211,238,.16);color:#fff}
.th{padding:3px 6px 3px 22px;color:#8aa0b2;font-size:12.5px;position:relative}
.th:before{content:"";position:absolute;left:10px;top:0;width:8px;height:12px;border-left:2px solid #3b4d5c;border-bottom:2px solid #3b4d5c;border-bottom-left-radius:6px}
.ticon{margin-left:auto;width:30px;height:30px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:17px}
`;

const page = (body, cls = "") => `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body class="${cls}">
<div class="glow1"></div><div class="glow2"></div><div class="grid"></div><div class="line"></div>${body}</body></html>`;
const head = (t) => `<div class="head"><div class="kicker">${t.kicker}</div><h1>${t.title}</h1><div class="sub">${t.sub}</div></div>`;
const step = (n, title, text, art) => `<div class="step">${art}<div class="top"><div class="num">${n}</div><h2>${title}</h2></div><p>${text}</p></div>`;
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");

// A help-thread style chat, reused by several cards.
const chat = (t, { hotPlus = false, hotBurger = false, title = "help-desk" } = {}) => `<div class="phone"><div class="screen">
  <div class="pbar"><div class="burger ${hotBurger ? "hot" : ""}"><i></i><i></i><i></i></div><span># ${esc(title)}</span></div>
  <div class="msg"><div class="av c"></div><div class="lines"><b>BLKBöX</b><i style="width:90%"></i><i style="width:70%"></i></div></div>
  <div class="msg"><div class="av"></div><div class="lines"><b>${esc(t.you)}</b><i style="width:60%"></i></div></div>
  <div class="msg"><div class="av c"></div><div class="lines"><b>BLKBöX</b><i style="width:85%"></i><i style="width:50%"></i></div></div>
  <div class="input"><div class="plus ${hotPlus ? "hot" : ""}">+</div>${esc(t.typeHere)}</div>
</div></div>`;

const channelList = (t, { hot = "", threads = false, burger = false } = {}) => `<div class="phone"><div class="screen"><div class="srv">
  <div class="guilds"><div class="g"></div><div class="g on ${burger ? "hot" : ""}"></div><div class="g"></div><div class="g"></div></div>
  <div class="chs"><div class="name">BLKBöX Trading Floor</div>
    <div class="ch ${hot === "guide" ? "on hot" : ""}">【${esc(t.chGuide)}】</div>
    <div class="cat">${esc(t.catAnn)}</div>
    <div class="ch">📢 ${esc(t.chAnnouncements)}</div>
    <div class="ch">🔒 ${esc(t.chSignals)}</div>
    <div class="cat">${esc(t.catCom)}</div>
    <div class="ch ${hot === "general" ? "on hot" : ""}">💬 ${esc(t.chGeneral)}</div>
    <div class="ch ${hot === "help" ? "on hot" : ""}">☎️ ${esc(t.chHelp)}</div>
    ${threads ? `<div class="th ${hot === "thread" ? "hot" : ""}">🤖 ${esc(t.yourThread)}</div>` : ""}
    <div class="ch">😂 ${esc(t.chMemes)}</div>
  </div></div></div></div>`;

const threadsView = (t) => `<div class="phone"><div class="screen">
  <div class="pbar"><span># ${esc(t.chHelp)}</span><div class="ticon hot">🧵</div></div>
  <div style="padding:14px 14px 0;font-size:12px;font-weight:800;letter-spacing:.06em;color:#64798c;text-transform:uppercase">${esc(t.threadsLabel)}</div>
  <div class="msg"><div class="av c"></div><div class="lines"><b>🤖 ${esc(t.yourThread)}</b><i style="width:70%"></i></div></div>
  <div class="msg" style="opacity:.45"><div class="av"></div><div class="lines"><b>🙋 …</b><i style="width:50%"></i></div></div>
  <div class="msg" style="opacity:.3"><div class="av"></div><div class="lines"><b>🤖 …</b><i style="width:40%"></i></div></div>
</div></div>`;

const desktop = (t) => {
  const tag = (n, x, y) => `<div class="num" style="position:absolute;left:${x}px;top:${y}px;box-shadow:0 0 0 6px rgba(5,13,20,.85)">${n}</div>`;
  return `<div style="position:relative;width:900px;height:560px;border-radius:16px;background:#0b1620;border:2px solid rgba(255,255,255,.14);overflow:hidden;box-shadow:0 30px 60px rgba(0,0,0,.45);display:flex">
    <div class="guilds" style="width:72px;padding-top:16px"><div class="g on" style="width:48px;height:48px"></div><div class="g" style="width:48px;height:48px"></div><div class="g" style="width:48px;height:48px"></div></div>
    <div class="chs" style="width:230px;flex:none;background:#0e1922;font-size:14px">
      <div class="name">BLKBöX Trading Floor</div>
      <div class="ch">【${esc(t.chGuide)}】</div>
      <div class="cat">${esc(t.catAnn)}</div><div class="ch">📢 ${esc(t.chAnnouncements)}</div><div class="ch">🔒 ${esc(t.chSignals)}</div>
      <div class="cat">${esc(t.catCom)}</div><div class="ch">💬 ${esc(t.chGeneral)}</div><div class="ch on">☎️ ${esc(t.chHelp)}</div>
      <div class="th">🤖 ${esc(t.yourThread)}</div><div class="ch">😂 ${esc(t.chMemes)}</div>
    </div>
    <div style="flex:1;display:flex;flex-direction:column;background:#111c26">
      <div class="pbar" style="height:54px"><span># ${esc(t.chHelp)}</span><div class="ticon" style="margin-left:auto">🧵</div><div class="ticon">👥</div></div>
      <div class="msg"><div class="av c"></div><div class="lines"><b>BLKBöX</b><i style="width:80%"></i><i style="width:55%"></i></div></div>
      <div class="msg"><div class="av"></div><div class="lines"><b>${esc(t.you)}</b><i style="width:45%"></i></div></div>
      <div class="msg"><div class="av c"></div><div class="lines"><b>BLKBöX</b><i style="width:70%"></i></div></div>
      <div class="input" style="height:46px;border-radius:10px;margin:auto 16px 16px"><div class="plus">+</div>${esc(t.typeHere)}</div>
    </div>
    <div style="width:150px;background:#0e1922;padding:16px 12px">${[1, 2, 3, 4, 5].map((i) => `<div style="display:flex;gap:8px;align-items:center;margin-bottom:12px"><div class="av" style="width:26px;height:26px;${i === 1 ? "background:linear-gradient(135deg,#22d3ee,#10b981)" : ""}"></div><div style="height:8px;flex:1;border-radius:4px;background:rgba(255,255,255,.12)"></div></div>`).join("")}</div>
    ${tag(1, 14, 250)}${tag(2, 250, 8)}${tag(3, 560, 300)}${tag(4, 700, 498)}${tag(5, 580, 8)}${tag(6, 830, 200)}
  </div>`;
};

const legend = (items) => `<div style="width:520px;display:flex;flex-direction:column;gap:20px;justify-content:center">${items
  .map(([n, h, p]) => `<div style="display:flex;gap:16px;align-items:flex-start"><div class="num">${n}</div><div><div style="font-weight:700;font-size:23px">${h}</div><div style="font-weight:500;font-size:17px;color:#a7b6c3;margin-top:4px;line-height:1.4">${p}</div></div></div>`)
  .join("")}</div>`;

const modal = (t) => `<div class="phone"><div class="screen" style="justify-content:center;padding:18px;background:#0d1821">
  <div style="background:#16242f;border-radius:16px;padding:18px;border:1px solid rgba(255,255,255,.1)">
    <div style="font-weight:800;font-size:16px">${esc(t.verifyModal)}</div>
    <div style="font-size:11px;font-weight:800;letter-spacing:.06em;color:#64798c;margin-top:16px;text-transform:uppercase">${esc(t.exchange)}</div>
    <div style="margin-top:6px;padding:10px 12px;border-radius:8px;background:#0b141c;font-size:14px;font-weight:600;display:flex">Bybit<span style="margin-left:auto;color:#64798c">▾</span></div>
    <div style="font-size:11px;font-weight:800;letter-spacing:.06em;color:#64798c;margin-top:14px;text-transform:uppercase">UID</div>
    <div class="hot" style="margin-top:8px;padding:10px 12px;border-radius:8px;background:#0b141c;font-size:15px;font-weight:700;letter-spacing:.04em">123456789</div>
    <div style="margin-top:18px;padding:10px;border-radius:8px;background:#5865f2;text-align:center;font-weight:700;font-size:14px">${esc(t.submit)}</div>
  </div></div></div>`;

const lockedPanel = (t) => `<div class="phone"><div class="screen">
  <div class="pbar"><span>🔒 ${esc(t.chSignals)}</span></div>
  <div class="msg"><div class="av c"></div><div class="lines"><b>BLKBöX</b>
    <div style="margin-top:8px;font-weight:800;font-size:14px">🔒 ${esc(t.verifyTitle)}</div><i style="width:90%"></i><i style="width:75%"></i><i style="width:60%"></i>
    <div class="hot" style="margin-top:14px;display:inline-block;padding:9px 16px;border-radius:8px;background:#248046;font-weight:700;font-size:13px">${esc(t.verifyButton)}</div>
  </div></div></div></div>`;

const signupArt = (t) => `<div class="phone"><div class="screen">
  <div class="pbar"><span>【${esc(t.chGuide)}】</span></div>
  <div style="padding:14px"><div style="font-weight:800;font-size:15px">${esc(t.step2Card)}</div>
    <i style="display:block;height:8px;border-radius:4px;background:rgba(255,255,255,.12);margin-top:10px;width:90%"></i>
    <i style="display:block;height:8px;border-radius:4px;background:rgba(255,255,255,.12);margin-top:6px;width:70%"></i>
    <div style="display:flex;flex-direction:column;gap:10px;margin-top:18px">${["Bybit", "Bitget", "Blofin"].map((x, i) => `<div class="${i === 0 ? "hot" : ""}" style="padding:10px 12px;border-radius:8px;background:#4e5058;font-weight:700;font-size:14px;display:flex">${x}<span style="margin-left:auto">↗</span></div>`).join("")}</div>
  </div></div></div>`;

const uidArt = (t) => `<div class="phone"><div class="screen">
  <div class="pbar"><div class="av hot" style="width:30px;height:30px"></div><span style="margin-left:6px">${esc(t.profile)}</span></div>
  <div style="padding:16px"><div style="display:flex;gap:10px;align-items:center"><div class="av" style="width:44px;height:44px"></div><div style="flex:1"><i style="display:block;height:9px;border-radius:5px;background:rgba(255,255,255,.18);width:70%"></i></div></div>
    <div class="hot" style="margin-top:18px;display:flex;align-items:center;justify-content:space-between;padding:11px 12px;border-radius:9px;background:rgba(34,211,238,.10)"><b style="font-size:15px;letter-spacing:.03em">UID 123456789</b><span style="font-size:16px">⧉</span></div>
    <i style="display:block;height:8px;border-radius:4px;background:rgba(255,255,255,.1);margin-top:16px;width:80%"></i>
    <i style="display:block;height:8px;border-radius:4px;background:rgba(255,255,255,.1);margin-top:8px;width:55%"></i>
  </div></div></div>`;

const column = (title, color, items) => `<div style="flex:1;max-width:640px;background:rgba(255,255,255,.035);border:1px solid ${color}40;border-radius:22px;padding:26px 30px">
  <div style="font-weight:800;font-size:26px;color:${color}">${title}</div>
  ${items.map(([name, what]) => `<div style="display:flex;gap:16px;align-items:baseline;margin-top:15px"><div style="font-weight:700;font-size:20px;min-width:250px;white-space:nowrap">${esc(name)}</div><div style="font-weight:500;font-size:17px;color:#a7b6c3">${esc(what)}</div></div>`).join("")}
</div>`;

// The two list cards have less to show, so they are shorter.
const HEIGHT = { "channel-map": 640, scams: 640 };

const CARDS = {
  "discord-mobile": (t) => page(`${head(t.mobile)}<div class="row">
    ${step(1, t.mobile.s1, t.mobile.s1p, chat(t, { hotBurger: true, title: t.chGeneral }))}
    ${step(2, t.mobile.s2, t.mobile.s2p, channelList(t, { hot: "general" }))}
    ${step(3, t.mobile.s3, t.mobile.s3p, threadsView(t))}
  </div>`),
  "discord-desktop": (t) => page(`${head(t.desktop)}<div class="row" style="gap:50px;align-items:center;padding-top:34px">${desktop(t)}${legend([
    [1, t.desktop.l1, t.desktop.l1p], [2, t.desktop.l2, t.desktop.l2p], [3, t.desktop.l3, t.desktop.l3p],
    [4, t.desktop.l4, t.desktop.l4p], [5, t.desktop.l5, t.desktop.l5p], [6, t.desktop.l6, t.desktop.l6p],
  ])}</div>`),
  "help-thread": (t) => page(`${head(t.help)}<div class="row">
    ${step(1, t.help.s1, t.help.s1p, `<div class="phone"><div class="screen"><div class="pbar"><span>☎️ ${esc(t.chHelp)}</span></div><div class="msg"><div class="av c"></div><div class="lines"><b>BLKBöX</b><div style="margin-top:8px;font-weight:800;font-size:14px">🛟 ${esc(t.help.panel)}</div><i style="width:90%"></i><i style="width:70%"></i><div class="hot" style="margin-top:14px;display:inline-block;padding:9px 16px;border-radius:8px;background:#5865f2;font-weight:700;font-size:13px">🛟 ${esc(t.help.getHelp)}</div></div></div></div></div>`)}
    ${step(2, t.help.s2, t.help.s2p, `<div class="phone"><div class="screen"><div class="pbar"><span>☎️ ${esc(t.chHelp)}</span></div><div style="margin:auto 12px 16px;background:#16242f;border-radius:12px;padding:14px;border:1px solid rgba(255,255,255,.1)"><div style="font-size:11px;color:#64798c;font-weight:700">${esc(t.help.onlyYou)}</div><i style="display:block;height:8px;border-radius:4px;background:rgba(255,255,255,.12);margin-top:8px;width:90%"></i><i style="display:block;height:8px;border-radius:4px;background:rgba(255,255,255,.12);margin-top:6px;width:60%"></i><div class="hot" style="margin-top:12px;padding:9px 12px;border-radius:8px;background:#4e5058;font-weight:700;font-size:13px">🛟 ${esc(t.help.openThread)} ↗</div></div></div></div>`)}
    ${step(3, t.help.s3, t.help.s3p, chat(t, { hotPlus: true, title: "🤖 " + t.yourThread }))}
  </div><div class="foot">${t.help.foot}</div>`),
  verify: (t) => page(`${head(t.verify)}<div class="row">
    ${step(1, t.verify.s1, t.verify.s1p, signupArt(t))}
    ${step(2, t.verify.s2, t.verify.s2p, uidArt(t))}
    ${step(3, t.verify.s3, t.verify.s3p, `<div style="display:flex;gap:0">${lockedPanel(t)}</div>`)}
  </div><div class="foot">${t.verify.foot}</div>`),
  "channel-map": (t) => page(`${head(t.map)}<div class="row" style="gap:36px;padding-top:38px">
    ${column(t.map.open, "#22d3ee", t.map.openItems)}
    ${column(t.map.locked, "#10b981", t.map.lockedItems)}
  </div><div class="foot">${t.map.foot}</div>`),
  scams: (t) => page(`${head(t.scams)}<div class="row" style="gap:36px;padding-top:40px">
    <div style="flex:1;max-width:640px;background:rgba(239,68,68,.06);border:1px solid rgba(239,68,68,.35);border-radius:22px;padding:28px 32px">
      <div style="font-weight:800;font-size:27px;color:#f87171">${t.scams.never}</div>
      ${t.scams.neverItems.map((x) => `<div style="display:flex;gap:14px;align-items:center;margin-top:18px;font-weight:600;font-size:20px"><span style="width:34px;height:34px;flex:none;border-radius:50%;background:rgba(239,68,68,.18);color:#f87171;display:flex;align-items:center;justify-content:center;font-weight:800">✕</span>${x}</div>`).join("")}
    </div>
    <div style="flex:1;max-width:640px;background:rgba(16,185,129,.06);border:1px solid rgba(16,185,129,.35);border-radius:22px;padding:28px 32px">
      <div style="font-weight:800;font-size:27px;color:#34d399">${t.scams.do}</div>
      ${t.scams.doItems.map((x) => `<div style="display:flex;gap:14px;align-items:center;margin-top:18px;font-weight:600;font-size:20px"><span style="width:34px;height:34px;flex:none;border-radius:50%;background:rgba(16,185,129,.18);color:#34d399;display:flex;align-items:center;justify-content:center;font-weight:800">✓</span>${x}</div>`).join("")}
    </div>
  </div><div class="foot">${t.scams.foot}</div>`),
};

const en = JSON.parse(readFileSync(join(HERE, "text", "en.json"), "utf8"));
const browser = await chromium.launch(exe ? { executablePath: exe, args: ["--no-sandbox"] } : { args: ["--no-sandbox"] });
const tab = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
for (const lang of langs) {
  const file = join(HERE, "text", `${lang}.json`);
  if (!existsSync(file)) { console.log("skip", lang); continue; }
  // A missing string falls back to English, one level deep.
  const own = JSON.parse(readFileSync(file, "utf8"));
  const t = Object.fromEntries(Object.entries(en).map(([k, v]) => [k, v && typeof v === "object" && !Array.isArray(v) ? { ...v, ...(own[k] ?? {}) } : own[k] ?? v]));
  const out = lang === "en" ? HERE : join(HERE, lang);
  mkdirSync(out, { recursive: true });
  for (const [key, card] of Object.entries(CARDS)) {
    await tab.setViewportSize({ width: W, height: HEIGHT[key] ?? H });
    await tab.setContent(card(t), { waitUntil: "load" });
    await tab.evaluate((f) => { document.body.style.fontFamily = f; }, stack(lang));
    await tab.evaluate(() => document.fonts.ready);
    // Shrink a headline that runs past the edges in a long language.
    await tab.evaluate(() => {
      const h = document.querySelector("h1");
      for (let s = 54; h && h.scrollWidth > h.clientWidth && s > 34; s -= 2) h.style.fontSize = s + "px";
    });
    await tab.screenshot({ path: join(out, `${key}.png`), type: "png" });
  }
  console.log("rendered", lang);
}
await browser.close();
