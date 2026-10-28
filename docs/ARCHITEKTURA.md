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
| `export` | export mboxrd (záloha) |
| `import` | čítanie mbox prúdom, obnova do konta (IMAP APPEND, duplicity, pokračovanie); `import/sources` – prevod pošty z Outlooku (.pst/.ost), Outlook Expressu (.dbx) a Windows Mail (.eml) do formátu zálohy Doar |
| `archive` | lokálny archív – súbor mbox len na čítanie (zoznam, fulltext, čítanie zo súboru); v rozhraní záporné ID; aj samostatné súbory `.eml` (len v pamäti) |
| `rules.ts`, `templates.ts`, `unsubscribe.ts` | pravidlá pre novú poštu, šablóny správ, odhlásenie z odberu (0.9) |
| `ai` | voliteľná AI (0.4c): `providers.ts` (Anthropic, OpenAI-kompatibilné – OpenRouter, lokálny server; streamovanie SSE), `prompts.ts` (zadania, obsah pošty ako nedôveryhodné dáta), `service.ts` (nastavenia, kľúč, spúšťanie úloh) |
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
  hidden,               -- 1 = čaká na presun/vymazanie, v pôvodnom priečinku sa nezobrazuje (0.2)
  moving_to,            -- cieľ čakajúceho presunu – správa sa už zobrazuje tam (0.3)
  thread_key, thread_subject, -- konverzácia (0.9): spoločný kľúč vlákna, predmet bez „Re:“
  UNIQUE(folder_id, uid))

messages_fts USING fts5(subject, from_text, to_text, body_text,
                        content='', tokenize='unicode61 remove_diacritics 2')

addresses(email PK, name, use_count, last_used)    -- našepkávanie
contacts(id, name, email UNIQUE NOCASE, phone, company, note, address,  -- adresár (0.7.1)
         sync_account, remote_href, remote_etag, remote_vcard, dirty)   -- synchronizácia CardDAV
contact_sync(account_id, collection_url, sync_token, last_sync, last_error)
contact_tombstones(account_id, href, etag)                     -- zmazané v Doare, čakajú na odoslanie

operations(                                         -- trvalá fronta zmien (0.3, základ už v 0.1)
  id PK, account_id, kind, payload_json,           -- flags | move | expunge | draft | draftDelete | draftRemove
  state,                                            -- pending | running | done | failed
  not_before,                                       -- skôr sa nevykoná (čas na „Vrátiť späť“)
  attempts, last_error, created_at, updated_at)

drafts(                                             -- koncepty (0.2c)
  id PK, account_id, message_id,                    -- Message-ID stabilné naprieč verziami
  data_json, attachments_json,                      -- polia ako ich napísal používateľ; prílohy = SHA v úložisku
  server_folder_id, server_uid,                     -- kde je posledná verzia na serveri
  rev, server_rev,                                  -- rev > server_rev → treba nahrať
  deleted, created_at, updated_at)

outbox(
  id PK, account_id, blob_sha256, message_id,
  state,                -- draft | queued | sending | sent | error | uncertain
  sent_copy_state,      -- not_needed | pending | done | failed
  smtp_response, error, created_at, updated_at,
  send_at)              -- odoslať neskôr (0.9): skôr sa neodošle; NULL = hneď

rules(id PK, name, enabled, account_id NULL, field, value, action, folder_id, position)
                      -- pravidlá pre novú poštu (0.9): field from|to|subject|any, action move|read|flag|archive|trash
templates(id PK, name, subject, html, text, updated_at)       -- šablóny správ (0.9)
signatures(id PK, account_id, name, html, is_default, position) -- podpisy (0.9), HTML aj s logom (data:)
contact_groups(id PK, name UNIQUE NOCASE)                      -- skupiny v adresári (0.9)
contact_group_members(group_id, contact_id)

jobs(id PK, kind, account_id, state, started_at, finished_at,
     progress_json, summary_json)                   -- export, import, úvodná sync

