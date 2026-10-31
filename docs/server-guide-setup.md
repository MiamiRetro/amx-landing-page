# Server Guide (book icon) setup

Discord blocks bots from the Server Guide (`PUT /guilds/{id}/new-member-welcome` returns
"Bots cannot use this endpoint", code 20001), so this is set by hand in **Server Settings →
Onboarding**. Copy from here.

There is one guide per server and no per-language version, so it stays short and English: its
only job is to get a newcomer to the language picker. After they pick, everything they see is in
their language.

## Welcome message

> Hi [@username], welcome to the BLKBöX Trading Floor. Pick your language, then verify your
> exchange UID and the whole floor opens up.

## New member to-dos

| Order | Title | Channel |
|---|---|---|
| 1 | Pick your language | `#🌐・choose-language` |
| 2 | Verify your exchange UID | `#✅・verify` (each language has its own; English shown) |

Not `#rules`: it is the official rules channel but hidden from members (see below), and the rules
are on the picker card, which is where newcomers agree to them.

## Resources: one entry per language

| Title | Description | Channel |
|---|---|---|
| Server guide | Rules, setup and how to get verified. | `#🧭・server-guide` |
| 服务器指南 | 规则、设置和验证方式。 | `#🧭・服务器指南` |
| 서버 가이드 | 규칙, 설정, 인증 방법. | `#🧭・서버-가이드` |
| Panduan server | Aturan, pengaturan, dan cara verifikasi. | `#🧭・panduan-server` |
| Hướng dẫn máy chủ | Quy tắc, cài đặt và cách xác minh. | `#🧭・hướng-dẫn-server` |
| Guía del servidor | Reglas, configuración y cómo verificarte. | `#🧭・guía-del-servidor` |
| Guia do servidor | Regras, configuração e como se verificar. | `#🧭・guia-do-servidor` |
| Sunucu rehberi | Kurallar, kurulum ve doğrulama. | `#🧭・sunucu-rehberi` |
| Гид по серверу | Правила, настройка и верификация. | `#🧭・гид-по-серверу` |
| サーバーガイド | ルール、設定、認証方法。 | `#🧭・サーバーガイド` |

Each entry opens only for members of that language; others see it greyed out.

## Rules channel

Discord keeps a hidden `#rules` as the official rules channel: it silently refuses to make the
picker the rules channel, because the picker is hidden from members who have picked a language.
`#rules` carries the same branded rules card (`npm run post:card -- --channel rules --card rules`)
for staff and Discord's own features. Newcomers agree to the rules on the picker card.

## Production

Production does not have the `GUILD_SERVER_GUIDE` feature and onboarding is off. Turn it on there
after the onboarding migration has created the ten language guide channels.
