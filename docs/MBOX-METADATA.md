# Formát exportu Doar (mboxrd + metadáta `X-Doar-`)

Verzia formátu: **1**

## 1. Súbor

- Jeden súbor `.mbox` = jedno konto. Variant **mboxrd**.
- Konce riadkov **LF** (unixová konvencia mbox). Pri importe sa konce riadkov vrátia na CRLF.
- Počas zápisu má súbor názov `<názov>.mbox.part`. Po úspešnom dokončení a `fsync` sa premenuje na `<názov>.mbox`.
- Predvolený názov: `Doar-<email>-<RRRR-MM-DD-HHMM>.mbox`.
- Export neobsahuje heslá ani kľúče. Nie je šifrovaný a obsahuje čitateľnú poštu (UI na to upozorní).

## 2. Jedna správa v súbore

```
From MAILER-DAEMON Wed Oct 21 14:36:00 2026          ← oddeľovač (asctime, UTC, interný dátum)
X-Doar-Version: 1; lines=9                            ┐
X-Doar-Source: jan@example.sk                         │
X-Doar-Folder: INBOX/Fakt%C3%BAry                     │ blok metadát Doar
X-Doar-Special-Use:                                   │ (presne `lines` riadkov
X-Doar-Internal-Date: 2026-10-21T14:36:00+02:00       │  vrátane prvého)
X-Doar-Flags: \Seen \Flagged                          │
X-Doar-Hash: sha256=3f7a…                             │
Status: RO                                            │
X-Status: F                                           ┘
Return-Path: <…>                                      ← pôvodná správa bez zmien
Received: …                                             (okrem mboxrd >From a koncov riadkov)
…
                                                      ← prázdny riadok na konci
```

### Hlavičky bloku

| Hlavička | Povinná | Obsah |
|----------|---------|-------|
| `X-Doar-Version` | áno | verzia formátu; parameter `lines=N` = počet riadkov celého bloku vrátane tohto. Vždy **prvý** riadok správy. |
| `X-Doar-Source` | áno | e-mail exportovaného konta (informatívne) |
| `X-Doar-Folder` | áno | cesta priečinka, kódovaná podľa bodu 3 |
| `X-Doar-Special-Use` | áno (môže byť prázdna) | `\Inbox`, `\Sent`, `\Drafts`, `\Trash`, `\Junk`, `\Archive`, `\All`. Pri obnove do iného servera sa správa priradí do priečinka s rovnakou funkciou, aj keď sa volá inak. |
| `X-Doar-Internal-Date` | áno | interný dátum prijatia zo servera (INTERNALDATE), ISO 8601 s posunom |
| `X-Doar-Flags` | áno (môže byť prázdna) | systémové príznaky `\Seen \Flagged \Answered \Draft`. `\Deleted` sa nikdy neexportuje. |
| `X-Doar-Keywords` | nie | používateľské príznaky (napr. `$Forwarded`), každý kódovaný podľa bodu 3, oddelené medzerou |
| `X-Doar-Gmail-Labels` | nie | len Gmail: štítky z `X-GM-LABELS`, kódované podľa bodu 3, oddelené medzerou |
| `X-Doar-Hash` | áno | `sha256=` z pôvodnej správy v kanonickom tvare: všetky konce riadkov CRLF a správa končí CRLF (ak originál nekončil novým riadkom, CRLF sa doplní) |
| `Status` | áno | `RO` = prečítaná, `O` = neprečítaná (pre Thunderbird a iné programy) |
| `X-Status` | nie | písmená `A` (odpovedané), `F` (hviezdička), `T` (koncept). Ak nie je žiadne písmeno, riadok sa nevypíše. |

Poradie hlavičiek v bloku je pevné (ako v tabuľke). Neznáme hlavičky `X-Doar-*` v bloku budúcej verzie import ignoruje, ak sedí `lines`.

## 3. Kódovanie názvov priečinkov a štítkov

