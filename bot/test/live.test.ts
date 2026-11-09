import { test } from "node:test";
import assert from "node:assert/strict";
import { parseYoutubeLive, platformOf, twitchLogin, youtubeLivePage } from "../src/live/detect.js";
import { liveMessage, LIVE_TEXT } from "../src/live/announce.js";
import { LANGS } from "../src/config.js";

const page = (live: boolean) => `<html><head><link rel="canonical" href="https://www.youtube.com/watch?v=dQw4w9WgXcQ">
<meta name="title" content="BTC &amp; alts: weekly outlook &#39;live&#39;"></head>
<script>var ytInitialPlayerResponse = {"videoDetails":{"videoId":"dQw4w9WgXcQ"},"microformat":{"playerMicroformatRenderer":{"liveBroadcastDetails":{"isLiveNow":${live},"startTimestamp":"2026-11-02T10:00:00+00:00"}}}};</script></html>`;

test("a YouTube /live page on air gives the broadcast, a scheduled or idle one gives nothing", () => {
  assert.deepEqual(parseYoutubeLive(page(true)), { id: "dQw4w9WgXcQ", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", title: "BTC & alts: weekly outlook 'live'", startedAt: "2026-11-02T10:00:00+00:00" });
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

test("a YouTube feed gives its videos, newest first, and channel pages give the UC id", async () => {
  const { parseFeed, parseChannelId } = await import("../src/live/detect.js");
  const xml = `<feed><entry><id>yt:video:AAAAAAAAAAA</id><yt:videoId>AAAAAAAAAAA</yt:videoId><title>BTC &amp; the halving</title><published>2026-11-02T10:00:00+00:00</published></entry>
<entry><id>yt:video:BBBBBBBBBBB</id><yt:videoId>BBBBBBBBBBB</yt:videoId><title>Older</title><published>2026-10-30T10:00:00+00:00</published></entry></feed>`;
  assert.deepEqual(parseFeed(xml).map((u) => [u.id, u.title, u.published]), [["AAAAAAAAAAA", "BTC & the halving", "2026-11-02T10:00:00+00:00"], ["BBBBBBBBBBB", "Older", "2026-10-30T10:00:00+00:00"]]);
  assert.equal(parseChannelId(`<link rel="alternate" type="application/rss+xml" title="RSS" href="https://www.youtube.com/feeds/videos.xml?channel_id=UCabcdefghijklmnopqrstuv">`), "UCabcdefghijklmnopqrstuv");
  assert.equal(parseChannelId(`{"externalId":"UCabcdefghijklmnopqrstuv"}`), "UCabcdefghijklmnopqrstuv");
  assert.equal(parseChannelId("<html></html>"), null);
});

test("a new-video alert reads differently from a live one", () => {
  assert.equal(
    liveMessage("es", { who: "Tone", platform: "YouTube", url: "https://youtu.be/x", title: "Plan", kind: "video" }, "9"),
    "<@&9> 🎬 **NUEVO VIDEO** · **Tone** · YouTube\n> Plan\nMíralo ya: https://youtu.be/x",
  );
});

test("a stream the player marks live counts too, and its start time comes back for the delay log", () => {
  const html = `<link rel="canonical" href="https://www.youtube.com/watch?v=dQw4w9WgXcQ"><script>{"videoDetails":{"videoId":"dQw4w9WgXcQ","thumbnail":{"thumbnails":[{"url":"x"}]},"isLive":true},"microformat":{"playerMicroformatRenderer":{"liveBroadcastDetails":{"startTimestamp":"2026-11-09T00:00:00+00:00"}}}}</script>`;
  const live = parseYoutubeLive(html);
  assert.equal(live?.id, "dQw4w9WgXcQ");
  assert.equal(live?.startedAt, "2026-11-09T00:00:00+00:00");
  assert.equal(parseYoutubeLive(page(true))?.startedAt, "2026-11-02T10:00:00+00:00");
});
