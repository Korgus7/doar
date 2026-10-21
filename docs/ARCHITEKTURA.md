# Architektúra Doar

Verzia návrhu: 1 (2026-10-21). Mení sa len s odôvodnením v `ROZHODNUTIA.md`.

## 1. Procesy

```
┌──────────────────────┐   MessagePort   ┌────────────────────────────┐
│ Renderer (Svelte UI) │◄──────────────►│ Core (Electron utilityProcess)│
│ sandbox, bez Node.js │                 │ IMAP, SMTP, SQLite, sync,  │
└──────────▲───────────┘                 │ export/import, AI          │
           │ preload: window.doar        └─────────────▲──────────────┘
┌──────────┴───────────┐   IPC (tajomstvá, dialógy)     │
│ Main (Electron)      │◄───────────────────────────────┘
│ okná, lišta, menu,   │
│ safeStorage, updater │
└──────────────────────┘
```

- **Main** robí len to, čo musí robiť Electron: okná, systémová lišta, natívne dialógy, notifikácie, `safeStorage`, aktualizácie. Nerobí sieťovú prácu ani prácu s databázou.
- **Core** beží v samostatnom procese (`utilityProcess`). Synchrónne SQLite, sťahovanie a export tak nikdy nezablokujú okno. Core nesmie importovať `electron`. Je to čistý Node.js, testovateľný mimo Electronu.
- **Renderer** komunikuje s core priamo cez `MessagePort`, ktorý mu pri štarte odovzdá main. Preload sprístupní iba `window.doar.invoke(kanál, dáta)` a `window.doar.on(udalosť, fn)`. Kanály sú vymenované v `src/shared/ipc.ts` a core ich pri prijatí validuje.
- **Tajomstvá:** core si heslo vyžiada od main (`secrets.get`). Main ho dešifruje cez `safeStorage` a pošle späť. Renderer heslá nikdy nedostane späť, iba ich pri zadávaní odošle na uloženie.

## 2. Moduly (`src/core`)

| Modul | Zodpovednosť |
|-------|--------------|
| `store` | SQLite (`node:sqlite`, WAL), migrácie, úložisko originálov `.eml`, FTS5 |
| `mail` | pripojenia IMAP (imapflow) a SMTP (nodemailer), skladanie a parsovanie správ |
| `providers` | tabuľka známych poskytovateľov, autoconfig, rozpoznanie špeciálnych priečinkov |
| `sync` | synchronizácia priečinkov a správ, IDLE, fronta operácií, odosielacia fronta |
| `export` | export a import mboxrd, lokálny archív |
| `ai` | volania AI poskytovateľov (0.4) |
| `jobs` | dlhé úlohy s priebehom a zrušením (sync, export, import) |

Závislosti len smerom dole: `sync` → `mail`, `store`; `export` → `store`, `mail`. `store` nezávisí od nikoho.

## 3. Úložisko

Priečinok používateľských dát (`app.getPath('userData')`, na Windowse `%APPDATA%\Doar`):

```
doar.db                      SQLite: metadáta, fulltext, fronty
secrets.json                 šifrované tajomstvá (safeStorage), nikdy otvorený text
blobs/ab/cd/<sha256>.eml     originálne správy presne ako prišli zo servera
logs/doar.log                diagnostika bez obsahu pošty
```

**Prečo originály v súboroch, nie v SQLite:**
- veľké schránky (desiatky GB) by z databázy urobili jeden obrovský súbor, ktorý sa ťažko zálohuje a opravuje,
- export číta súbory priamo prúdom, bez načítania do pamäte,
- poškodenie jedného súboru nepoškodí ostatné,
- adresovanie podľa SHA-256 automaticky odstraňuje duplicity (Gmail: tá istá správa vo viacerých priečinkoch = jeden súbor) a umožňuje kontrolu integrity.

Zápis originálu: dočasný súbor → `fsync` → premenovanie. Súbory, na ktoré už neodkazuje žiadny riadok, maže občasné čistenie.

**Tajomstvá:** `safeStorage` (Windows DPAPI, macOS Keychain, Linux libsecret). Ak `safeStorage.isEncryptionAvailable()` vráti `false` alebo na Linuxe hlási backend `basic_text`, aplikácia heslo neuloží bez súhlasu: ponúkne zadávanie hesla pri každom spustení.

## 4. Dátový model (SQLite)

Migrácie: `src/core/store/migrations/NNN_nazov.ts` (SQL ako text), tabuľka `schema_migrations(version, applied_at)`. Pred migráciou sa vytvorí záloha DB súboru.

