# Server Guide setup

Discord blocks bots from the Server Guide endpoint: `PUT /guilds/{id}/new-member-welcome`
returns `Bots cannot use this endpoint` (code 20001). Every change below is made by hand in
**Server Settings → Onboarding**. This file is the thing to copy from.

## Why the guide itself stays in English

The Server Guide is the one surface a member sees **before** they have picked a language.
There is exactly one per server: a single welcome message, a single to-do list and a single
resource list, with no locale fields anywhere in the API. It cannot be translated per viewer.

That is fine, because its only job is to get someone to their own language. After they pick,
the language categories take over and everything else they read is already translated. So the
guide is deliberately short, and its resource list is the one place we put all ten languages
side by side, each written in its own script, so a member finds theirs by recognising it
rather than by reading English.

## Welcome message

> Hi [@username], welcome to the BLKBöX Trading Floor. Pick your language below, then verify
> your exchange UID and the whole server opens up.

## New member to-dos

Three, in this order. Each one is the next thing that actually unblocks them.

| Order | Title | Channel |
|---|---|---|
| 1 | Pick your language | `#🌐・choose-language` |
| 2 | Read the rules | `#rules` |
| 3 | Verify your exchange UID | `#✅・verify` |

The three existing to-dos ("Create a bitget account", "Sign up with one of our partners",
"introduce yourself") predate the current structure and should be replaced.

## Resources: one entry per language

This is the part that answers "can the guide be per language". It cannot, but ten entries in
one guide gets the same result in one click.

| Emoji | Title | Description | Channel |
|---|---|---|---|
| 🧭 | Server guide | Rules, setup and how to get verified. | `#🧭・server-guide` |
| 🧭 | 服务器指南 | 规则、设置和验证方式。 | `#🧭・服务器指南` |
| 🧭 | 서버 가이드 | 규칙, 설정, 인증 방법. | `#🧭・서버-가이드` |
| 🧭 | Panduan server | Aturan, pengaturan, dan cara verifikasi. | `#🧭・panduan-server` |
| 🧭 | Hướng dẫn máy chủ | Quy tắc, cài đặt và cách xác minh. | `#🧭・hướng-dẫn-server` |
| 🧭 | Guía del servidor | Reglas, configuración y cómo verificarte. | `#🧭・guía-del-servidor` |
| 🧭 | Guia do servidor | Regras, configuração e como se verificar. | `#🧭・guia-do-servidor` |
| 🧭 | Sunucu rehberi | Kurallar, kurulum ve doğrulama. | `#🧭・sunucu-rehberi` |
| 🧭 | Гид по серверу | Правила, настройка и верификация. | `#🧭・гид-по-серверу` |
| 🧭 | サーバーガイド | ルール、設定、認証方法。 | `#🧭・サーバーガイド` |

Put English first because the guide is read before a language is chosen, then the rest in any
order. A resource entry only points at a channel, so each one lands the member on the
four-card guide already written in that language.

## What a new member sees

1. Joins, and Discord shows the Server Guide under the book icon.
2. Reads one line of welcome and three to-dos.
3. Either follows to-do 1 to `#🌐・choose-language` and picks from ten buttons, or recognises
   their own language in the resource list and jumps straight there.
4. The language role opens that language's categories.
5. To-do 3 takes them to verify, where the UID check grants the membership role.
6. The verify channel disappears, because it allows view on @everyone and denies it on the
   membership role.

## Rolling this to production

The production server does **not** carry the `GUILD_SERVER_GUIDE` feature and its
`new-member-welcome` is disabled with no to-dos and no resources. Onboarding has to be turned
on there before any of this can be copied across, and the ten language guide channels have to
exist first.
