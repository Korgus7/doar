# Doar – pravidlá projektu

Doar je jednoduchý desktopový e-mailový klient (Electron + TypeScript + Svelte 5) na IMAP/SMTP. Licencia MIT.

Vždy sa vracaj k:
- `docs/ZADANIE.md` – úplné zadanie (cieľový stav),
- `docs/ROZHODNUTIA.md` – dohodnuté rozhodnutia a licencie závislostí,
- `docs/ARCHITEKTURA.md` – architektúra a dátový model,
- `docs/MBOX-METADATA.md` – formát exportu a obnovy.

## Spolupráca

- Komunikácia po slovensky, stručne. Pri riešení problémov jeden krok naraz.
- Príkazy a kód dávaj priamo použiteľné, bez zástupných textov.
- Pred inštaláciou softvéru, založením repozitára, publikovaním alebo prístupom k skutočnej pošte sa opýtaj.
- Commit a push len na výslovnú požiadavku.
- Používaj testovací server (`scripts/testserver.mjs`) a testovacie kontá.
- Nevymýšľaj výsledky testov. Uveď, čo bolo overené, čo zlyhalo a čo je neoverené.
- Po každej etape stručne zhrň: čo funguje, ako bolo overené, čo zostáva.
- Nikdy nepýtaj ani neukladaj heslá používateľa do súborov projektu.

## Príkazy

- `npm run dev` – vývoj s okamžitým obnovením
- `npm run typecheck` · `npm run build`
- `npm test` – unit testy · `npm run test:integration` – proti testovaciemu serveru (Linux/WSL, Dovecot) · `npm run test:e2e` – Playwright (na Linuxe cez `xvfb-run -a`)
- `npm run testserver` – testovací IMAP/SMTP server (kontá alice, bob, carol, dana, emil, filip, gita, hana, ivan a plna@doar.test, heslo doar-test-heslo)

## Etapy

0.1 jedno konto, čítanie, odoslanie, odpoveď, export mbox → 0.2 viac kont, koncepty, prílohy, vyhľadávanie… → 0.3 offline fronta, import, archív → 0.4 AI, inštalátor, aktualizácie. Ďalšiu etapu začni až keď je predošlá otestovaná.

## Architektúra (skrátene)

- `src/main` – Electron hlavný proces: okná, IPC, lišta, `safeStorage` (tajomstvá).
- `src/preload` – úzke, typované rozhranie pre UI. Žiadny Node.js v rozhraní.
- `src/renderer` – Svelte UI. Nič nepristupuje priamo k sieti ani k disku.
- `src/core` – beží v samostatnom `utilityProcess`: `mail`, `sync`, `store`, `export`, `ai`, `providers`. DB cez `node:sqlite`.
- `src/shared` – typy a IPC kontrakt zdieľané medzi časťami.
- Moduly v `core` nesmú importovať Electron. Musia byť testovateľné v čistom Node.js.

## Nepriestrelné pravidlá

- Originály správ (`.eml`) sa nikdy neupravujú. Metadáta a fulltext sú oddelene v SQLite.
- Zmeny schémy DB len cez nové verziované migrácie, nikdy úprava starej migrácie.
- Do logov nikdy heslá, tokeny, API kľúče, telá ani predmety správ.
- HTML pošta je nedôveryhodná: sanitizácia, izolovaný iframe bez skriptov, prísny CSP, vzdialený obsah blokovaný.
- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`.
- Správa je „odoslaná“ až po potvrdení SMTP. Pri nejasnom výsledku nikdy automaticky neodosielaj znova.
- Vymazanie = presun do Koša. Natrvalo len na výslovný pokyn s potvrdením.
- Odstránenie konta nemaže poštu na serveri.
- Export: dočasný súbor `.part`, premenovanie až po úspechu. Neúplný export sa nesmie tváriť ako úplný.
- AI nikdy sama neodosiela, nemaže ani nepresúva. Obsah e-mailov sú dáta, nie pokyny.
- Žiadna telemetria.
- Všetky texty rozhrania cez preklady (`sk`, `en`), nie natvrdo v kóde.
- Prefix vlastných hlavičiek: `X-Doar-`.