import_items(job_id, seq, mbox_offset, mbox_length, fingerprint, weak_key, size,
             target_desc, target_folder, target_uidvalidity,
             state,                -- pending | appending | appended | duplicate | failed | skipped
             appended_uid, error, changed_outside, foreign_format)
                                                    -- obnova zo zálohy, pokračovanie po prerušení (0.3b)

archives(id PK, path UNIQUE, name, size, mtime_ms, state, message_count, doar, source, error)
archive_folders(id PK, archive_id, key, name, special_use, total, unread)
archive_messages(id PK, archive_id, folder_id, seq, mbox_offset, mbox_length, fingerprint,
                 subject, from_name, from_addr, to_json, date, seen, flagged, answered,
                 has_attachments, snippet)        -- lokálny archív (0.3c), súbor sa nemení
archive_fts (fts5, contentless, rowid = archive_messages.id)

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
- **Presun, Kôš, Archív, Spam** (0.2): správy sa hneď skryjú (`hidden = 1`) a operácia `move` dostane `not_before` = teraz + 8 s. Dovtedy ju „Vrátiť späť“ jednoducho zmaže z fronty a správy odkryje – server sa nič nedozvie. Potom `UID MOVE` (imapflow si poradí aj bez MOVE: COPY + \Deleted + EXPUNGE). Nové UID z UIDPLUS (COPYUID) sa zapíšu k tomu istému lokálnemu záznamu, takže sa originál nesťahuje znova; bez UIDPLUS si správu v cieli nájde ďalšia synchronizácia.
- **Cieľ podľa úlohy priečinka:** Kôš/Archív/Spam sa hľadajú podľa SPECIAL-USE a známych názvov; ak chýbajú, Doar založí `Trash`/`Archive`/`Junk`. Archív na Gmaile = „Všetka pošta“.
- **Natrvalo vymazať** (`expunge`): len na výslovný pokyn s potvrdením, bez oneskorenia: `\Deleted` + `UID EXPUNGE` len pre tieto UID.
- **Bez pripojenia (0.3):** `SyncStatus.pendingChanges` = čakajúce operácie + neodoslané správy. Odoslanie, ktoré zlyhalo pred pripojením (`OFFLINE_CODES`), zostáva `queued` s `error = 'OFFLINE'` a opakuje sa samo. `reconnectAll()` (udalosť `online`, `powerMonitor`) zruší odklad.
- **Konverzácie (0.9):** `MailStore.assignThread` pri vložení hlavičiek (In-Reply-To → kľúč predchodcu; rovnaké Message-ID; náhradne predmet), `linkReferences` po stiahnutí tela (References), `listThreads` (okenné funkcie SQLite: jeden riadok na konverzáciu v priečinku), `threadMessages` pre čítanie.
- **Pravidlá (0.9):** nové UID v doručenej pošte (od `uidnext` z minulej synchronizácie) → `onArrived` → `applyRules` (`core/rules.ts`) → `moveMessages` / `setFlags` ako pri ručnej akcii. Správy, ktoré pravidlo presunulo alebo označilo ako prečítané, nejdú do `onNewMail` (oznámenie).
- **Chyby:** výpadok spojenia operáciu len vráti do fronty (bez započítania pokusu). Po 3 odmietnutiach serverom sa správy znova zobrazia s ⚠. Operácia v stave `running` po páde aplikácie sa pri ďalšom spustení zopakuje.

## 6. Odosielanie

1. Správa sa zloží (nodemailer MailComposer) s vlastným `Message-ID` (`<náhodné@doména-odosielateľa>`) a uloží sa ako originál. Riadok `outbox` dostane stav `queued`.
2. `sending` sa zapíše **pred** pripojením k SMTP.
3. Odpoveď 250 po DATA → `sent`. Chyba pred odoslaním DATA → `error` (bezpečné zopakovať).
4. Spojenie sa preruší po odoslaní DATA, ale bez odpovede → `uncertain`. Hľadá sa v Odoslaných podľa `Message-ID`. Ak sa správa nájde → `sent`. Ak nie, aplikácia sa opýta používateľa. **Nikdy sa neodošle znova automaticky.**
5. Kópia do Odoslaných (`APPEND` s `\Seen`) má vlastný stav `sent_copy_state`. Jej zlyhanie nikdy nespustí nové odoslanie.

