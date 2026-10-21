# Rozhodnutia projektu

Záznam dohodnutých rozhodnutí. Nové rozhodnutia pridávaj na koniec s dátumom.

## 2026-10-21 – otvorené rozhodnutia zo zadania (bod 17)

| # | Otázka | Rozhodnutie |
|---|--------|-------------|
| 1 | Názov projektu a repozitára | **Doar**, repozitár `doar` |
| 2 | Súkromný alebo verejný repozitár | **Verejný.** Založí sa až po výslovnom potvrdení. |
| 3 | Licencia | **MIT** |
| 4 | Prví poskytovatelia | **Vlastný server / hosting** (IMAP + SMTP, heslo, ručné aj automatické nastavenie). Gmail, Microsoft a slovenskí poskytovatelia neskôr. |
| 5 | Rozhranie | **Svelte 5** – menej kódu, rýchle, ľahko čitateľné. |
| 6 | Editor správ | **0.1 čistý text**, od **0.2 jednoduché formátovanie** (tučné, kurzíva, odkazy, zoznamy – TipTap). |

## 2026-10-21 – ďalšie rozhodnutia

- **Jazyk rozhrania:** slovenčina a angličtina už od 0.1. Texty sú v jazykových súboroch, predvolený jazyk podľa systému, prepínanie v nastaveniach.
- **Prefix exportných hlavičiek:** `X-Doar-` (zadanie pôvodne uvádzalo `X-Mailklient-`).
- **Distribúcia (bez zisku):** Windows cez Microsoft Store (bezplatná registrácia, Microsoft aplikáciu podpíše) a voliteľne inštalátor z GitHubu s podpisom cez SignPath Foundation (zadarmo pre open source, ak projekt prijmú). macOS – rozhodne sa pred vydaním (Apple Developer 99 USD/rok alebo nepodpísaná verzia s návodom).
- **Prostredie:** vývoj a testy prebiehajú v cloudovom prostredí Claude (Linux). Súbory sa zapisujú do `D:\_Doar`. Windows zostavenie overuje používateľ alebo GitHub Actions. Neskôr možný prechod do Claude Code na PC používateľa.
- **Overené na Windowse (2026-10-21):** kostra sa spustí (`npm run dev`), jadro aj SQLite bežia, prepínanie jazyka funguje, unit testy 12/12. Pri `npm install` sa Electron nestiahol celý – pomohlo `node node_modules\electron\install.js`.

## 2026-10-21 – zmeny pri zakladaní kostry

- **SQLite: `node:sqlite` namiesto `better-sqlite3`.** Electron 45 (Node.js 24) má SQLite 3.53 zabudovanú vrátane FTS5. Overené: fulltext nájde „faktura“ v texte „Faktúra“. Odpadá natívny modul, ktorý by sa musel zostavovať pre každú verziu Electronu a platformu. Prístup k DB je len v `src/core/store`, takže prechod späť na better-sqlite3 je v prípade potreby jednoduchý.
- **Testovací server: Dovecot + vlastný SMTP namiesto GreenMail.** Maven Central (GreenMail) nie je z vývojového prostredia dostupný. Dovecot je skutočný IMAP server (ako u bežných hostingov) s IDLE, CONDSTORE, QRESYNC, UIDPLUS, MOVE, SPECIAL-USE a kvótami. Testovací SMTP (`smtp-server`) doručuje do Dovecotu cez LMTP a vie simulovať poruchy (odmietnutie, prerušenie po DATA). Spúšťa sa na Linuxe, vo WSL alebo v GitHub Actions.
- **Preklady: vlastný malý modul** namiesto svelte-i18n (menej závislostí; kontrola zhody kľúčov sk/en je v unit teste).
- **Node.js pre vývoj: 24** (rovnaká hlavná verzia ako v Electrone 45).

## 2026-10-21 – pridanie konta (0.1)