```sql
accounts(
  id INTEGER PK, email, display_name, name,        -- name = popis konta v UI
  imap_host, imap_port, imap_security,              -- 'tls' | 'starttls'
  smtp_host, smtp_port, smtp_security,
  auth_type,                                        -- 'password' | 'oauth2'
  username, provider_key,                           -- provider_key z tabuľky poskytovateľov
  save_sent_copy,                                   -- 1/0; podľa poskytovateľa, meniteľné
  signature, color, sort_order, created_at)

folders(
  id PK, account_id FK, path, delimiter, name, parent_path,
  special_use,          -- inbox|sent|drafts|trash|junk|archive|all|flagged|important|NULL
  special_use_source,   -- server|name|user
  uidvalidity, uidnext, highestmodseq,
  selectable, subscribed,
  total_count, synced_headers_upto, synced_bodies_count,   -- stav úplnosti
  last_sync_at,
  UNIQUE(account_id, path))

messages(
  id PK, account_id FK, folder_id FK, uid,
  blob_sha256,          -- NULL = originál ešte nie je stiahnutý
  size, internal_date, date_header,
  message_id, in_reply_to, references_hdr, thread_key,
  subject, from_addr, from_name, to_json, cc_json, bcc_json,
  snippet, has_attachments,
  seen, flagged, answered, draft, keywords_json,
  gm_msgid, gm_labels_json,                         -- len Gmail
  local_state,          -- synced | pending | failed (čakajúca lokálna zmena)
  UNIQUE(folder_id, uid))

messages_fts USING fts5(subject, from_text, to_text, body_text,
                        content='', tokenize='unicode61 remove_diacritics 2')

addresses(email PK, name, use_count, last_used)    -- našepkávanie

operations(                                         -- trvalá fronta zmien (0.3, základ už v 0.1)
  id PK, account_id, kind, payload_json,           -- flag | move | trash | expunge | append
  state,                                            -- pending | running | done | failed
  attempts, last_error, created_at, updated_at)

outbox(
  id PK, account_id, blob_sha256, message_id,
  state,                -- draft | queued | sending | sent | error | uncertain
  sent_copy_state,      -- not_needed | pending | done | failed
  smtp_response, error, created_at, updated_at)

jobs(id PK, kind, account_id, state, started_at, finished_at,
     progress_json, summary_json)                   -- export, import, úvodná sync

import_items(job_id, seq, mbox_offset, fingerprint, target_folder,
             state, appended_uid, error)            -- pokračovanie po prerušení (0.3)

settings(key PK, value_json)
remote_content_allow(sender PK, created_at)
```

## 5. Synchronizácia

- Na konto sú dve IMAP spojenia: **IDLE** nad doručenou poštou (upozornenia) a **pracovné** spojenie pre sťahovanie a operácie. Ak server IDLE nepodporuje, kontroluje sa každé 2 minúty.
- **Priečinky:** `LIST` so SPECIAL-USE. Ak server špeciálne priečinky neoznačí, použijú sa známe názvy (Sent, Odoslané, Sent Items…). Používateľ môže priradenie zmeniť.
- **Úvodná sync** prebieha postupne: najprv hlavičky (ENVELOPE, FLAGS, INTERNALDATE, SIZE) od najnovších, potom na pozadí úplné originály (`BODY.PEEK[]`). UI ukazuje stav úplnosti po priečinkoch.
- **Priebežná sync:** nové UID nad `uidnext`. Zmeny príznakov cez CONDSTORE/QRESYNC, ak ich server má, inak `UID FETCH 1:* (FLAGS)`. Zmazané správy podľa `UID SEARCH ALL`.
- **UIDVALIDITY sa zmenilo:** záznamy priečinka sa zahodia a načítajú znova. Originály ostávajú a priradia sa znova podľa hashu.
- **Lokálne zmeny** (prečítané, hviezdička, presun, kôš) sa hneď prejavia v UI s `local_state = pending` a zapíšu sa do `operations`. Výsledok: `synced` alebo `failed` (zobrazí sa).

## 6. Odosielanie

1. Správa sa zloží (nodemailer MailComposer) s vlastným `Message-ID` (`<náhodné@doména-odosielateľa>`) a uloží sa ako originál. Riadok `outbox` dostane stav `queued`.
2. `sending` sa zapíše **pred** pripojením k SMTP.
3. Odpoveď 250 po DATA → `sent`. Chyba pred odoslaním DATA → `error` (bezpečné zopakovať).
4. Spojenie sa preruší po odoslaní DATA, ale bez odpovede → `uncertain`. Hľadá sa v Odoslaných podľa `Message-ID`. Ak sa správa nájde → `sent`. Ak nie, aplikácia sa opýta používateľa. **Nikdy sa neodošle znova automaticky.**
5. Kópia do Odoslaných (`APPEND` s `\Seen`) má vlastný stav `sent_copy_state`. Jej zlyhanie nikdy nespustí nové odoslanie.

