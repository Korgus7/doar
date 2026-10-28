# Doar Mail

Jednoduchý, rýchly a bezplatný e-mailový klient pre desktop – v duchu Outlook Expressu a starej aplikácie Pošta pre Windows.

*A simple, fast and free desktop email client (IMAP/SMTP) with reliable mbox backup and restore.*

- IMAP a SMTP, viac kont, spoločná doručená pošta
- záloha konta do jedného súboru `.mbox` a obnova
- import pošty z Outlooku (.pst, .ost), Outlook Expressu (.dbx) a Windows Mail / Windows Live Mail (.eml)
- adresár: kontakty s telefónom a poštovou adresou, skupiny (napr. Rodina – správa všetkým jedným klikom), synchronizácia s Google kontaktmi (mobil s Androidom) oboma smermi, import a export vCard a CSV (Outlook, Gmail, Excel), adresy z odoslanej pošty
- priečinky: vytvorenie, premenovanie, presun ťahaním, odstránenie (správy do Koša), zbaľovanie podpriečinkov, označiť všetko ako prečítané
- konverzácie (vlákna ako v Gmaile, zapínajú sa v ponuke ☰), rozšírené hľadanie (od koho, dátum, s prílohou, neprečítané), náhľad obrázkov, PDF a textu v prílohách
- pravidlá pre novú poštu (presun, prečítané, hviezdička, archív, kôš), šablóny správ, odoslať neskôr, viac podpisov s formátovaním a logom
- odhlásenie z odberu jedným klikom, správa v samostatnom okne, uloženie ako PDF alebo .eml, otvorenie súboru .eml
- voliteľné AI funkcie s vlastným kľúčom (Anthropic, OpenRouter) alebo lokálnym modelom: zhrnutie, návrh odpovede, úprava textu
- slovenčina, angličtina, čeština, nemčina, maďarčina, francúzština, španielčina, ruština a hebrejčina (sprava doľava)
- Gmail, Outlook.com a Microsoft 365 aj prihlásením cez Google / Microsoft (bez hesla v programe; pri niektorých nových kontách Outlook.com Microsoft zatiaľ nepustí IMAP ani SMTP)
- bez telemetrie

**Stav:** vo vývoji – verzia 0.9: konverzácie, rozšírené hľadanie, náhľad príloh, podpisy s logom, skupiny v adresári, pravidlá, šablóny, odoslať neskôr, odhlásenie z odberu, správa v samostatnom okne, PDF a .eml. Z 0.8: synchronizácia adresára s Google kontaktmi, kontakty aj bez e-mailu, prihlásenie cez Microsoft. Z 0.7.1: adresár, správa priečinkov (premenovanie, presun, odstránenie, zbaľovanie), výraznejšie farby kont, zadanie hesla priamo pri importe. Z 0.7: import z Outlooku, Outlook Expressu a Windows Mail. Z 0.6: nový vzhľad, svetlý a tmavý režim. Z 0.5: prihlásenie cez Google (Gmail bez hesla v programe; Microsoft pripravený, čaká na registráciu), jazyky rozhrania vrátane hebrejčiny sprava doľava. Z 0.4: balík pre Windows (zip, bez inštalátora), automatické aktualizácie z GitHubu a voliteľná AI (Anthropic, OpenRouter, lokálny model). Z 0.3: viac kont a spoločná doručená pošta, čítanie a písanie (aj formátované), odpoveď a preposlanie, prílohy, koncepty, Kôš, Archív a presuny, vyhľadávanie, podpis, upozornenia na novú poštu, tlač, práca bez pripojenia, záloha do mbox, obnova zo zálohy do konta (bez duplicít, s pokračovaním po prerušení) a lokálny archív mbox len na čítanie.

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
