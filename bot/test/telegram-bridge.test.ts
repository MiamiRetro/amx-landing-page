import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, explicitTag, keywordChannel, parseModelPick } from "../src/telegram/classify.js";
import { discordReplyHeader, discordToTelegram, fitDiscord, splitReplyHeader, telegramPost, telegramToDiscord, VIA_LINE } from "../src/telegram/format.js";
import { matchUser, moveButtons, parseUsers, DEFAULT_USERS } from "../src/telegram/bridge.js";

const names = { user: (id: string) => (id === "1" ? "Ana" : null), channel: (id: string) => (id === "2" ? "bitcoin" : null), role: () => "VIP 1" };

test("tags pick the channel and are taken out of the text", () => {
  assert.deepEqual(explicitTag("/btc weekly close above 100k"), { channel: "bitcoin", text: "weekly close above 100k" });
  assert.deepEqual(explicitTag("#stocks NVDA earnings tonight"), { channel: "stocks", text: "NVDA earnings tonight" });
  assert.deepEqual(explicitTag("alts look heavy #crypto"), { channel: "crypto", text: "alts look heavy" });
  assert.deepEqual(explicitTag("/general@DailyHighBot gm"), { channel: "general", text: "gm" });
  assert.equal(explicitTag("/help"), null);
  assert.equal(explicitTag("no tag here"), null);
});

test("keywords route the obvious ones and leave ties alone", () => {
  assert.equal(keywordChannel("BTC just reclaimed the weekly level"), "bitcoin");
  assert.equal(keywordChannel("Saylor bought more sats"), "bitcoin");
  assert.equal(keywordChannel("SPX and the Fed tomorrow"), "stocks");
  assert.equal(keywordChannel("$AAPL and $TSLA gapping up"), "stocks");
  assert.equal(keywordChannel("ETH and SOL bleeding, altseason cancelled"), "crypto");
  assert.equal(keywordChannel("gm everyone, see you on the show"), null);
  assert.equal(keywordChannel("here's the link to the stream"), null);
});

test("classify falls back to the model, then general", async () => {
  assert.deepEqual(await classify("/stocks gold"), { channel: "stocks", text: "gold", by: "tag" });
  assert.equal((await classify("BTC to the moon")).by, "keywords");
  const model = async () => ({ channel: "crypto" as const, confidence: 0.9 });
  assert.deepEqual(await classify("what do you all think of the new chain launch", model), { channel: "crypto", text: "what do you all think of the new chain launch", by: "model" });
  const unsure = async () => ({ channel: "crypto" as const, confidence: 0.3 });
  assert.equal((await classify("what do you all think of the new chain launch", unsure)).channel, "general");
  const broken = async () => { throw new Error("down"); };
  assert.equal((await classify("what do you all think of the new chain launch", broken)).by, "default");
});

test("model replies parse even with fences or junk", () => {
  assert.deepEqual(parseModelPick('```json\n{"channel":"bitcoin","confidence":0.82}\n```'), { channel: "bitcoin", confidence: 0.82 });
  assert.equal(parseModelPick('{"channel":"memes","confidence":1}'), null);
  assert.equal(parseModelPick("bitcoin"), null);
});

test("Discord text becomes safe Telegram HTML", () => {
  assert.equal(discordToTelegram("hi <@1> see <#2> **now** <:BLKglow:123> a<b", names), "hi @Ana see #bitcoin <b>now</b> :BLKglow: a&lt;b");
  assert.equal(discordToTelegram("`x**y**` and ||secret||", names), "<code>x**y**</code> and <tg-spoiler>secret</tg-spoiler>");
  assert.equal(discordToTelegram("text\n-# ⏳ translation pending", names), "text");
  assert.equal(discordToTelegram("[chart](https://tradingview.com/x/abc)", names), '<a href="https://tradingview.com/x/abc">chart</a>');
});

test("Telegram posts carry channel, author and source-language flag", () => {
  assert.equal(telegramPost("bitcoin", "Ana", "hello"), "<b>Ana</b> · <i>₿ bitcoin</i>\nhello");
  assert.equal(telegramPost("general", "민수", "hi", "ko"), "<b>민수</b> 🇰🇷 · <i>💬 general</i>\nhi");
  assert.equal(telegramPost("stocks", "<x>", "", "en"), "<b>&lt;x&gt;</b> · <i>📈 stocks</i>");
});