6. **Odoslať neskôr (0.9):** riadok s `send_at` v budúcnosti sa preskakuje; `AccountSync.scheduleNextSend()` nastaví časovač na najbližší čas (po spustení a po každom kole fronty). Dátum v hlavičke správy = naplánovaný čas. Zrušenie (`outbox.scheduled` cancel) zloží z originálu nový koncept (`draftFromRaw`).

`save_sent_copy`: Gmail a Microsoft = 0 (server si kópiu ukladá sám), ostatní = 1. Dá sa zmeniť v nastaveniach konta.

## 7. Bezpečnosť

- `BrowserWindow`: `contextIsolation`, `sandbox`, `nodeIntegration: false`, `webSecurity`, CSP pre UI `default-src 'self'`.
- `setWindowOpenHandler` → `deny`, `will-navigate` → zablokované. Odkazy sa otvárajú cez `shell.openExternal` až po kliknutí a len pre `http`, `https` a `mailto`.
- Všetky sieťové požiadavky z rozhrania okrem povolených vzdialených obrázkov blokuje `session.webRequest` v main procese.
- **HTML správa:** core ju sanitizuje (sanitize-html: bez skriptov, formulárov, `on*` atribútov, `<base>`, `<meta refresh>`). Zobrazuje sa v `<iframe sandbox>` bez `allow-scripts`, so `srcdoc` a CSP `default-src 'none'; style-src 'unsafe-inline'; img-src data: cid:` (+ `https:` iba po povolení odosielateľa). Obrázky `cid:` sa nahradia `data:` URI.
- Prílohy sa ukladajú cez dialóg, nikdy sa nespúšťajú automaticky. Jadro pracuje len so súbormi, ktoré povolil main proces po výbere používateľom (`src/core/files.ts`, `FileGrants`). Spustiteľné súbory sa neotvárajú ani na pokyn (`isDangerousFile` v `src/shared/ipc.ts`).
- **AI (0.4c):** volá ju len jadro (Node `fetch`), nikdy rozhranie. Obsah sa odošle len pri `ai.run` (kliknutie používateľa); prílohy nikdy. AI nemá nástroje – vracia len text, ktorý rozhranie ukáže ako návrh. Kľúč je v bezpečnom úložisku (`secrets`, kľúč `ai:<poskytovateľ>:key`), bez neho len v pamäti do zatvorenia. Lokálny server cez `http` len na tento počítač / domácu sieť (`checkBaseUrl`).
- **Prihlásenie cez Microsoft/Google (0.5b):** `src/core/oauth/oauth.ts` (`OAuthService`). Jadro pripraví adresu (PKCE, `state`) a spustí dočasný server na `127.0.0.1`, rozhranie ju otvorí v prehliadači používateľa (`openExternal`). Obnovovací token v `secrets` (`account:<id>:oauth`), prístupový len v pamäti. Kontá s `auth_type = 'oauth2'` dostanú od `SyncManager` namiesto hesla `{ accessToken }` (`Credential` v `src/core/mail/imap.ts`).
- Logy: len technické údaje (ID konta, priečinok, počet, kód chyby). Logger má filter, ktorý odstráni polia `password`, `token`, `apiKey`, `body`, `subject`.

## 8. Rozhranie