- **Zistenie nastavení servera** v poradí: známi poskytovatelia (Gmail, Microsoft) → autoconfig na doméne (len HTTPS) a DNS SRV → Mozilla ISPDB → MX záznamy → odhad (imap./mail./smtp.) overený sondou na porte. Najprv zdroje samotnej domény, až potom externé. Heslo sa pri zisťovaní nikam neposiela. Výsledok je vždy len návrh, ktorý používateľ vidí a môže upraviť.
- **Certifikát pre iné meno servera** (typické pri hostingu): spojenie sa odmietne, ale Doar ponúkne meno servera z certifikátu jedným kliknutím. Neplatný certifikát sa nikdy neprijme.
- **Gmail:** sprievodca upozorní na heslo aplikácie. **Outlook.com / Microsoft 365:** sprievodca vopred povie, že prihlásenie cez Microsoft (OAuth) zatiaľ nie je podporované.
- **Heslo:** šifrované úložisko systému (Windows DPAPI). Keď nie je dostupné (napr. Linux bez kľúčenky), Doar sa opýta a ponúkne heslo len do zatvorenia aplikácie (`accounts.password_storage = 'session'`). Nikdy nie nešifrovane bez upozornenia.
- **Menu aplikácie** je v jazyku rozhrania a mení sa spolu s ním. Vývojárske nástroje sú v menu len pri vývoji.
- **Testy s certifikátom testovacieho servera:** dôvera sa pridáva cez `NODE_EXTRA_CA_CERTS` (ako by to urobil správca systému). V kóde aplikácie nie je žiadna výnimka pre testy.

## 2026-10-21 – synchronizácia a hlavné okno (0.1)

- **Synchronizácia:** jedno pracovné IMAP spojenie na konto vykonáva úlohy postupne (prioritná fronta: otvorenie správy > lokálne zmeny > doručená pošta > celková synchronizácia > sťahovanie obsahu na pozadí). Druhé spojenie sleduje doručenú poštu cez IDLE. Celková synchronizácia každých 5 minút a na F5.
- **Nové správy:** hlavičky od najnovších, originály na pozadí po 20. Pred zisťovaním UID sa posiela NOOP (server inak ohlási novú správu v už otvorenom priečinku až po ďalšom príkaze – zistené testom, opravené).
- **IDLE** sa po každej udalosti obnovuje (knižnica ho po udalosti ukončí a sama neobnoví – zistené testom).
- **Príznaky:** s CONDSTORE len zmeny od minulej synchronizácie, inak všetky. Lokálna zmena (prečítané, hviezdička) sa prejaví hneď, na server ide cez tabuľku `operations`; kým nie je potvrdená, zmena zo servera ju neprepíše.
- **Zmazané inde:** správy, ktoré na serveri už nie sú, sa odstránia lokálne (pri ďalšej synchronizácii). Priečinok zmazaný na serveri zmizne lokálne.
- **Zobrazenie správy:** jadro sanitizuje HTML; rozhranie ho zobrazí v iframe so `sandbox` bez skriptov a s CSP `img-src data:`. Vzdialené obrázky sťahuje na požiadanie jadro (bez cookies a referera) a vkladá ich ako data: URI – rozhranie nikdy nejde na internet. Možnosť „Vždy od odosielateľa“ (`remote_content_allow`).
- **Otvorená správa = prečítaná** (ako pri paneli na čítanie v Outlook Expresse).
- **Odkazy v správe** sa otvárajú v systémovom prehliadači len po kliknutí a len pre http, https a mailto.
- **Náhľad a fulltext** z HTML správ sa tvoria vlastným prevodom HTML → text (bez adries obrázkov).
- **Okno a panely:** veľkosť, poloha a maximalizácia okna sa pamätajú (`window-state.json`), šírky panelov v rozhraní.

## 2026-10-21 – písanie a odosielanie (0.1)