`save_sent_copy`: Gmail a Microsoft = 0 (server si kópiu ukladá sám), ostatní = 1. Dá sa zmeniť v nastaveniach konta.

## 7. Bezpečnosť

- `BrowserWindow`: `contextIsolation`, `sandbox`, `nodeIntegration: false`, `webSecurity`, CSP pre UI `default-src 'self'`.
- `setWindowOpenHandler` → `deny`, `will-navigate` → zablokované. Odkazy sa otvárajú cez `shell.openExternal` až po kliknutí a len pre `http`, `https` a `mailto`.
- Všetky sieťové požiadavky z rozhrania okrem povolených vzdialených obrázkov blokuje `session.webRequest` v main procese.
- **HTML správa:** core ju sanitizuje (sanitize-html: bez skriptov, formulárov, `on*` atribútov, `<base>`, `<meta refresh>`). Zobrazuje sa v `<iframe sandbox>` bez `allow-scripts`, so `srcdoc` a CSP `default-src 'none'; style-src 'unsafe-inline'; img-src data: cid:` (+ `https:` iba po povolení odosielateľa). Obrázky `cid:` sa nahradia `data:` URI.
- Prílohy sa ukladajú cez dialóg, nikdy sa nespúšťajú automaticky.
- Logy: len technické údaje (ID konta, priečinok, počet, kód chyby). Logger má filter, ktorý odstráni polia `password`, `token`, `apiKey`, `body`, `subject`.

## 8. Rozhranie

- Svelte 5, Vite cez electron-vite. Zoznam správ je virtualizovaný (vykresľujú sa len viditeľné riadky, údaje sa načítavajú po stránkach po 200), takže zvládne aj desaťtisíce správ.
- Preklady: vlastný modul `src/renderer/src/i18n/`, súbory `sk.json` a `en.json`. Predvolený jazyk podľa `app.getLocale()`.
- Témy: CSS premenné, svetlý a tmavý režim podľa systému alebo ručne.
- Okno na písanie správy je samostatné okno (ako v Outlook Expresse).
- Návrh obrazoviek: `docs/OBRAZOVKY.md`.

## 9. Štruktúra repozitára

```
doar/
  CLAUDE.md  LICENSE  README.md  package.json  electron.vite.config.ts
  docs/
  src/
    main/        index.ts, secrets.ts, menu.ts, window-state.ts (neskôr tray.ts)
    preload/     index.ts
    shared/      ipc.ts (kontrakt kanálov), types.ts
    core/        index.ts (vstup utilityProcess), handlers.ts, log.ts, accounts.ts, secrets.ts, compose-service.ts
      store/     db.ts, migrations/, blobs.ts, mailstore.ts
      mail/      connection-test.ts, imap.ts, smtp.ts, compose.ts, parse.ts, sanitize.ts, remote.ts
      providers/ known.ts, autoconfig.ts, discover.ts, net.ts (neskôr special-folders.ts)
      sync/      account-sync.ts (vrátane odosielacej fronty), manager.ts
      export/    mboxrd.ts, export-account.ts, manager.ts (neskôr import-account.ts, archive.ts)
      jobs/      job-runner.ts
      ai/        (0.4)
    renderer/    index.html, src/ (App.svelte, ComposeApp.svelte, components/, lib/, i18n/, styles/)
  test/
    unit/        mboxrd, metadáta, parsovanie, migrácie
    integration/ proti testovaciemu serveru (sync, odosielanie, export → import)
    e2e/         Playwright + Electron
    fixtures/    vzorové správy (.eml), poškodené mbox
  scripts/       testserver.mjs (testovací IMAP/SMTP server)
```

## 10. Testovanie

- **Unit (vitest):** mboxrd, `>From` escaping, metadáta, kódovanie priečinkov, migrácie, stavový automat odosielania.
- **Integrácia:** `scripts/testserver.mjs` – Dovecot (IMAP 3143 STARTTLS / 3993 TLS) + testovací SMTP (3587 / 3465) s vlastným certifikátom. Overuje sync, zmeny z iného klienta, odosielanie, Odoslané, export → import do prázdneho konta a porovnanie.
- **E2E:** Playwright `_electron.launch`, na Linuxe pod xvfb.
- Simulácia porúch: prerušené spojenie po DATA, plný disk (malý tmpfs), zaplnená schránka (kvóta v Dovecote), poškodený mbox.
