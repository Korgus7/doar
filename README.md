# Doar

Jednoduchý, rýchly a bezplatný e-mailový klient pre desktop – v duchu Outlook Expressu a starej aplikácie Pošta pre Windows.

*A simple, fast and free desktop email client (IMAP/SMTP) with reliable mbox backup and restore.*

- IMAP a SMTP, viac kont, spoločná doručená pošta
- záloha konta do jedného súboru `.mbox` a obnova
- voliteľné AI funkcie s vlastným kľúčom
- slovenčina a angličtina
- bez telemetrie

**Stav:** vo vývoji – verzia 0.1 (jedno konto, čítanie, odosielanie, odpoveď, záloha do mbox).

Zadanie: [docs/ZADANIE.md](docs/ZADANIE.md) · Architektúra: [docs/ARCHITEKTURA.md](docs/ARCHITEKTURA.md)

## Vývoj

Potrebné: Node.js 24.

```
npm install
npm run dev
```

Testy: `npm test` (unit), `npm run test:e2e` (rozhranie). Integračné testy proti testovaciemu IMAP/SMTP serveru vyžadujú Linux alebo WSL s balíkmi `dovecot-imapd dovecot-lmtpd`: `npm run test:integration`.

Licencia: [MIT](LICENSE)