- **Okno správy** je samostatné okno (ako v Outlook Expresse). Rozpísaná správa sa pri zatvorení nestratí bez otázky. Koncepty na serveri pribudnú vo verzii 0.2.
- **Čistý text** vo verzii 0.1, formátovanie od 0.2 (dohodnuté).
- **Odosielanie po fázach** (`src/core/mail/smtp.ts`): knižnica pri prerušení spojenia po odoslaní obsahu hlási rovnakú chybu ako pri nedostupnom serveri (overené pokusom). Doar preto sleduje fázy sám: chyba pri pripájaní alebo prihlásení alebo odpoveď 4xx/5xx = neodoslané; prerušenie počas odosielania bez odpovede = **nejasný výsledok** – nikdy sa neopakuje automaticky.
- **Nejasný výsledok:** Doar hľadá správu v Odoslaných podľa `Message-ID` (poskytovateľ ju mohol uložiť sám). Ak ju nenájde, rozhodne používateľ; zvýraznená predvolená voľba je „Neodosielať“.
- **Pád aplikácie počas odosielania:** stav „odosiela sa“ sa zapisuje pred pripojením; po spustení sa zmení na nejasný výsledok.
- **Kópia do Odoslaných** je samostatný krok (`sent_copy_state`) s kontrolou duplicity podľa `Message-ID`; jej zlyhanie nikdy nespôsobí nové odoslanie. Ak server priečinok Odoslané nemá (alebo ho neoznačí), Doar založí/použije `Sent`.
- **Skrytá kópia (Bcc):** v odoslanej správe nie je, adresáti sú len v obálke SMTP; v kópii v Odoslaných je (odosielateľ vidí, komu poslal).
- **Odpoveď:** konto, na ktoré správa prišla; adresát z Reply-To alebo From; „Odpovedať všetkým“ bez vlastných adries; „Re:“ len raz; In-Reply-To a References; pôvodná správa dostane príznak Odpovedané.

## 2026-10-21 – záloha konta do mbox (0.1)

- **Postup:** snímka priečinkov a UID (len na čítanie) → kontrola lokálnej kópie → stiahnutie chýbajúcich originálov (uložia sa aj do lokálnej kópie) → zápis do `.part` → `fsync` → premenovanie. Podrobne `docs/MBOX-METADATA.md`.
- **Samostatné IMAP spojenie** pre zálohu, aby hlavné okno, synchronizácia aj odosielanie fungovali počas zálohy.
- **Neúplná záloha** (správa zmazaná na serveri počas zálohy, chyba pri sťahovaní) dostane v názve `-NEUPLNA` a súhrn ukáže presné počty po priečinkoch. Pod pôvodným názvom vtedy nič nevznikne.
- **Zrušenie, zlyhanie, plný disk, pád aplikácie:** rozpracovaný súbor sa zmaže, nič sa netvári ako záloha.
- **Bezpečnosť:** jadro zapisuje len do súboru vybraného v natívnom dialógu „Uložiť ako“; rozhranie nemôže zadať ľubovoľnú cestu. „Otvoriť priečinok“ funguje len pre takto vybrané súbory.
- **Záloha beží na pozadí:** dialóg sa dá skryť, priebeh je v stavovom riadku (kliknutím sa dialóg znova otvorí), výsledok sa po dokončení ukáže vždy.
- **Gmail:** pripravené podľa zadania (len Všetka pošta, Kôš, Spam + štítky), zatiaľ neoverené.

## Licencie závislostí (overené 2026-10-21 cez `npm view`)

Všetky sú kompatibilné s MIT.

| Balík | Verzia | Licencia | Použitie |
|-------|--------|----------|----------|
| electron | 45.0.0 | MIT | aplikácia |
| imapflow | 2.5.9 | MIT | IMAP |
| nodemailer | 10.1.7 | MIT-0 | SMTP, skladanie správ |
| mailparser | 3.10.0 | MIT | spracovanie správ |
| node:sqlite (súčasť Electronu/Node.js) | SQLite 3.53 | MIT (Node.js) | SQLite + FTS5 |
| svelte | 5.57.2 | MIT | rozhranie |
| @tanstack/svelte-virtual | 3.13.47 | MIT | virtualizovaný zoznam správ |
| @tiptap/core | 3.32.0 | MIT | editor (0.2) |
| sanitize-html | 2.18.1 | MIT | sanitizácia HTML pošty |
| dompurify | 3.4.17 | MPL-2.0 OR Apache-2.0 | záložná sanitizácia (použijeme pod Apache-2.0) |
| iconv-lite, libmime | – | MIT | kódovania |
| vite, electron-vite, @sveltejs/vite-plugin-svelte | – | MIT | zostavenie |
| electron-builder, electron-updater | – | MIT | inštalátor, aktualizácie |
| vitest | 5.0.5 | MIT | unit testy (len vývoj) |
| @playwright/test | 1.64.1 | Apache-2.0 | testy UI (len vývoj) |
| smtp-server | 3.20.2 | MIT-0 | testovací SMTP server (len vývoj) |
| Dovecot (systémový balík) | 2.3 | MIT + LGPL-2.1 | testovací IMAP server (len vývoj, nedistribuuje sa) |

Pred pridaním ďalšej knižnice over licenciu a doplň ju sem.
