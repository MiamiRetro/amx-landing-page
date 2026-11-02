import { test } from "node:test";
import assert from "node:assert/strict";
import { parseYoutubeLive, platformOf, twitchLogin, youtubeLivePage } from "../src/live/detect.js";
import { liveMessage, LIVE_TEXT } from "../src/live/announce.js";
import { LANGS } from "../src/config.js";

const page = (live: boolean) => `<html><head><link rel="canonical" href="https://www.youtube.com/watch?v=dQw4w9WgXcQ">
<meta name="title" content="BTC &amp; alts: weekly outlook &#39;live&#39;"></head>
<script>var ytInitialPlayerResponse = {"videoDetails":{"videoId":"dQw4w9WgXcQ"},"microformat":{"playerMicroformatRenderer":{"liveBroadcastDetails":{"isLiveNow":${live},"startTimestamp":"2026-11-02T10:00:00+00:00"}}}};</script></html>`;

test("a YouTube /live page on air gives the broadcast, a scheduled or idle one gives nothing", () => {
  assert.deepEqual(parseYoutubeLive(page(true)), { id: "dQw4w9WgXcQ", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", title: "BTC & alts: weekly outlook 'live'" });
  assert.equal(parseYoutubeLive(page(false)), null);
  assert.equal(parseYoutubeLive(`<link rel="canonical" href="https://www.youtube.com/@someone">`), null);
});

test("channel inputs become the right /live page and Twitch login", () => {
  assert.equal(youtubeLivePage("@alphanumetrix"), "https://www.youtube.com/@alphanumetrix/live");
  assert.equal(youtubeLivePage("alphanumetrix"), "https://www.youtube.com/@alphanumetrix/live");
  assert.equal(youtubeLivePage("UCabcdefghijklmnopqrstuv"), "https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv/live");
  assert.equal(youtubeLivePage("https://www.youtube.com/@x/"), "https://www.youtube.com/@x/live");
  assert.equal(twitchLogin("https://www.twitch.tv/SomeOne"), "someone");
  assert.equal(twitchLogin("@SomeOne"), "someone");
});

test("platform names come from the link", () => {
  assert.equal(platformOf("https://youtu.be/abc"), "YouTube");
  assert.equal(platformOf("https://www.youtube.com/watch?v=x"), "YouTube");
  assert.equal(platformOf("https://x.com/i/broadcasts/1"), "X");
  assert.equal(platformOf("https://www.tiktok.com/@a/live"), "TikTok");
  assert.equal(platformOf("https://example.com"), "");
  assert.equal(platformOf("not a url"), "");
});

test("every language has alert text; the alert pings the role and keeps the link bare", () => {
  for (const l of LANGS) assert.ok(LIVE_TEXT[l]?.live && LIVE_TEXT[l]?.join, l);
  const m = liveMessage("en", { who: "Tone", platform: "YouTube", url: "https://youtu.be/x", title: "  Market   open " }, "123");
  assert.equal(m, "<@&123> 🔴 **LIVE NOW** · **Tone** · YouTube\n> Market open\nJoin the stream: https://youtu.be/x");
  assert.equal(liveMessage("ja", { who: "Matt", platform: "", url: "https://a.b" }), "🔴 **ライブ配信中** · **Matt**\n配信はこちら： https://a.b");
});