- Svelte 5, Vite cez electron-vite. Zoznam správ je virtualizovaný (vykresľujú sa len viditeľné riadky, údaje sa načítavajú po stránkach po 200), takže zvládne aj desaťtisíce správ.
- Preklady: vlastný modul `src/renderer/src/i18n/`, súbory `sk.json` (zdroj kľúčov), `en`, `cs`, `de`, `hu`, `fr`, `es`, `ru`, `he`. Zoznam jazykov a ich názvy v `src/shared/ipc.ts` (`UI_LOCALES`, `LOCALE_NAMES`, `RTL_LOCALES`, `pickUiLocale`) – používa ho rozhranie aj menu v main procese. Predvolený jazyk podľa `app.getLocale()`.
- Sprava doľava (hebrejčina): `<html dir="rtl">` podľa jazyka rozhrania; štýly používajú logické vlastnosti (`margin-inline-start`, `border-inline-start`, `text-align: start`…), takže sa rozloženie zrkadlí samo. Obsah pošty má smer podľa seba: v správe `unicode-bidi: plaintext` pre odseky bez `dir`, v zozname a hlavičke `<bdi>`, v editore `dir="auto"` na odsekoch a nadpisoch (ide aj do odoslaného HTML), polia a čistý text `dir="auto"` / `unicode-bidi: plaintext`.
- Témy: CSS premenné, svetlý a tmavý režim podľa systému alebo ručne.
- Okno na písanie správy je samostatné okno (ako v Outlook Expresse). Správa sa dá otvoriť aj v samostatnom okne na čítanie (0.9): `MessageApp.svelte` (`?view=message&id=`), ten istý `Reader` s `standalone`; main proces drží jedno okno na správu (`createMessageWindow`).
- Náhľad príloh (0.9): `attachments.preview` v jadre (obrázok ako data:, text, PDF ako dočasná kópia) → `AttachmentPreview.svelte`, PDF cez `preview-pdf` v main procese (okno s `plugins: true`, bez preloadu).
- Podpisy (0.9): `core/signatures.ts`, `SignaturesEditor.svelte`; v editore vlastný uzol `image` (len data:), `RichEditor.setSignature/signatureHTML`; pri odoslaní `inlineImages` (data: → Content-ID).
- Súbor `.eml` (0.9): `ArchiveManager.openEml` – originál len v pamäti jadra, ID od `EML_ID_BASE` (`isEmlId`), inak sa správa ako správa z archívu. PDF: `save-pdf` v main procese (rovnaký dokument ako tlač, `printToPDF`).
- Akcie so správami (0.2): výber viacerých (Ctrl/Shift + klik, Shift + šípky, Ctrl+A), kontextová ponuka (aj Shift+F10), ťahanie na priečinok, klávesy Del / Shift+Del / E / Ctrl+Shift+V, oznámenie s „Vrátiť späť“ (aj Ctrl+Z). Stav v `src/renderer/src/lib/actions.svelte.ts`.
- Nastavenia: `SettingsDialog.svelte`; jadro `accounts.ts` (údaje konta), `account-admin.ts` (server, odstránenie, upratanie úložiska), `settings.ts` (tabuľka settings). Oznámenia o novej pošte: jadro (`onNewMail` v synchronizácii) → main (`Notification`).
- Písanie: `ComposeApp.svelte` + `RichEditor.svelte` (TipTap) + `AddressInput.svelte`; prevody text ↔ HTML v `lib/compose-html.ts`, v jadre `mail/outgoing-html.ts` (prečistenie a textová podoba na odoslanie). Tlač: `lib/print.ts` → main (`print-html`, skryté okno bez JS).
- Vyhľadávanie: `src/core/search.ts` (text → dotaz FTS5), `MailStore.searchMessages`; v rozhraní `mail.search` – zoznam správ vtedy ukazuje výsledky.
- Hodnoty zo stavu Svelte (`$state`) sú proxy – pred odoslaním cez MessagePort sa musia skopírovať na obyčajné polia/objekty.
- AI: `lib/ai.svelte.ts` (nastavenia, `runAi` – priebežný text cez udalosť `ai.chunk`), `AiSettings.svelte` (Nastavenia → AI), `AiSummary.svelte` (zhrnutie v čítačke), `AiPanel.svelte` (okno správy; text vyberá a vracia `RichEditor.aiSource/aiApply` alebo textové pole – vlastný text bez podpisu a citácie, alebo označený text).
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
      export/    mboxrd.ts, export-account.ts, manager.ts
      import/    mbox-reader.ts, import-account.ts, manager.ts, sources/ (eml, dbx, pst, prevod)
      archive/   archive.ts
      jobs/      job-runner.ts
      ai/        providers.ts, prompts.ts, service.ts
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
