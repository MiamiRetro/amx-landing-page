# Subscriber to verified member: the flow, and how we track it

Status: plan, nothing built yet. Written 2026-09-23.

## 1. What we can and cannot see today

Working and instrumented:

- UID verification in Discord, against the live Bitget, Blofin and Bybit affiliate APIs.
- Every verification attempt and its outcome, in `verification_attempts`.
- Language choice per member, in `language_prefs`.

Not instrumented, and this is the gap:

- **Two separate verifications.** A member verifies a UID on app.blkbox.pro to unlock the
  command center, and verifies the same UID again in Discord to get the Member role.
  Nothing connects those two acts, so the same person counts as two strangers.
- **No identity spine.** A website visitor, a Discord account and an exchange UID are three
  unrelated identifiers. Without a join key, every funnel question is unanswerable.
- **No arrival attribution in Discord.** 703 members arrived through three invite links, one
  of which has 64 uses. We cannot say which came from YouTube, X, the site or a friend.
- **No outbound click tracking.** We do not know who clicked an exchange link, so a member
  who clicks Bitget and never returns is invisible.

Everything in this document exists to fix those four things.

## 2. The identity spine

One decision makes the rest of the funnel measurable: **Connect Discord on blkbox.pro,
using Discord OAuth.**

A single "Connect Discord" button gives one row holding the account id, the email, the
Discord id, the first-touch attribution and, later, the verified exchange UID. Every funnel
question below is then a query against that row rather than a guess.

```
identities
  account_id        uuid     blkbox.pro account
  discord_id        text     from OAuth, unique
  email             text
  anonymous_id      text     pre-signup cookie, carries first-touch attribution
  exchange          text     bitget | blofin | bybit
  uid               text     verified exchange UID
  first_touch       jsonb    utm_source, utm_medium, utm_campaign, referrer, landing_page
  invite_code       text     Discord invite used, when they arrived that way
  lang              text     en | zh | ko | id
  created_at        timestamptz
```

Alternatives considered. Matching on email fails because Discord accounts often use a
different address. Matching on UID only works after verification, which is the very step we
are trying to measure. A one-time code pasted between surfaces adds a manual step at the
point people already drop off. OAuth is one click and is the only option that identifies
someone *before* they convert.

**Once the spine exists, verification happens once.** Whichever surface a member verifies
on, the other one already knows. Verifying on the website grants the Discord role the moment
they join; verifying in Discord unlocks the command center. That removes a whole duplicated
step from the journey.

## 3. The journey, step by step

Two entry directions. Both converge, and both must be handled.

### Path A: website first, from YouTube, X or search

| # | What the person does | What they see | Event |
|---|---|---|---|
| 1 | Clicks a link with UTM tags | blkbox.pro, hero and platform sections | `touch.landed` |
| 2 | Clicks Get started free | /signup | `signup.viewed` |
| 3 | Enters email | "Check your inbox" | `signup.started` |
| 4 | Clicks the confirmation link | Account created, onboarding step 1 | `signup.confirmed` |
| 5 | Sees exchange choice, filtered by their country | Three options, unavailable ones greyed with the reason | `exchange.list_viewed` |
| 6 | Clicks through to an exchange | Exchange signup in a new tab | `exchange.link_clicked` |
| 7 | Comes back and pastes the UID | Instant check | `exchange.uid_submitted` |
| 8 | Verified | Command center unlocks | `exchange.uid_verified` |
| 9 | Clicks Join the Trading Floor, connects Discord | OAuth consent, then a personal invite | `discord.oauth_connected`, `discord.invite_issued` |
| 10 | Joins the server | Already verified: Member role and language role on arrival | `discord.joined`, `discord.verified` |
| 11 | Posts | Community | `community.first_message` |

The prize at step 10 is that they never see a verification form in Discord. They arrive and
the room is already open.

### Path B: Discord first, from a shared invite

| # | What the person does | What they see | Event |
|---|---|---|---|
| 1 | Clicks a per-source invite | Discord join screen | — |
| 2 | Lands in the server | Only #start-here and #verify are visible | `discord.joined` with `invite_code` |
| 3 | Picks a language | Language role, translated channels appear later | `discord.language_selected` |
| 4 | Reads the start-here page | Two routes: already have an exchange account, or new | — |
| 5a | Has an account, presses Verify my UID | Popup, exchange and UID | `discord.verify_submitted` |
| 5b | New, presses Unlock trading tools | blkbox.pro/signup with their Discord id attached | `discord.outbound_signup_clicked` → Path A step 3, already linked |
| 6 | Verified | Member role, #verify disappears, community appears | `discord.verified` |

Path B step 5b is the join point. The outbound link carries a short-lived signed token that
identifies the Discord account, so the website knows who arrived and the two identities link
without the person typing anything.

### What an unverified arrival can see

Today this is enforced by permissions, already proven on the server: allow view on
@everyone, deny view on the Member role. The verify channel is visible to arrivals and
disappears the moment the role lands, with no per-member overwrites.

## 4. The event contract for Hermes

One envelope from every surface: the website, the app backend and the Discord bot. Same
shape whatever produced it.

```json
{
  "event_id": "uuid",
  "occurred_at": "2026-09-23T09:00:00Z",
  "source": "web | app | discord",
  "name": "discord.verified",
  "anonymous_id": "cookie id, when known",
  "account_id": "uuid, when known",
  "discord_id": "snowflake, when known",
  "lang": "en",
  "attribution": {
    "utm_source": "youtube",
    "utm_medium": "video",
    "utm_campaign": "baloo-weekly",
    "referrer": "https://www.youtube.com/",
    "invite_code": "kSaApM8tMR",
    "landing_page": "/"
  },
  "properties": { "exchange": "bitget", "outcome": "verified" }
}
```

