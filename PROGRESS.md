# AlphanumetriX landing page — progress

Read by the OS (#landing-page). Audited 2026-10-06. A finished-looking redesign
of alphanumetrix.com that isn't released yet: nothing public links to it.

Live: https://amx-landing-page.vercel.app (new page, no custom domain) ·
https://www.alphanumetrix.com (current Wix store — every CTA on the new page links there)

The Discord bot that shares this repo tracks its to-dos in
docs/discord-bot/translator-PROGRESS.md and verification-PROGRESS.md.

## Shipped
- [x] One-page site: hero with count-up stats, About, three product cards (AMX Indicator, Float, BLKBöX bot), Features, FAQ, CTA, footer
- [x] Responsive layout (1024 / 768 / 480 breakpoints), mobile nav, FAQ accordion, scroll animations
- [x] Deployed to Vercel production; outbound links to alphanumetrix.com, X and Facebook all checked
- [x] .vercelignore keeps bot/, docs/ and this file out of the published site (2026-10-06)

## Launch
- [ ] Decide the domain cutover — alphanumetrix.com is still the Wix store and every CTA links to its product / shop pages, so pointing the domain here breaks those links unless the store moves first (e.g. shop.alphanumetrix.com)
- [ ] Fix stale copy — "works with Bitget & OKX" on the BLKBöX card and in the FAQ (the community verifies Bitget / Blofin / Bybit), © 2025 in the footer, and confirm the hero stats ("Trading Since 2015", "94 Currencies Supported") (index.html ~49, 70-76, 245, 352, 434)
- [ ] Social previews and crawl files — og:image is a relative path that crawlers won't resolve; add og:url, og:type, twitter:card, robots.txt, sitemap.xml and a favicon (the last three 404 today)

## Funnel
- [ ] Wire the page into the funnel — no analytics or UTM capture, and no link to the Discord or the BLKBöX app; website events are step 5 of docs/funnel-and-tracking-plan.md (on the bot branch)

## Cleanup
- [ ] Trim assets — chart-3.jpg, social-icon-1.png, social-icon-2.png and amx-logo-wide.jpg are unused; compress hero-bg.jpg (476 KB) and amx-badge.png (220 KB)
- [ ] Skip Vercel builds for bot-branch pushes — every push to a claude/* branch builds a landing-page preview; add an Ignored Build Step in the Vercel project settings