test("the mirror's reply header is read back into a parent link", () => {
  const h = discordReplyHeader("9", "22", "33", "Tone Vays", "BTC weekly close looks strong");
  assert.equal(h, "[↩](https://discord.com/channels/9/22/33) **Tone Vays**: BTC weekly close looks strong");
  const split = splitReplyHeader(`${h}\nagreed!`);
  assert.deepEqual(split, { parent: { channelId: "22", messageId: "33" }, rest: "agreed!" });
  assert.deepEqual(splitReplyHeader("plain"), { parent: null, rest: "plain" });
});

test("host posts end with the grey via Telegram line and fit Discord", () => {
  assert.equal(telegramToDiscord(" gm ", null), `gm\n${VIA_LINE}`);
  assert.equal(telegramToDiscord("yes", "[↩](x) **A**: b"), `[↩](x) **A**: b\nyes\n${VIA_LINE}`);
  const long = fitDiscord(telegramToDiscord("a".repeat(3000), null));
  assert.equal(long.length, 2000);
  assert.ok(long.endsWith(VIA_LINE));
});

test("only listed hosts are bridged, matched by username or id", () => {
  const users = parseUsers('[{"telegram":"@ToneVays","name":"Tone Vays"},{"telegram":"42"}]');
  assert.equal(matchUser(users, { id: 7, is_bot: false, first_name: "T", username: "tonevays" })?.name, "Tone Vays");
  assert.equal(matchUser(users, { id: 42, is_bot: false, first_name: "X" })?.telegram, "42");
  assert.equal(matchUser(users, { id: 8, is_bot: false, first_name: "Rando", username: "rando" }), null);
  assert.equal(matchUser(users, { id: 42, is_bot: true, first_name: "bot" }), null);
  assert.deepEqual(parseUsers(undefined), DEFAULT_USERS);
  assert.throws(() => parseUsers('[{"name":"no handle"}]'));
});

test("move buttons offer the other three channels", () => {
  const rows = moveButtons(5, "bitcoin");
  assert.deepEqual(rows[0].map((b) => b.callback_data), ["mv:5:general", "mv:5:stocks", "mv:5:crypto"]);
});

test("previews: a URL becomes a small thumbnail, auto lets Telegram preview the text's link, nothing means none", async () => {
  const { previewOptions } = await import("../src/telegram/api.js");
  assert.deepEqual(previewOptions("https://cdn.discordapp.com/avatars/1/a.png?size=128"), { url: "https://cdn.discordapp.com/avatars/1/a.png?size=128", prefer_small_media: true, show_above_text: false });
  assert.deepEqual(previewOptions(null), { is_disabled: true });
  assert.equal(previewOptions("auto"), undefined);
});

test("Tone's picture ships with the bot and is found by his Telegram username", async () => {
  const { avatarFile } = await import("../src/telegram/bridge.js");
  assert.ok(avatarFile({ telegram: "ToneVays" })?.endsWith("tonevays.png"));
  assert.equal(avatarFile({ telegram: "nobody_here" }), null);
});

test("a reply to a member opens with their mention on the same line, and only they can be pinged", async () => {
  const { mentionedUsers } = await import("../src/telegram/format.js");
  assert.equal(telegramToDiscord("good question", "<@123>"), `<@123> good question\n${VIA_LINE}`);
  assert.deepEqual(mentionedUsers("<@123>"), ["123"]);
  assert.deepEqual(mentionedUsers(null), []);
  assert.deepEqual(mentionedUsers("[↩](x) **A**: b"), []);
});

test("reaction counts read most-first; Telegram reactions are matched without the variation selector", async () => {
  const { reactionLine, telegramEmoji } = await import("../src/telegram/format.js");
  assert.equal(reactionLine([{ emoji: "🔥", count: 2 }, { emoji: "❤️", count: 4 }, { emoji: ":BLKglow:", count: 1 }, { emoji: "👀", count: 0 }]), "❤️ 4 · 🔥 2 · :BLKglow: 1");
  assert.equal(telegramEmoji("❤️"), "❤");
  assert.equal(telegramEmoji("🔥"), "🔥");
  assert.equal(telegramEmoji(":BLKglow:"), null);
  assert.equal(telegramEmoji("🚀"), null);
});