- Názov priečinka zo servera sa najprv dekóduje z modified UTF-7 (IMAP) na Unicode.
- Cesta = segmenty hierarchie oddelené znakom `/`, bez ohľadu na oddeľovač servera (`.` alebo `/`).
- Každý segment sa kóduje ako UTF-8 percent-encoding. Kódujú sa všetky bajty mimo `A–Z a–z 0–9 - _ . ~ [ ] $ \`, teda aj `/`, `%` a medzera.
- Príklad: `INBOX` › `Faktúry 2026` → `INBOX/Fakt%C3%BAry%202026`.
- Výsledok je čisté ASCII bez medzier, takže nehrozí zalomenie ani problém s kódovaním hlavičky.
- Maximálna dĺžka riadku je 998 znakov (RFC 5322). Dlhšiu cestu export odmietne pre danú správu a uvedie ju v súhrne ako chybu. V praxi to nenastáva.

## 4. Pravidlá mboxrd

- Export: každý riadok pôvodnej správy, ktorý zodpovedá `^>*From ` (aj na začiatku tela), dostane na začiatok jeden znak `>` navyše.
- Import: z riadku `^>+From ` sa odstráni jeden `>`.
- Riadok `From ` oddeľovača: odosielateľ z `Return-Path`, ak je platný, inak `MAILER-DAEMON`. Čas je interný dátum v UTC vo formáte asctime.
- Za každou správou nasleduje jeden prázdny riadok.

## 5. Konflikty s existujúcimi hlavičkami a odstránenie metadát

- Blok Doar sa vždy **vkladá na začiatok** správy. Pôvodné hlavičky sa nemenia, ani keď už obsahujú `Status`, `X-Status` alebo `X-Doar-*`. Bežné programy berú prvý výskyt, teda náš.
- **Pri obnove** sa blok rozpozná podľa prvého riadku `X-Doar-Version:` a odstráni sa **presne `lines` riadkov** zhora. Každý z nich musí byť známa hlavička bloku (`X-Doar-*`, `Status`, `X-Status`). Hlavičky s rovnakým názvom nižšie v pôvodnej správe ostanú nedotknuté.
- Po odstránení bloku sa vypočíta SHA-256 zvyšku (CRLF) a porovná sa s `X-Doar-Hash`:
  - **zhoda** → obnovený je presný originál,
  - **nezhoda** (súbor upravil iný program) → správa sa importuje s našimi metadátami, ale v súhrne sa uvedie ako „zmenená mimo Doar“.
- Ak prvý riadok nie je `X-Doar-Version`, ide o cudzí mbox: celá správa sa importuje bez zmien do zvoleného priečinka a príznaky sa odvodia zo `Status` a `X-Status`, ak existujú.
- Originály v lokálnom úložisku sa nikdy neupravujú. Blok sa pridáva len do exportovaného prúdu.

## 6. Gmail a štítky

- Exportuje sa `[Gmail]/All Mail` (`\All`), `\Trash` a `\Junk`. Ostatné priečinky (štítky, Doručená pošta, `\Important`, `\Flagged`) sa **neexportujú ako samostatné kópie**.
- `X-Doar-Folder` = cesta priečinka, odkiaľ správa pochádza. `X-Doar-Gmail-Labels` = štítky vrátane `\Inbox`, `\Sent` a `\Important`.
- Obnova do Gmailu: `APPEND` do Všetkej pošty a potom nastavenie štítkov (`X-GM-LABELS`).
- Obnova na iný server: `\Inbox` → Doručená pošta, `\Sent` → Odoslané, inak prvý používateľský štítok (vytvorí sa priečinok), inak Archív.

## 7. Konzistentný výber správ pri exporte

1. **Snímka (čas začiatku):** pre každý priečinok sa zaznamená `UIDVALIDITY` a zoznam UID (`UID SEARCH ALL`). Správy, ktoré prídu neskôr, do zálohy nepatria.
2. Doplnia sa chýbajúce originály. Ak správu medzitým niekto zmazal alebo sa zmenilo `UIDVALIDITY`, správa sa označí ako **nedostupná**.
3. Príznaky a interný dátum sa berú zo snímky (stav na začiatku zálohy).
4. Zápis prúdom: číta sa po jednom súbore `.eml`, nikdy sa nenačíta celá schránka do pamäte.

**Súhrn** (zobrazí sa a uloží do `jobs.summary_json`): začiatok, koniec, počet priečinkov, a pre každý priečinok počty *očakávané / exportované / nedostupné / chybné*, veľkosť súboru.

**Výsledok:**
- **Úplná záloha** – všetky správy zo snímky sú exportované a nenastala žiadna chyba.
- **Neúplná záloha** – súbor sa vytvorí, ale v názve má `-NEUPLNA` a súhrn presne uvedie, čo chýba.
- **Zrušená alebo zlyhaná** – súbor `.part` sa zmaže a nič sa neoznačí ako záloha.

Pred začatím sa skontroluje voľné miesto (odhad = súčet veľkostí × 1,05). Pri `ENOSPC` alebo chybe zápisu sa export zastaví s jasnou správou.

## 7a. Implementácia a overenie (2026-10-21)

- Kód: `src/core/export/mboxrd.ts` (formát, čítanie, odstránenie bloku), `export-account.ts` (postup zálohy), `manager.ts` (úlohy, povolené cesty, obnova po páde).
- Zálohu zapisuje jadro len do súboru, ktorý používateľ vybral v natívnom dialógu (main proces cestu povolí cez `export.allow`).
- Na zálohu sa používa samostatné IMAP spojenie, otvorené len na čítanie (EXAMINE) – synchronizácia ani čítanie pošty nečakajú a stav prečítania sa nemení.
- Overené testami proti Dovecotu: úplná záloha bez lokálnej kópie (všetko sa stiahne), záloha s lokálnou kópiou (nič sa nesťahuje), originály bit po bite (hash), priečinky s diakritikou, vnorené a s `&`, interné dátumy, príznaky, mboxrd (`From`, `>From`), správa bez koncového nového riadku, 8-bitový obsah, správa zmazaná počas zálohy (→ `-NEUPLNA`), zrušenie, plný disk počas zápisu, nedostatok miesta vopred, pád aplikácie počas zálohy, čítanie súboru cudzím nástrojom (Python `mailbox`) vrátane prílohy.
- **Neoverené:** Gmail (štítky, Všetka pošta) – testovací server Gmail nemá; logika výberu priečinkov je pripravená podľa bodu 6.

## 7b. Obnova – implementácia a overenie (2026-10-22)

- Kód: `src/core/import/mbox-reader.ts` (čítanie prúdom, oddeľovače, odstránenie bloku, príznaky cudzích súborov), `import-account.ts` (priečinky, duplicity, nahrávanie), `manager.ts` (úlohy, pokračovanie, obnova po páde).
- Oddeľovač: riadok `From ` na začiatku súboru alebo za prázdnym riadkom, ktorý obsahuje čas a rok (chráni pred rozdelením cudzích súborov, kde `From ` v texte nie je escapované). Súbory s CRLF sa čítajú rovnako.
- Cudzí mbox: `Status: R` → prečítané, `X-Status: A/F/T` → odpovedané / hviezdička / koncept; interný dátum z oddeľovača (rok 1970 = neznámy), inak z hlavičky `Date`.
- Duplicity, pokračovanie a nejasný výsledok: pozri `docs/ROZHODNUTIA.md` (0.3b).
- Overené testami proti Dovecotu: záloha → obnova do prázdneho konta a porovnanie po priečinkoch (obsah bit po bite, interné dátumy, príznaky vrátane `$Forwarded`), príloha, vnorený priečinok s diakritikou a `&`, dve rovnaké kópie v priečinku, tá istá správa v dvoch priečinkoch, opakovaná obnova (nič nové), obnova do pôvodného konta s originálmi bez koncového CRLF a s holými LF/CR (nič nové), doplnenie jednej chýbajúcej kópie, všetko do jedného priečinka, cudzí mbox (príznaky, dátum, správa bez Message-ID), zrušenie a pokračovanie, výpadok spojenia počas `APPEND` (odpoveď stratená po uložení aj pred odoslaním), pád aplikácie počas `APPEND` (jedna správa na serveri je, druhá nie), plná schránka a pokračovanie po uvoľnení miesta, zmenený súbor, súbor, ktorý nie je mbox, súbor nevybraný v dialógu.
- Správa označená na zmazanie (`\Deleted`, ešte nevymazaná) sa zálohuje a obnoví ako bežná správa.
- **Neoverené:** obnova do Gmailu (štítky), servery bez UIDPLUS.

## 8. Hranice verzie 1

- Priečinky bez možnosti výberu (`\Noselect`, napr. nadradený priečinok, ktorý slúži len na zoskupenie) sa neexportujú; ich podpriečinky áno.
- Server nedovoľuje v názve priečinka znaky `%` a `*` (zástupné znaky IMAP), kódovanie ich však zvláda pre iné servery.
- Prázdne priečinky sa cez mbox **neobnovujú**. Mbox obsahuje len správy. Uvádza sa to v UI aj v dokumentácii.
- Vlastné metadáta obnoví len Doar. Iné programy uvidia správy, prílohy a stav prečítania a hviezdičky (`Status`, `X-Status`).
- Správa s riadkami končiacimi samotným CR alebo inými binárnymi odchýlkami sa pri obnove normalizuje na CRLF. Hash sa preto počíta z kanonického tvaru.
