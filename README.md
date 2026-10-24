# Doar Mail

Jednoduchý, rýchly a bezplatný e-mailový klient pre desktop – v duchu Outlook Expressu a starej aplikácie Pošta pre Windows.

*A simple, fast and free desktop email client (IMAP/SMTP) with reliable mbox backup and restore.*

- IMAP a SMTP, viac kont, spoločná doručená pošta
- záloha konta do jedného súboru `.mbox` a obnova
- voliteľné AI funkcie s vlastným kľúčom (Anthropic, OpenRouter) alebo lokálnym modelom: zhrnutie, návrh odpovede, úprava textu
- slovenčina a angličtina
- bez telemetrie

**Stav:** vo vývoji – verzia 0.4: balík pre Windows (zip, bez inštalátora), automatické aktualizácie z GitHubu a voliteľná AI (Anthropic, OpenRouter, lokálny model). Z 0.3: viac kont a spoločná doručená pošta, čítanie a písanie (aj formátované), odpoveď a preposlanie, prílohy, koncepty, Kôš, Archív a presuny, vyhľadávanie, podpis, upozornenia na novú poštu, tlač, práca bez pripojenia, záloha do mbox, obnova zo zálohy do konta (bez duplicít, s pokračovaním po prerušení) a lokálny archív mbox len na čítanie.

Zadanie: [docs/ZADANIE.md](docs/ZADANIE.md) · Architektúra: [docs/ARCHITEKTURA.md](docs/ARCHITEKTURA.md)

## Vývoj

Potrebné: Node.js 24.

```
npm install
npm run dev
```

Balík pre Windows: `npm run dist` → `dist\Doar-Mail-<verzia>-win-x64.zip` (rozbaliť a spustiť `Doar Mail.exe`; odkazy v ponuke Štart a na ploche si vytvorí sám).

Vydanie novej verzie: zvýšiť `version` v `package.json` → `npm run dist` → na GitHube *Releases → Draft a new release* (značka `v<verzia>`) a priložiť `dist\Doar-Mail-<verzia>-win-x64.zip` aj `dist\doar-mail-update.json`. Nainštalované Doar Mail novú verziu ponúknu samy (repozitár musí byť verejný). Stránka na stiahnutie: `site/` (stačí nahrať na web, najnovšie vydanie si nájde sama).

Testy: `npm test` (unit), `npm run test:e2e` (rozhranie). Integračné testy proti testovaciemu IMAP/SMTP serveru vyžadujú Linux alebo WSL s balíkmi `dovecot-imapd dovecot-lmtpd`: `npm run test:integration`.

Licencia: [MIT](LICENSE)