Delivered two ways so Hermes can pull or be pushed to:

- Written to an `events` table in the existing Supabase project, append only.
- POSTed to `HERMES_WEBHOOK_URL` when one is set, with retry and a dead-letter table.

Event names, in funnel order:

```
touch.landed                    signup.viewed              signup.started
signup.confirmed                exchange.list_viewed       exchange.link_clicked
exchange.uid_submitted          exchange.uid_verified      exchange.uid_rejected
discord.oauth_connected         discord.invite_issued      discord.joined
discord.language_selected       discord.verify_opened      discord.verify_submitted
discord.verified                discord.verify_failed      discord.left
community.first_message
```

Rules that keep the data honest: every event carries whatever identifiers are known and
never invents one; `exchange.uid_rejected` and `discord.verify_failed` always carry a reason
from the fixed set in section 6; nothing is deleted, corrections are new events.

## 5. Where people come from

Three surfaces, three mechanisms.

**Website.** UTM tags plus referrer, captured on first touch into the `anonymous_id` cookie
and carried through signup. Standard, nothing new to invent.

**Discord.** The bot has Manage Guild, so it can read invite use counts. It caches the counts
and, when someone joins, finds which one went up. That gives an invite code per member,
which is only useful if the codes mean something, so replace the current three general
invites with a matrix:

```
yt-en, yt-zh, yt-ko, yt-id      from YouTube descriptions
x-en,  x-zh,  x-ko,  x-id       from X
web-en, web-zh, web-ko, web-id  from blkbox.pro
app-*                           issued personally after website verification
```

The language in the invite code is a prediction, not a decision. It tells us which audience
someone answered before they pick a role, which is exactly what we cannot learn any other
way. Keep the existing three codes alive so the 64 people who used one are not orphaned; new
traffic goes to the new codes.

**Exchanges.** Affiliate links do not reliably carry a sub-id, so attribution has to happen
on our side. We record the outbound click ourselves at `exchange.link_clicked`, then match it
to `exchange.uid_verified` later by account. That is what turns "someone signed up on Bitget"
into "this person clicked Bitget on Tuesday and verified on Thursday".

## 6. Where people fall out

Each row is a query on the event stream once the spine exists. The fix column is the point,
since counting a leak without a hypothesis is just a number.

| Leak | Measured by | Likely cause | Fix to try |
|---|---|---|---|
| Landed, never signed up | `touch.landed` without `signup.started` | Unclear offer | Landing copy, clearer free-when-you-trade line |
| Started, never confirmed email | `signup.started` without `signup.confirmed` | Email in spam, wrong address | Resend, check deliverability |
| Confirmed, never clicked an exchange | `signup.confirmed` without `exchange.link_clicked` | Does not understand this step is required | Explain the fee-share model at that step |
| Clicked an exchange, no UID submitted | `exchange.link_clicked` without `exchange.uid_submitted` | Exchange KYC, or country blocked at the exchange | Country filter *before* the click, and the honest US and Canada note |
| UID submitted, not our referral | `exchange.uid_rejected` reason `not_referred` | Pre-existing account, or signed up outside our link | Say it up front, and prompt to open a fresh account |
| Verified on the website, never joined Discord | `exchange.uid_verified` without `discord.joined` | Invite not prominent enough | Put the invite in the success screen and in the welcome email |
| Joined, never picked a language | `discord.joined` without `discord.language_selected` | Missed the start-here page | Discord Onboarding, which this server already supports |
| Picked a language, never verified | `discord.language_selected` without `discord.verified` | No exchange account yet | Nudge after 48 hours in a DM or the verify channel |
| Verified, never posted | `discord.verified` without `community.first_message` | No reason to speak | Welcome thread, a question pinned in general |
| Joined and left | `discord.joined` then `discord.left` | Wrong expectations from the source | Compare by invite code, fix the source that leaks |

Two segments deserve their own view rather than being averaged away. **By language**, because
the Chinese, Korean and Indonesian funnels are new and will behave differently from English.
**By country**, because a Bitget click from Germany and one from Brazil have different
ceilings, and the US and Canada currently have no compliant exchange at all, which will show
up as a large unexplained leak at the exchange step if we do not segment for it.

## 7. Build order

Each step is useful on its own, so the sequence can stop at any point without waste.

1. **Events table and the envelope.** Supabase table, plus the writer in the bot. The bot
   already knows about joins, language choices and verification outcomes, so this alone
   produces a real Discord funnel with no website work.
2. **Invite attribution.** Cache invite uses, diff on join, record the code. Create the new
   invite matrix. Now Discord arrivals have a source.
3. **Discord OAuth on blkbox.pro.** The spine. Everything downstream depends on it.
4. **One verification, not two.** Website verification grants the Discord role; Discord
   verification unlocks the command center. Removes a step from the journey.
5. **Website events.** Landing, signup, exchange clicks, into the same stream.
6. **Hermes delivery.** Webhook with retry and dead-letter, once we know what Hermes ingests.
7. **Fall-out reporting.** A weekly cut by stage, language and source.

## 8. Open question

What does Hermes actually consume? The envelope above is designed to suit either a pull from
the `events` table or a push to a webhook, but the shape of the identifiers, the naming and
the delivery guarantee should match what Hermes already expects rather than forcing it to
adapt. Answering this changes step 6 and nothing earlier, so steps 1 to 5 can proceed now.
