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

## 2026-10-22 – presuny, Kôš, Archív, nový priečinok (0.2a)

- **„Vrátiť späť“ bez zásahu na server:** presun sa odošle až po 8 s (oznámenie je vidieť 7 s, aby tlačidlo nikdy nesľubovalo nemožné). Ak už bol vykonaný, Doar to povie („Už sa nedá vrátiť“) a nič nepredstiera.
- **Del** = do Koša. V Koši **Del** = natrvalo. **Shift+Del** = natrvalo kdekoľvek. Natrvalo vždy s potvrdením a bez možnosti vrátenia.
- **E** = Archivovať (ako Gmail/Outlook). **Ctrl+Shift+V** = Presunúť do priečinka (ako Outlook).
- **Chýbajúci Kôš/Archív/Spam** Doar na serveri založí pod bežným anglickým názvom (`Trash`, `Archive`, `Junk`), ktorý poznajú aj iné programy; v rozhraní sa zobrazí po slovensky.
- **Presun medzi kontami** zatiaľ nie (rozhranie ho neponúkne, jadro ho odmietne). Pri spoločnej doručenej pošte fungujú Kôš/Archív/Spam pre každé konto zvlášť.
- **Nový priečinok:** „+“ pri konte, „Nový podpriečinok…“ v ponuke priečinka a priamo v dialógu presunu. Diakritika je v poriadku (IMAP UTF-7 rieši imapflow). Odmietne sa prázdny názov, oddeľovač servera, `%`, `*` a duplicita.
- **Oprava:** hlavné okno sa nenaťahovalo na celú výšku, keď nebol zobrazený pruh odosielania (chyba z 0.1).

## 2026-10-22 – prílohy a preposlanie (0.2b)

- **Cesty k súborom určuje len používateľ:** natívny dialóg (Priložiť, Uložiť ako, Uložiť všetky) alebo súbor pretiahnutý myšou. Main proces cestu oznámi jadru (`files.allow`); jadro odmietne každú inú cestu (`PATH_NOT_ALLOWED`). Cestu k pretiahnutému súboru zisťuje preload (`webUtils.getPathForFile`) – rozhranie ju nevie podvrhnúť.
- **Otvorenie prílohy:** dočasná kópia v `<dáta>/otvorene-prilohy/` (staršie než deň sa pri štarte mažú) a otvorenie v predvolenom programe. **Spustiteľné súbory** (exe, bat, ps1, js, vbs, msi, lnk, iso, makrá Office…) a súbory bez prípony sa neotvárajú nikdy – dajú sa len uložiť. Kontrolu robí jadro aj main proces.
- **Windows:** uložené a otvárané prílohy dostanú značku „stiahnuté z internetu“ (Mark of the Web, `Zone.Identifier`), takže systém (SmartScreen, chránené zobrazenie Office) pred nimi varuje ako pri prílohách z prehliadača.
- **Uložiť všetky** nikdy neprepíše existujúci súbor („faktura (2).pdf“). Názvy sa čistia (zakázané znaky, rezervované mená Windows, znaky obracajúce smer textu).
- **Veľkosť:** nad 20 MB upozornenie, nad 50 MB spolu sa správa neodošle (väčšinu takých správ by server aj tak odmietol).
- **Preposlanie (Ctrl+F):** ako vložený text s hlavičkou „Preposlaná správa“ + prílohy pôvodnej správy (dajú sa jednotlivo odstrániť). Nie ako príloha .eml – bežní adresáti to čítajú pohodlnejšie. Vložené obrázky z HTML sa nepreposielajú (0.2 posiela čistý text).
- **Citácia správy len v HTML:** text sa odvodí z HTML (predtým bola citácia prázdna).
- **Pretiahnutie súborov do okna správy** automatický test nepokrýva (Playwright nevie simulovať skutočný súbor z disku); overené ručne na Windows 2026-10-22.

## 2026-10-22 – koncepty (0.2c)

- **Nič sa nestratí:** okno správy ukladá koncept 1,5 s po poslednej zmene do lokálnej databázy (aj s prílohami – kópia sa uloží do úložiska Doaru, takže súbor na disku už nie je potrebný). Ctrl+S uloží hneď.
- **Na server** (priečinok Koncepty) sa koncept nahrá 30 s po poslednom uložení alebo hneď pri zatvorení okna – nie pri každom písmene. Nová verzia sa nahrá skôr, než sa stará zmaže; verzie sa hľadajú podľa stabilného Message-ID (aj na serveroch bez UIDPLUS).
- **Zatvorenie okna** sa už nepýta: rozpísaná správa sa uloží ako koncept (ako v Gmaile/Outlooku). Prázdne okno nevytvorí nič; koncept, z ktorého používateľ všetko vymazal, sa zahodí. **Zahodiť** (s potvrdením) vymaže koncept aj zo servera.
- **Otvorenie konceptu:** dvojklik/Enter v Konceptoch, alebo „Upraviť koncept“ v čítaní. Ak ho Doar upravoval, použije sa lokálna (najnovšia) verzia; koncept z iného programu sa načíta zo servera a ďalšie úpravy ho nahradia (Message-ID zostáva). Jeden koncept = jedno okno.
- **Odoslanie konceptu** ho zmaže z Konceptov (hneď zo zoznamu, zo servera pri najbližšej synchronizácii).
- **Zmena odosielateľa (Od)** presunie koncept: z Konceptov pôvodného konta sa odstráni, do nového sa nahrá.
- **Obmedzenie:** koncept, ktorý sa ešte nestihol nahrať (napr. bez pripojenia), je zatiaľ len v tomto počítači a v zozname Konceptov sa ukáže až po nahratí. Úplná offline fronta je v 0.3.

## 2026-10-22 – vyhľadávanie (0.2d)

- **Lokálny fulltext** (SQLite FTS5 v tomto počítači), nie hľadanie na serveri: rýchle, funguje bez pripojenia a rovnako pri každom poskytovateľovi.
- **Bez ohľadu na diakritiku a veľké písmená**, slová ako začiatky („faktur“ nájde „faktúra“), všetky slová musia byť v správe. „Presná fráza“ v úvodzovkách. Polia `od:`/`from:`, `komu:`/`to:`, `predmet:`/`subject:`. Syntax FTS5 od používateľa sa neinterpretuje (všetko je text).
- **Rozsah:** predvolene všetky priečinky všetkých kont (aj Kôš a Spam – vo výsledku je vidieť priečinok), alebo len zobrazený priečinok. Výsledky od najnovších.
- **Neúplná kópia:** ak niektoré správy v rozsahu ešte nemajú stiahnutý text, Doar to povie („hľadá sa v nich len v predmete a adresách“).
- Ctrl+E = do poľa hľadania (ako v Outlooku), Esc = zrušiť, Enter = hľadať hneď (inak 0,3 s po dopísaní).

## 2026-10-22 – nastavenia konta, upozornenia (0.2e)

- **Nastavenia** (⚙, Súbor → Nastavenia…, Ctrl+,): kontá (meno odosielateľa, názov, farba, podpis, kópia v Odoslaných, server, odstránenie) a Všeobecné (jazyk, upozornenia).
- **Podpis** = čistý text s oddeľovačom „-- “ (štandard, ktorý iné programy pri odpovedi samy odstraňujú). Vloží sa do novej správy a nad citáciu v odpovedi/preposlaní; pri zmene odosielateľa sa vymení, ak ho používateľ neupravil. Do konceptov sa nevkladá znova.
- **Zmena servera alebo hesla** sa uloží len po úspešnom overení (prihlásenie IMAP aj SMTP). Bez zadania nového hesla sa overí uloženým. Heslo sa do rozhrania nikdy nevracia.
- **Odstránenie konta** (s potvrdením): z Doaru zmizne konto, lokálna kópia pošty, koncepty uložené len tu a neodoslané správy (upozorní na ich počet). Na serveri sa nemení nič. Počas zálohy konta sa odstrániť nedá.
- **Upratovanie úložiska:** originály, na ktoré už nič neodkazuje, sa mažú po odstránení konta a minútu po štarte (len súbory staršie ako 10 min., aby sa nezmazal práve zapisovaný).
- **Upozornenie na novú poštu:** systémové oznámenie pre nové neprečítané správy v doručenej pošte (nie pri prvom načítaní konta, nie keď je Doar v popredí). Kliknutie otvorí správu. Dá sa vypnúť; odosielateľa a predmet možno skryť (uzamknutá obrazovka).
- **Odznak neprečítaných:** počet v názve okna; na Windows červený bod na ikone v paneli úloh, na macOS/Linuxe číslo na ikone.

## 2026-10-22 – formátovanie, našepkávanie adries, tlač (0.2f)

- **Editor TipTap 3.31.4** (pevná verzia, vyše 3 týždne stará, MIT). Len to, čo sa bezpečne odošle e-mailom: tučné, kurzíva, podčiarknuté, prečiarknuté, nadpis, odrážky, číslovaný zoznam, citácia, odkaz (Ctrl+K). Žiadne obrázky ani farby v 0.2.
- **Formátovaná správa** odchádza ako multipart/alternative: HTML (jadro ho vždy znova prečistí na tieto značky) + textová podoba, ktorú vytvorí jadro z HTML (odseky, „- “ a „1. “ v zoznamoch, „> “ citácia, odkaz „text <adresa>“). Text z rozhrania sa pri HTML nepoužije.
- **Predvolene formátovane**, dá sa prepnúť na čistý text pri každej správe (pri strate formátovania s potvrdením) aj natrvalo v Nastaveniach. Koncept si formát pamätá.
- **Odpoveď:** citácia ako blockquote (aj v textovej podobe „> “), nad ňou prázdny odsek s kurzorom a podpis. Podpis v HTML ako odsek „--“ + riadky; v textovej podobe vždy „-- “.
- **Našepkávanie adries** v poliach Komu/Kópia/Skrytá kópia: najprv adresy, na ktoré používateľ písal (počet a čas), potom odosielatelia doručenej pošty; od začiatku slova v mene alebo adrese, bez diakritiky. Enter/Tab vyberie, Esc zavrie. Meno sa uloží už pri odoslaní (adresy v databáze, nikdy mimo počítača).
- **Tlač** (Ctrl+P, 🖨 v čítaní, ponuka): dokument s hlavičkou a prečisteným telom vytlačí skryté okno bez JavaScriptu; CSP nedovolí nič načítať z internetu (sledovacie obrázky sa nenačítajú ani pri tlači). Dočasný súbor sa po tlači zmaže.

## 2026-10-22 – uzavretie 0.2

- **Heslá:** prechod na asynchrónne šifrovanie Electronu (`safeStorage.encryptStringAsync`/`decryptStringAsync`); staré synchrónne funkcie sú označené na zrušenie. Heslá uložené predtým sa prečítajú bez zmeny; ak systém zmení kľúč, heslo sa uloží znova. Overené ručne na Windows (konto sa pripojí bez nového zadania hesla).
- **0.2 overená** testami (unit, integračné proti Dovecotu, rozhranie) a ručne na Windows so skutočným kontom (cami.sk / Websupport): Kôš a Vrátiť späť, prílohy vrátane pretiahnutia súboru, koncepty, vyhľadávanie, upozornenia a odznak, formátovaná správa, našepkávanie adries.
- **Neoverené ručne:** dialóg tlače vo Windows (test overuje len tlačený dokument), Gmail.

## 2026-10-22 – práca bez pripojenia (0.3a)

- **Odoslanie bez pripojenia:** ak sa k SMTP serveru nedá pripojiť (sieť, DNS, odmietnuté spojenie, časový limit), správa určite neodišla – zostane vo fronte so stavom „čaká na pripojenie“ a odošle sa sama (15 s, 30 s, … najviac 5 min., hneď po pripojení k sieti alebo prebudení počítača). Používateľ ju môže zrušiť. Chyby servera (odmietnutý adresát, zlé heslo) ostávajú chybou, o ktorej rozhodne používateľ; nejasný výsledok sa nikdy neopakuje sám.
- **Fronta zmien** (príznaky, presuny, mazanie, koncepty) a odosielania je v databáze – prežije reštart aj pád. Stavový riadok ukazuje „bez pripojenia · na server čaká: N“.
- **Nestiahnutý obsah** je v zozname označený ☁; otvorenie bez pripojenia povie, že obsah nie je k dispozícii.
- **Opätovné pripojenie:** udalosť siete v rozhraní (`online`) a prebudenie/odomknutie počítača (main `powerMonitor`) zrušia čakanie a pripoja sa hneď. Opakovanie po chybe je vždy len jedno naplánované (žiadne hromadenie pokusov pri mnohých zmenách bez siete).
- Nový kód chyby `NO_NETWORK` (ENETUNREACH a pod.).

## 2026-10-22 – obnova zo zálohy do konta (0.3b)

- **Spustenie:** Súbor → Obnoviť zo zálohy… (aj odkaz v ľavom paneli). Súbor vyberá používateľ v natívnom dialógu, jadro ho smie len čítať (`files.allow`, režim read). Pôvodný súbor sa nikdy nemení.
- **Dva režimy:** *do pôvodných priečinkov* (len záloha Doar) – špeciálne priečinky podľa funkcie (`\Sent` → Odoslané servera, aj keď sa volá inak; ak chýba, založí sa), ostatné podľa cesty (chýbajúce sa založia aj s nadradenými, oddeľovač a menný priestor servera sa doplnia). *Všetko do jedného priečinka* – nový (predvolene „Import – názov súboru“) alebo existujúci. Správy bez metadát Doar idú vždy do zvoleného priečinka.
- **Postup:** 1. prečítanie súboru prúdom (v pamäti je naraz jedna správa) a zápis zoznamu správ do `import_items` (pozícia v súbore, odtlačok, kľúč na porovnanie, cieľ), 2. príprava priečinkov, 3. kontrola duplicít, 4. `APPEND` s príznakmi a interným dátumom. Vlastné štítky (kľúčové slová) len ak ich priečinok povoľuje (`PERMANENTFLAGS \*`), inak sa v súhrne uvedie počet.
- **Duplicity** (nespolieha sa len na Message-ID): porovnáva sa **v rámci cieľového priečinka**. Kandidáti na serveri sa vyberú podľa Message-ID (bez neho podľa dátumu z hlavičky a odosielateľa) a zhoda sa vždy overí **celým obsahom** (SHA-256 kanonického tvaru – z lokálnej kópie, chýbajúce sa stiahnu po dávkach). Veľkosť sa nepoužíva: server môže originál uložiť inak (bez koncového CRLF, s holými LF) – pôvodne to spôsobilo zdvojenie 4 správ pri obnove do pôvodného konta (opravené, pokryté testom). Ak sa kľúč nezhoduje, skúsi sa ešte zhoda obsahu s lokálnou kópiou priečinka. Každá správa na serveri „pokryje“ najviac jednu správu zo súboru – preto sa správne obnovia aj dve rovnaké kópie v jednom priečinku a tá istá správa v dvoch priečinkoch je legitímne v oboch. Pri opakovanej obnove sa navyše použijú UID správ nahraných predošlými obnovami (aj keby ich server pri uložení upravil).
- **Prerušenie a pokračovanie:** stav každej správy sa ukladá hneď (`pending` → `appending` → `appended`/`duplicate`/`failed`). Zrušenie, výpadok spojenia, plná schránka aj pád aplikácie nechajú obnovu „nedokončenú“ – dialóg ponúkne Pokračovať (alebo Zahodiť; na serveri sa nič nemaže). Pokračuje sa len so súborom, ktorý sa nezmenil (veľkosť, čas zmeny, odtlačok každej správy).
- **Nejasný výsledok** (spojenie spadlo počas `APPEND`, pád aplikácie): pred opakovaním sa priečinok znova porovná so súborom; správa, ktorá na serveri je, sa označí ako nahraná a nenahrá sa druhýkrát.
- **Plná schránka** (`OVERQUOTA`): obnova sa zastaví, súhrn ukáže, čo sa nahralo, čo čaká, a ako pokračovať (uvoľniť miesto → Pokračovať). Správu, ktorú server odmietol (napr. príliš veľká), označí ako odmietnutú a pokračuje ďalej.
- **Súhrn:** po priečinkoch – v zálohe / nahrané / už boli / odmietnuté / čaká; počet správ zmenených mimo Doar (nesedí hash), správ bez metadát, preskočených záznamov a štítkov, ktoré server neuložil. Po obnove sa konto synchronizuje.
- Na obnovu sa používa samostatné IMAP spojenie (synchronizácia nečaká). Naraz beží jedna obnova.
- Migrácia 007 (stĺpce `import_items`), nové testovacie kontá `adam`, `beata`, `cyril`, `dusan` a `mala` (kvóta 12 kB).
- **Neoverené:** Gmail ako cieľ (štítky cez `X-GM-LABELS`) a servery, ktoré pri uložení menia obsah správy.
- **Oprava synchronizácie (nájdená opakovaným spúšťaním testov):** sťahovanie obsahu teraz overí UIDVALIDITY otvoreného priečinka – ak bol priečinok na serveri medzitým nahradený, nestiahne obsah inej správy s rovnakým UID a najprv sa priečinok synchronizuje. Zoznam správ, ktorých obsah sa nedal stiahnuť, sa pri každej synchronizácii vynuluje (ID riadku mohlo byť použité pre novú správu – jej obsah by sa inak nestiahol). Test „server presun odmietne“ mal časový súbeh – opravené poradie krokov.

## 2026-10-22 – lokálny archív (0.3c)

- **Otvorenie:** Súbor → Otvoriť archív… (aj odkaz v ľavom paneli). Súbor .mbox (záloha Doar aj cudzí) sa otvorí **len na čítanie** – nič sa nenahráva na server a súbor sa nikdy nemení. Jadro ho smie len čítať (súbor vybraný v dialógu).
- **Načítanie:** súbor sa prejde prúdom; do databázy sa uloží len zoznam správ (pozícia a dĺžka v súbore, odtlačok obsahu), údaje pre zoznam a fulltext (rovnaký tokenizér ako pošta – bez diakritiky). Obsah správy a prílohy sa pri otvorení čítajú zo súboru.
- **Priečinky:** záloha Doar podľa metadát (Doručená pošta, Odoslané… podľa funkcie, ostatné s cestou „Faktúry / 2026“); cudzí mbox = jeden priečinok „Správy“. Stav prečítania a hviezdička podľa metadát / `Status`, `X-Status`.
- **V rozhraní** je archív samostatná sekcia v ľavom paneli pod kontami (s ×  na zatvorenie). Priečinky a správy archívu majú záporné ID – rovnaké požiadavky (zoznam, čítanie, vyhľadávanie, prílohy, odpoveď) fungujú pre poštu aj archív a nedajú sa pomiešať. Zmeny (prečítané, hviezdička, presun, mazanie, ťahanie) sa na archív neuplatnia; v čítaní je označenie „Archív – len na čítanie“.
- **Odpoveď / preposlanie** správy z archívu: z konta, z ktorého záloha pochádza (ak je v Doare), inak z prvého konta.
- **Zmenený súbor:** pred zobrazením sa obsah overí odtlačkom; ak nesedí, správa sa nezobrazí a archív sa načíta znova. **Chýbajúci súbor** (odpojený disk): archív zostane v zozname s upozornením, po vrátení súboru funguje ďalej. Po štarte aplikácie sa kontroluje, nedokončené načítanie sa zopakuje.
- **Zatvorenie** zmaže len zoznam a fulltext v Doare, súbor zostane.
- Migrácia 008 (`archives`, `archive_folders`, `archive_messages`, `archive_fts`).

## 2026-10-22 – názov Doar Mail, ikona, jazyk (koniec 0.3)

- **Názov** zobrazovaný používateľovi je **Doar Mail** (okná, ponuka Štart, O aplikácii, stavový riadok, `productName`). Interne zostáva `doar` a **dátový priečinok je vždy `%APPDATA%\Doar`** (pevne nastavený v main procese) – premenovanie nezmení kontá, poštu, heslá ani nastavenia.
- **Ikona:** vlastný návrh – biela obálka na modrom podklade (`resources/icon.svg`, pre 16–32 px zjednodušená `icon-small.svg`). Z nich vznikajú `resources/icon.png` (okno, panel úloh) a `build/icon.ico`, `build/icon.png` (inštalátor v 0.4). Licencia MIT ako zvyšok projektu.
- **Jazyk:** okrem Nastavenia → Všeobecné (Automaticky / Slovenčina / English) aj v menu **Zobraziť → Jazyk / Language** (dvojjazyčný názov, aby ho našiel aj ten, kto aktuálnemu jazyku nerozumie). Zmena platí hneď, aj pre menu.
- **Oprava (nájdená opakovaným spúšťaním testov):** imapflow pri odmietnutí presunu, zmeny príznakov alebo vymazania nevyhodí chybu, ale vráti `false`. Doar to bral ako úspech – napr. presun do priečinka, ktorý medzitým niekto zmazal, sa lokálne „vykonal“ a správa zo zoznamu zmizla, hoci na serveri zostala. Teraz sa `false` berie ako odmietnutie: zmena sa skúsi znova a po 3 pokusoch sa správa vráti do zoznamu označená ako neúspešná. Test presunu opravený, aby nezávisel od načasovania.

## 2026-10-22 – presun sa ukáže hneď (koniec 0.3)

- Presunutá (aj odstránená do Koša, archivovaná, spam) správa sa **hneď objaví v cieľovom priečinku** so značkou ⏳ „čaká na server“; na server ide ako doteraz až po čase na „Vrátiť späť“ (8 s). Počty v priečinkoch sa menia hneď.
- Riešené stĺpcom `messages.moving_to` (migrácia 009): pôvodné umiestnenie (`folder_id`, `uid`) platí, kým presun nepotvrdí server; zoznam, počty, „Vybrať všetko“ a vyhľadávanie ukazujú správu v cieli.
- **Vrátiť späť** ju vráti na pôvodné miesto; **odmietnutý presun** (po 3 pokusoch) tiež – s označením ⚠.
- **Ďalšia akcia počas čakania** (iný presun, natrvalo zmazať): predošlý presun sa zruší a platí posledná voľba; ostatné správy z pôvodného presunu idú tam, kam mali. Ak sa presun na serveri práve vykonáva, Doar povie „skúste o chvíľu“ (aby sa správa nepresúvala dvakrát).
- Špeciálny priečinok, ktorý na serveri ešte neexistuje (Doar ho pri presune založí), sa takto vopred neukáže – správa sa v ňom objaví po vykonaní.

## 2026-10-22 – uzavretie 0.3

- Verzia **0.3.0**: práca bez pripojenia (trvalá fronta), obnova zo zálohy do konta s kontrolou duplicít a pokračovaním, lokálny archív mbox, názov Doar Mail, ikona, prepínanie jazyka v menu, presun viditeľný hneď.
- Overené testami (unit, integračné proti Dovecotu – opakovane, rozhranie) a ručne na Windows so skutočným kontom: práca bez pripojenia, obnova zo zálohy, archív.
- **Neoverené:** Gmail (záloha, obnova so štítkami), servery bez UIDPLUS; kam sa pri prvej obnove do pôvodného konta (pred opravou porovnávania) nahrali 4 správy navyše – používateľ ich zmazal.

## 2026-10-22 – balík pre Windows (0.4a)

- **electron-builder 26.15.3** (MIT, len vývojový nástroj), konfigurácia `electron-builder.yml`, príkaz `npm run dist` → `dist\Doar-Mail-<verzia>-win-x64.zip` (dá sa zostaviť na Windowse aj na Linuxe).
- **Prečo nie inštalátor:** inteligentná kontrola aplikácií (Smart App Control) na Windowse zablokovala (overené na počítači používateľa): 1. pomocný program, ktorý electron-builder spúšťa pri tvorbe inštalátora NSIS, 2. aj samotný `Doar Mail.exe`, do ktorého electron-builder vloží ikonu a údaje o verzii. Oba sú nepodpísané a Windows ich nepozná. Originálny `electron.exe` (tiež nepodpísaný) púšťa – je známy (`npm run dev` sa otvorí).
- **Riešenie bez vypnutia ochrany:** `Doar Mail.exe` je **bit po bite originálny Electron**, len premenovaný (`signAndEditExecutable: false`, `disableAsarIntegrity: true`; overené zhodou SHA-256 s `electron.exe` 45.0.0). Naša aplikácia je v `resources\app.asar`, ikona pre odkazy v `resources\icon.ico`.
- **Bez inštalátora:** zip sa rozbalí do ľubovoľného priečinka (odporúčané `%LOCALAPPDATA%\Programs\Doar Mail`). Pri spustení si Doar Mail sám vytvorí odkaz v ponuke Štart (vždy, ak chýba – viaže sa naň AppUserModelID pre oznámenia) a pri prvom spustení na ploche; po presune priečinka odkazy opraví. Odstránenie = zmazať priečinok a odkazy; pošta, kontá a nastavenia zostávajú v `%APPDATA%\Doar`.
- `.exe` má ikonu Electronu (v Prieskumníkovi pri súbore); odkazy, okno a panel úloh majú ikonu Doar Mail.
- **Neskôr:** podpísaný inštalátor (certifikát na podpisovanie kódu, napr. Certum pre open source) – potom aj vlastná ikona v `.exe` a bežný inštalátor/odinštalátor.

## 2026-10-22 – aktualizácie (0.4b)

- **Zdroj:** GitHub Releases (`Korgus7/doar`, najnovšie vydanie, bez predbežných). Vydanie musí mať prílohy `Doar-Mail-<verzia>-win-x64.zip` a `doar-mail-update.json` (verzia, súbor, veľkosť, SHA-256 – vytvorí ho `npm run dist`). Vydanie bez manifestu Doar Mail ignoruje.
- **Súkromie:** Doar Mail sa pýta len GitHubu (`api.github.com`, bez identifikátorov, User-Agent „Doar-Mail-Updater“). Automatická kontrola 30 s po štarte a potom každých 12 h, dá sa vypnúť (Nastavenia → Všeobecné → Aktualizácie); ručne cez Pomocník → Skontrolovať aktualizácie…. Pri vývoji (`npm run dev`) sa automaticky nekontroluje.
- **Nič bez súhlasu:** nová verzia sa len ponúkne (pruh pod panelom nástrojov, „Čo je nové“ z popisu vydania). Po kliknutí na Stiahnuť: stiahnutie do dočasného priečinka → overenie veľkosti a SHA-256 → rozbalenie **vedľa** bežiacej verzie (`…\Programs\Doar Mail 0.4.1`, najprv do `.part`, ochrana proti ceste mimo priečinka) → „Reštartovať teraz“. Bežiace súbory sa nikdy neprepisujú.
- Nová verzia pri štarte sama presmeruje odkazy (ponuka Štart, plocha). Na disku zostáva bežiaca a **jedna predošlá** verzia (návrat späť = spustiť `Doar Mail.exe` zo starého priečinka); staršie sa zmažú – len priečinky, z ktorých Doar Mail naozaj bežal a obsahujú `Doar Mail.exe` aj `resources\app.asar`.
- `Doar Mail.exe` je v každej verzii originálny Electron → inteligentná kontrola aplikácií ho púšťa aj po aktualizácii (pokiaľ sa nezmení verzia Electronu na takú, ktorú Windows ešte nepozná – vtedy treba overiť).
- Overenie pravosti: SHA-256 z manifestu chráni pred poškodeným/neúplným súborom, nie pred kompromitovaným účtom na GitHube (to vyrieši až podpis kódu).
- Starší Doar Mail nespustí databázu novšej verzie (`DB_TOO_NEW`) – pri návrate späť po migrácii treba použiť zálohu `doar.db.bak-v<verzia>`.
- **Sieť:** okná majú internet zablokovaný (sledovacie obrázky), preto aktualizácie idú cez vlastnú reláciu `session.fromPartition('doar-update')` – inak `net::ERR_BLOCKED_BY_CLIENT` (zistené na Windows, test `update.spec` s náhradným GitHub API).
- **asar:** Electron v main procese považuje `*.asar` za archív aj pri zápise/mazaní („Invalid package …\app.asar“). Rozbaľovanie a upratovanie preto bežia s `process.noAsar = true`.
- Výsledky kontroly a chyby aktualizácií sa zapisujú do `%APPDATA%\Doar\logs\doar.log` (`[update]`).
- **Overené na Windows (2026-10-22):** 0.3.0 → 0.3.1-test z testovacieho zdroja: stiahnutie, rozbalenie vedľa, reštart, odkazy v ponuke Štart aj na ploche presmerované na novú verziu. **Naostro (2026-10-24):** vydanie v0.4.0 na GitHube – 0.3.1-test ho našla, stiahla, nainštalovala vedľa a reštartovala sa do 0.4.0; upratanie zmazalo najstaršiu verziu (zostali 0.4.0 a 0.3.1-test). Podmienka: repozitár musí byť **verejný** (Doar Mail sa GitHubu pýta bez prihlásenia; zo súkromného dostane 404 a hlási „máte najnovšiu verziu“).
- **Testovací zdroj:** premenná prostredia `DOAR_UPDATE_FEED` = priečinok s `doar-mail-update.json` a zipom (napr. `D:\_Doar\dist`); `DOAR_UPDATE_API` = náhradná adresa GitHub API (len testy).
- Kód: `src/main/update-core.ts` (bez Electronu, unit testy), `src/main/updater.ts`, `scripts/release-manifest.mjs`, rozhranie `UpdateBanner.svelte`.

## 2026-10-24 – AI (0.4c)

- **Voliteľná, predvolene vypnutá** (Nastavenia → AI). Bez nej sa nič nemení – žiadne tlačidlá AI.
- **Poskytovatelia:** Anthropic (Messages API, predvolený model `claude-haiku-5-5` – lacný a na poštu stačí; dá sa zmeniť), OpenRouter (OpenAI-kompatibilné API), lokálny server (Ollama, LM Studio… cez OpenAI-kompatibilné `/v1`). Anthropic a OpenRouter majú pevnú adresu; lokálny server: `https` kamkoľvek, `http` len localhost, 127.x, 10.x, 172.16–31.x, 192.168.x, `*.local` – inak by obsah pošty išiel nešifrovane cez internet.
- **Kľúč:** pre každého poskytovateľa zvlášť v bezpečnom úložisku systému (rovnako ako heslá); bez neho len do zatvorenia aplikácie. Nikdy v databáze, nastaveniach ani logu. Model sa pamätá pre každého poskytovateľa zvlášť.
- **Funkcie (podľa zadania):** zhrnutie správy (čítačka, tlačidlo „Zhrnúť“, aj v archíve), návrh odpovede (okno správy, voliteľný pokyn, nadväzuje na už napísaný začiatok), úpravy textu (opraviť chyby, formálnejšie, priateľskejšie, skrátiť, preložiť do 10 jazykov, vlastný pokyn).
- **Čo a kam sa odošle, je vždy vidieť:** zhrnutie sa predvolene pýta („Odošle sa text tejto správy (bez príloh) do: Anthropic · model“, dá sa vypnúť); panel v okne správy stále ukazuje rozsah (označený text / vlastný text bez podpisu a citácie, pri odpovedi aj pôvodná správa) a cieľ. Prílohy ani ich názvy sa neodosielajú.
- **Nič samo:** AI nemá nástroje; výsledok je len text. Do správy sa vloží až po kliknutí „Vložiť / Nahradiť“ (Ctrl+Z vráti späť); ak sa text medzitým zmenil, nevloží sa nič. Odoslanie je vždy na používateľovi.
- **Ochrana pred pokynmi v e-mailoch:** obsah je v značkách `<email>`, `<draft>`, `<text>`; rovnaké značky v obsahu sa zneškodnia. Systémové zadanie zakazuje riadiť sa pokynmi z týchto dát. Zhrnutie je v jazyku rozhrania, odpoveď v jazyku správy.
- Dlhý text sa odstrihne (40 000 znakov) a rozhranie na to upozorní. Priebežný text (streamovanie) ide do rozhrania udalosťou `ai.chunk`; úloha sa dá zastaviť. Časové limity: odpoveď servera do 60 s, medzi časťami 90 s.
- Log: len úloha, poskytovateľ, model, trvanie, dĺžka výstupu a kód chyby – nikdy obsah (overuje e2e test).
- **Overené:** unit testy (SSE, oba formáty API, chyby, zrušenie, časové limity, adresy, zadania, kľúč), e2e s falošným lokálnym serverom (nastavenia, zhrnutie s potvrdením, návrh odpovede, oprava, preklad označeného textu, formátovaný aj čistý text, Ctrl+Z, log bez obsahu). Na Windows (2026-10-24) používateľ overil skutočný OpenRouter. **Neoverené:** skutočné API Anthropic, Ollama/LM Studio.

## 2026-10-24 – uzavretie 0.4

- Verzia 0.4.0: balík pre Windows (0.4a), aktualizácie z GitHub Releases (0.4b), voliteľná AI (0.4c). Prvé vydanie na GitHube (`v0.4.0`) so zipom a `doar-mail-update.json`.
- Testy e2e berú verziu z `package.json` (netreba ich meniť pri každom vydaní).
- Zostáva: podpis kódu (menej varovaní Windows), servery bez UIDPLUS, skutočné API Anthropic a Ollama. **Gmail s heslom aplikácie overil používateľ 2026-10-24** (konto sa pridalo). Prihlásenie cez Google (OAuth) nerobíme: plný prístup k IMAP je u Google „restricted scope“ – bez platenej ročnej bezpečnostnej previerky najviac 100 používateľov za celý život projektu a varovanie „neoverená aplikácia“. Microsoft (Outlook.com) OAuth takú prekážku nemá.

## 2026-10-24 – jazyky a hebrejčina (0.5a)

- Jazyky rozhrania: slovenčina, angličtina, **čeština, nemčina, maďarčina, hebrejčina**. Jazyk systému sa vyberie sám (čeština má vlastný preklad, už sa nemení na slovenčinu; `iw` = hebrejčina), inak angličtina. Ponuka Zobraziť → „Jazyk / Language“ a Nastavenia → Všeobecné ukazujú názvy jazykov v ich vlastnom jazyku.
- Preklady pripravila AI – **pred vydaním ich má skontrolovať rodený hovoriaci** (najmä hebrejčinu). Unit test stráži rovnaké kľúče a parametre vo všetkých jazykoch.
- **Hebrejčina = sprava doľava:** celé okno sa zrkadlí (priečinky vpravo). Štýly prevedené na logické vlastnosti; fyzické `left/right` ostali len tam, kde sú súmerné.
- **Pošta v hebrejčine aj v slovenskom rozhraní:** každý odsek správy má smer podľa svojho písma (`unicode-bidi: plaintext`, ak odosielateľ neurčil `dir`) – hebrejský odsek vpravo, anglický vľavo. Predmety, mená a úryvky v zozname a v hlavičke sú izolované (`<bdi>`), aby sa nemiešali s dátumom a interpunkciou.
- **Písanie:** odseky a nadpisy v editore majú `dir="auto"` (smer podľa obsahu, aj v odoslanej správe, aby ju príjemca videl správne); citácia a zoznamy majú smer rozhrania. Predmet, adresy a čistý text tiež podľa obsahu. Odchádzajúce HTML povolí len `dir` = `ltr`/`rtl`/`auto`.
- AI: zhrnutie v jazyku rozhrania (aj hebrejsky); preklad aj do hebrejčiny.
- Overené: unit testy (kľúče, parametre, výber jazyka, `dir` v odoslanom HTML), e2e (prepnutie na hebrejčinu z menu, zrkadlové rozloženie, hebrejská správa zarovnaná sprava a anglický riadok zľava, odpoveď po hebrejsky s `dir="auto"`, návrat na slovenčinu). Neoverené: preklady rodeným hovoriacim, tlač hebrejskej správy, kontrola pravopisu v hebrejčine.

## 2026-10-24 – prihlásenie cez Microsoft a Google, ďalšie jazyky (0.5b)

- **Prihlásenie cez Microsoft a Google (OAuth 2.0)** – na pokyn používateľa obidve (rozhodnutie „Google nerobíme“ z uzavretia 0.4 je zrušené). Postup pre desktopové aplikácie: systémový prehliadač používateľa + návrat na `http://127.0.0.1:<náhodný port>/callback` (Microsoft `localhost`), PKCE S256, náhodný `state`, 10 min na dokončenie. Heslo zadáva používateľ priamo Microsoftu/Googlu, Doar ho nevidí.
- Ukladá sa len obnovovací token (`secrets`, kľúč `account:<id>:oauth`), prístupový token len v pamäti a obnoví sa 5 min pred vypršaním. Microsoft pri obnove vydáva nový obnovovací token – ukladá sa. Odmietnutý token (`invalid_grant`) = `OAUTH_EXPIRED`: synchronizácia sa zastaví a v Nastaveniach konta je tlačidlo „Prihlásiť sa znova cez …“. Prihlásenie iným účtom než má konto sa odmietne.
- IMAP cez XOAUTH2/OAUTHBEARER (imapflow), SMTP cez XOAUTH2 (nodemailer). Stĺpec `auth_type` už bol v migrácii 001, nová migrácia netreba.
- Sprievodca: pri Outlook.com/Hotmail/Microsoft 365 len tlačidlo „Prihlásiť sa cez Microsoft“ (heslo sa nezadáva). Pri Gmaile tlačidlo „Prihlásiť sa cez Google“ **a** naďalej heslo aplikácie. Konto dostane adresu, ktorou sa používateľ naozaj prihlásil.
- **Registrácie aplikácie** (ID klienta v `src/core/oauth/oauth.ts`, `BUILT_IN`). Prázdne ID → sprievodca sa správa ako predtým (Outlook: „zatiaľ nepodporované“, Gmail: heslo aplikácie). Pri desktopovej aplikácii ID ani „tajomstvo“ klienta Google nie sú skutočné tajomstvá (Google to tak dokumentuje).
- **Google zaregistrovaný 2026-10-25:** projekt Google Cloud „Doar Mail“, klient typu Desktop app, režim Testing (prihlásiť sa môžu len testovací používatelia zapísaní v Audience). **Prihlásenie cez Google naostro overil používateľ 2026-10-25** (konto sa pridalo). Pred vydaním pre ostatných treba v Audience zvoliť „Publish app“, inak ostatným Google prihlásenie odmietne.
- **Microsoft zatiaľ nezaregistrovaný:** osobný účet Microsoft už nemôže registrovať aplikácie bez adresára (tenant); adresár dá bezplatný účet Azure, ktorý ale vyžaduje platobnú kartu na overenie. Používateľ zatiaľ odložil.
- **Google obmedzenie:** rozsah `https://mail.google.com/` je „restricted“. Neoverená aplikácia: varovanie pri prihlásení a najviac 100 používateľov za celý život projektu; overenie vyžaduje platenú ročnú bezpečnostnú previerku. Preto pri Gmaile ostáva aj heslo aplikácie.
- Testy: testovací Dovecot overuje tokeny cez introspekciu (`scripts/testserver.mjs`, port 3880), testovací SMTP prijíma XOAUTH2. Integračný test s falošným prihlasovacím serverom (PKCE, odmietnutie, sfalšovaný `state`, pridanie konta, synchronizácia, odoslanie, obnova tokenu s rotáciou, odvolaný token → `OAUTH_EXPIRED` → opätovné prihlásenie, odstránenie konta) a e2e test sprievodcu a nastavení (premenná `DOAR_OAUTH_TEST_URL`).
- **Jazyky:** pribudli **francúzština, španielčina a ruština** (aj AI preklad do ruštiny). Preklady pripravila AI – skontrolovať rodeným hovoriacim.
- Neoverené: skutočné prihlásenie u Microsoftu (čaká na registráciu aplikácie).
- **Verzia 0.5.0** (2026-10-25): prihlásenie cez Google, jazyky cs/de/hu/fr/es/ru/he. Vydanie `v0.5.0` na GitHube; aplikácia Google prepnutá do produkcie (neoverená, limit 100 používateľov), zásady súkromia na `cami.sk/doar/#sukromie`. **Aktualizáciu 0.4.0 → 0.5.0 overil používateľ naostro.**

## 2026-10-26 – nový vzhľad a výber svetlý/tmavý (0.6)

- **Vzhľad podľa webu:** hlavná farba tmavá oceľová `#2d4362` (žiadna žiarivá modrá), minimálne zaoblenia 3 px všade (používateľ nechce guľaté tlačidlá), čiarové ikony (`components/Icon.svelte`, vlastné kresby) namiesto emoji a znakov.
- **Svetlá téma jemne krémová:** zoznam a čítanie `#fbfaf7`, ľavý panel `#f1efea`, hlavičky kont `#e8e5df`, čiary `#e3e0da`. **Tmavá téma** grafitová so svetlejšou oceľovou. HTML e‑maily ostávajú na svetlom pozadí aj v tmavej téme (sú robené na bielu).
- **Výber vzhľadu** v Nastaveniach → Všeobecné: Podľa systému / Svetlý / Tmavý; prepne sa hneď (hlavný proces cez `nativeTheme.themeSource`, aj titulok okna a ostatné okná).
- **Ľavý panel:** každé konto je samostatný blok s podfarbenou hlavičkou, farebným prúžkom a zbalením. Spodné odkazy (Pridať konto, Zálohovať, Obnoviť, Otvoriť archív) presunuté do **menu ☰** v hornej lište (aplikačné menu je skryté, ukáže sa len po Alt).
- **Farby kont** tlmené; migrácia 010 preklopí staré žiarivé predvolené farby na tlmené, vlastné voľby používateľa nemení.
- **Nová ikona programu:** obrys obálky na oceľovom podklade.
- Overené: unit 143, integračné 111, e2e 20; snímky svetlá/tmavá/menu/nastavenia pozreté. **Vydanie `v0.6.0` (2026-10-26); vzhľad na Windows aj aktualizáciu 0.5.0 → 0.6.0 overil používateľ.**

## 2026-10-26 – import z iných programov (0.7)

- **Windows Mail / Windows Live Mail** (priečinok so súbormi `.eml`), **Outlook Express 5/6** (priečinok so súbormi `.dbx` a Folders.dbx, alebo jeden `.dbx`), **Outlook** (`.pst`, aj `.ost`). Ponuka ☰ → „Importovať z iného programu…“; ten istý dialóg ako obnova zálohy (rovnaké kroky, priebeh, súhrn, pokračovanie).
- **Princíp:** zdroj sa najprv prevedie do dočasného súboru vo formáte zálohy Doar (`import-work/import-<úloha>.mbox` v dátovom priečinku, `.part` a premenovanie) a ďalej ide bežná obnova – priečinky, duplicity, pokračovanie po prerušení, plná schránka. Dočasný súbor sa zmaže po dokončení alebo zahodení obnovy (a pri štarte, ak nepatrí nedokončenej obnove). Ak pri pokračovaní chýba, prevedie sa znova – výsledok je pre rovnaký zdroj vždy rovnaký, takže už nahraté správy sa nájdu ako duplicity.
- **Priečinky:** štandardné (Doručená, Odoslaná, Koncepty, Odstránená, Nevyžiadaná pošta) sa rozpoznajú podľa názvu v 9 jazykoch a priradia k priečinkom servera podľa funkcie; podpriečinky doručenej pošty idú pod INBOX. Outlook: koreň a „Top of Personal Folders“ sa vynechajú, preskočia sa vyhľadávacie priečinky, kalendár, kontakty, úlohy a poznámky.
- **Outlook Express:** vlastná čítačka podľa verejného popisu formátu (bez cudzej knižnice). Príznak „prečítané“ (0x80) je istý, „odpovedané“ (0x80000) podľa popisu – overí sa na skutočných súboroch. Názvy priečinkov v kódovaní Windows (stredoeurópske/západné podľa obsahu).
- **Outlook:** knižnica pst-extractor (MIT). Outlook neukladá text správy RFC 5322 – správa sa zloží znova: pôvodné internetové hlavičky (prijatá pošta), telo (text/HTML) a prílohy (aj vložené obrázky a priložené správy) cez MailComposer; hranice MIME odvodené z obsahu (opakovateľný výsledok). Príznaky: prečítané, označené, odpovedané, preposlané, neodoslané (koncept).
- **Windows Mail:** stav „prečítané“ je v osobitnej databáze programu, nie v `.eml` – správy sa importujú ako prečítané (rozhranie to povie).
- **Bezpečnosť:** priečinok vyberá používateľ v natívnom dialógu (nové povolenie „tree“ = čítanie priečinka); dlhý prevod Outlooku sa delí po správach, aby jadro neprestalo reagovať.
- Overené: unit testy čítačiek (vygenerované `.dbx` podľa popisu formátu, `.eml`, ukážkový `enron.pst` z balíka pst-extractor), integračné testy importu do testovacieho servera (štandardné priečinky, podpriečinky, príznaky, dátumy, opakovanie bez duplicít, zrušenie a pokračovanie, jeden priečinok), e2e test dialógu. **Neoverené: skutočné súbory Outlook Expressu a Outlooku používateľa** (dodá ich na testovanie).
- **Vydanie `v0.7.0` (2026-10-26)** – na želanie používateľa ešte pred testom na skutočných súboroch; prípadné opravy importu pôjdu v 0.7.x. Spolu s tým: výraznejšie farby kont (migrácia 011 preklopí tlmené predvolené farby z 010), klasické menu skryté (všetko v ☰), názov okna bez počtu neprečítaných.

## 2026-10-27 – priečinky, adresár, opravy (0.7.1)

- **Import naostro:** používateľ importoval skutočný `.pst` z Outlooku (110 správ) do svojho konta – prešlo. Pri nesprávnom alebo chýbajúcom hesle sa import zastavil bez možnosti heslo zadať → v okne importu pribudlo **pole na heslo**: heslo sa overí na serveri (IMAP aj SMTP), uloží ako v nastaveniach konta a import pokračuje. Konto s prihlásením cez poskytovateľa dostane výzvu prihlásiť sa znova v nastaveniach. Pri importe okno píše „Import sa zastavil“ (nie „Obnova“).
- **Farby kont:** predvolená výrazná paleta podľa návrhu používateľa (`#18a4d5 #ff7614 #9ddd08 #793cf2 #00cea8 #f03a47 #f7dd12 #ed0da6`), nové kontá ju dostávajú postupne; na výber aj tlmené farby z 0.6 a jedna neutrálna sivá. Migrácia 012 preklopí predvolené farby z 0.7 na najbližší odtieň novej palety, vlastné farby nemení. Hlavička konta je jemne podfarbená farbou konta, so štvorčekom a hrubším pásom.
- **Priečinky:** zbaľovanie podpriečinkov (pamätá sa v počítači; zbalený priečinok ukazuje neprečítané zo skrytých podpriečinkov). **Odstránenie** (pravý klik) s potvrdením a počtom správ: správy z priečinka aj podpriečinkov sa najprv presunú do Koša, až potom sa priečinky zmažú na serveri (od najhlbšieho); Gmail: zruší sa len štítok, správy ostanú vo Všetkej pošte. **Premenovanie a presun** (dialóg alebo ťahanie na iný priečinok / na hlavičku konta = najvyššia úroveň): IMAP RENAME, podpriečinky idú s ním, lokálne riadky dostanú novú cestu (správy a ich ID ostanú, nič sa nesťahuje znova). Doručenú poštu a špeciálne priečinky nejde odstrániť, premenovať ani presunúť. Pred zmenou priečinka sa najprv odošlú rozpracované zmeny (presuny, príznaky).
- **Adresár** (tlačidlo v hornej lište): kontakty (meno, e-mail, telefón, firma, poštová adresa, poznámka; jeden e-mail = jeden kontakt), hľadanie bez diakritiky, „Napísať správu“, „Kopírovať adresu“ (meno, firma, adresa na obálku). Karta „Z pošty“: adresáti odoslanej pošty, ktorí ešte nie sú v adresári. **Import** vCard 2.1/3.0/4.0 (aj quoted-printable vo Windows-1250 z Outlooku) a CSV (Outlook v rôznych jazykoch, Gmail, Excel s bodkočiarkou, UTF-8 aj Windows-1250); existujúci kontakt sa neprepíše, doplnia sa len prázdne polia. **Export** vCard 3.0 a CSV s hlavičkami Outlooku. Našepkávanie adries pri písaní ponúka najprv kontakty. Migrácie 013 a 014. Synchronizácia s mobilom (CardDAV) neskôr.
- **Polia:** fokus textových polí len jemným stmavením rámika (bez hrubého obrysu s medzerou), aj bez rámika okolo textu správy – želanie používateľa. Ovládanie klávesnicou ostáva viditeľné.
- **Microsoft Store:** pripravené (`npm run dist:store`, obrázky dlaždíc, verzia zo Store sa neaktualizuje sama a nevytvára odkazy). Registráciu v Partner Center aj aplikáciu v Azure (prihlásenie cez Microsoft) používateľ odložil na verziu 1.0.
- Overené: unit 163, integračné 121, e2e 23; používateľ vyskúšal nové funkcie u seba.

## 2026-10-27 – registrácia u Microsoftu (Azure)

- Bezplatný účet Azure (osobné použitie) → adresár; aplikácia **Doar Mail** v Entra ID: kontá z ľubovoľnej organizácie aj osobné (Outlook.com, Hotmail), platforma „Mobile and desktop“, presmerovanie `http://localhost/callback` (port Microsoft ignoruje, cestu nie – samotné `http://localhost` nestačilo). Client ID `b0ab1393-67c0-49a5-a6b2-f80dda999104` (verejný identifikátor) v `src/core/oauth/oauth.ts`. Bez tajomstva (verejný klient, PKCE) – nič neexpiruje.
- Bez overenia vydavateľa: pri prihlásení „unverified“; osobné kontá to nebráni, firemný správca môže neoverené aplikácie blokovať.
- **Overené naostro (testovacie konto Outlook.com):** prihlásenie, súhlas, výmena kódu za token, server IMAP prijal token („User is authenticated“). **Nefunguje:** IMAP ďalej odpovedá „User is authenticated but not connected“ – známy problém Microsoftu pri niektorých kontách Outlook.com (hlásia ho aj Thunderbird a iné programy, bez riešenia). SMTP: „SmtpClientAuthentication is disabled for the Mailbox“ – novým bezplatným kontám ho Microsoft vypína a používateľ ho zapnúť nemôže. Riešenie do budúcna: Microsoft Graph (čítanie aj odosielanie) pre kontá Outlook.com – kandidát na 1.0. Test zopakovať neskôr (nové konto sa môže rozbehnúť) a s kontom Microsoft 365.
- Technické detaily pri overení spojenia ukazujú aj presnú odpoveď servera IMAP.

## 2026-10-27 – synchronizácia adresára s kontaktmi Google

- **Spôsob:** CardDAV (RFC 6352) + sync-collection (RFC 6578), vlastný malý klient (`core/carddav.ts`, bez knižnice), tá istá cesta pôjde neskôr aj pre iCloud či Nextcloud. Google: `https://www.googleapis.com/.well-known/carddav`, len OAuth; v projekte Google Cloud zapnuté „Google Contacts CardDAV API“ a pridaný rozsah `https://www.googleapis.com/auth/carddav`.
- **Oprávnenie až na požiadanie:** rozsah kontaktov sa pýta až keď používateľ synchronizáciu zapne (`include_granted_scopes`), prihlásenie konta Gmail ostáva bez neho. Chýbajúce oprávnenie (401/403) → tlačidlo „Povoliť prístup ku kontaktom“ → opätovné prihlásenie toho istého konta.
- **Pravidlá:** synchronizuje sa s jedným kontom Google prihláseným cez Google. Pri zapnutí sa kontakty prepoja podľa e-mailu (prázdne polia sa doplnia), kontakty z Google s e-mailom sa stiahnu, kontakty z Doaru, ktoré v Google nie sú, sa nahrajú (používateľ to potvrdí s počtom). Kontakty bez e-mailu (len telefón, adresa – typické v mobile) sa synchronizujú tiež; párujú sa podľa mena a telefónu (migrácia 016: e-mail nepovinný, jedinečný len keď je vyplnený; pri písaní správy sa ponúkajú len kontakty s e-mailom). Overené naostro: Google účet používateľa (31 kontaktov) – prihlásenie s rozsahom kontaktov, načítanie zoznamu. Prepojený kontakt si pamätá pôvodný vCard – pri odoslaní sa prepíšu len polia zmenené v Doare (fotky, narodeniny, ďalšie čísla a adresy na serveri ostanú). Súbežná zmena v Doare aj v mobile: trojcestné zlúčenie – polia zmenené v Doare ostanú, ostatné sa prevezmú zo servera. Zmazanie v Doare sa zmaže aj na serveri; zmazané v mobile sa zmaže v Doare (ak ho medzitým v Doare nezmenili – vtedy sa nahrá znova). Synchronizácia beží na pozadí každých 15 minút, 5 s po zmene v adresári a na tlačidlo „Synchronizovať“.
- Migrácia 015 (prepojenie kontaktu so serverom, stav synchronizácie, zmazané čakajúce na odoslanie).
- Overené: unit testy proti testovaciemu serveru CardDAV napodobňujúcemu Google (`test/fixtures/carddav-server.ts`: .well-known, PROPFIND, sync-collection, multiget, ETagy, 412, 403). **Neoverené naostro s Google** – overí používateľ.

- **Vydanie `v0.8.0` (2026-10-27):** synchronizácia adresára s Google kontaktmi (overil používateľ naostro oboma smermi), kontakty bez e-mailu, registrácia Microsoft (client ID v aplikácii; IMAP/SMTP pri novom testovacom konte Outlook.com blokuje Microsoft – pozri vyššie). Overené: unit 172, integračné 121, e2e 23.

## 2026-10-27 – správy, pravidlá, šablóny, odoslať neskôr (0.9, prvá časť)

Používateľ si vybral sadu funkcií naraz („nebudeme robiť verziu zakaždým, spravme toho viac“).

- **Odhlásiť z odberu** (hlavička `List-Unsubscribe`, RFC 2369/8058): odkaz pri odosielateľovi a v ponuke „⋯“, vždy s potvrdením (text podľa spôsobu). Poradie: jeden klik (POST `List-Unsubscribe=One-Click` len na `https`, bez otvárania stránky, 20 s) → e‑mail na `mailto:` z konta, na ktoré správa prišla (adresa sa nezapamätá do našepkávania ani adresára) → stránka v prehliadači (`http`/`https`). Pri správach z archívu sa neponúka. `core/unsubscribe.ts`.
- **Označiť všetko ako prečítané:** pravý klik na priečinok aj na „Všetka doručená pošta“; len neprečítané správy, cez tú istú frontu príznakov ako ručné označenie.
- **Správa v samostatnom okne:** dvojklik alebo Enter v zozname (koncept ďalej otvára okno na písanie). To isté okno pre tú istú správu. Okno používa ten istý `Reader` ako hlavné okno (`MessageApp.svelte`, `?view=message&id=`); otvorenie označí správu ako prečítanú, presun/zmazanie okno zavrie, Escape ho zavrie.
- **Uložiť ako PDF / .eml:** PDF z rovnakého dokumentu ako tlač (skryté okno bez skriptov → `printToPDF`, A4, cez `.part`). `.eml` = nezmenený originál (`messages.saveEml`, cesta len z dialógu). **Otvoriť .eml:** ponuka ☰ alebo pretiahnutie súboru do okna (pretiahnutý `.mbox` sa otvorí ako archív). Súbor sa načíta len do pamäte jadra (`ArchiveManager.openEml`, ID od `EML_ID_BASE` = −1 500 000 000, teda „archívne“ ID) – čítanie, prílohy, tlač, odpoveď aj preposlanie fungujú rovnako ako pri archíve; nič sa neukladá do databázy.
- **Pravidlá pre novú poštu** (Nastavenia → Pravidlá, alebo „Vytvoriť pravidlo pre tohto odosielateľa…“ zo správy): ak odosielateľ / adresát (Komu, Kópia) / predmet / hocičo z toho obsahuje text (bez ohľadu na veľké písmená a diakritiku) → presunúť do priečinka, označiť ako prečítané, hviezdička, archivovať, do Koša. Konto voliteľné (presun do priečinka platí pre konto priečinka). Poradie sa dá meniť; prvý presun ukončí ďalšie pravidlá. Bežia v Doare (nie na serveri) na nové správy v doručenej pošte – nie pri prvom načítaní konta; presunuté a prečítané sa neoznamujú. Na staršiu poštu: „Použiť teraz“ alebo pravý klik na priečinok. Presuny idú cez rovnakú frontu ako ručný presun (čas na „Vrátiť späť“). `core/rules.ts`.
- **Šablóny** (okno správy → Šablóny): uloží sa predmet a vlastný text (bez podpisu a citácie), formátovaný text sa prečistí ako koncept. Vloženie: predmet len do prázdneho poľa, text nahradí prázdnu správu, inak sa vloží na miesto kurzora (Ctrl+Z ho vráti). Rovnaký názov = prepísanie (s otázkou). `core/templates.ts`, `TemplatesPanel.svelte`.
- **Odoslať neskôr** (🕓 vedľa Odoslať): čas v budúcnosti (najviac o rok), rýchle voľby zajtra a v pondelok o 8:00. Správa sa zloží hneď (dátum v hlavičke = naplánovaný čas) a čaká vo fronte (`outbox.send_at`); jadro si nastaví časovač, po spustení Doaru sa zmeškané odošlú hneď. Medzi čakajúce zmeny sa nepočíta. V hlavnom okne pruh „sa odošle …“ s „Odoslať hneď“ a „Zrušiť odoslanie“ – zrušená správa sa vráti medzi koncepty (adresáti vrátane skrytej kópie, text, prílohy).
- Migrácia 017 (`rules`, `templates`, `outbox.send_at`).
- Escape zavrie Nastavenia aj keď fokus nie je v okne (napr. tlačidlo sa počas práce vyplo).
- Overené: unit 191, integračné 128 (nové proti testovaciemu serveru: pravidlá s presunom na serveri a bez oznámenia, použitie na priečinok, označiť všetko na serveri, naplánované odoslanie, odoslanie po čase, zrušenie späť do konceptov s prílohou), e2e 25 (nové: odhlásenie e‑mailom, okno správy, PDF, .eml, otvorenie .eml, pravidlo zo správy, šablóna, odoslať neskôr a zrušenie). **Neoverené naostro:** odhlásenie jedným klikom u skutočného odosielateľa, PDF a okná vo Windows.

## 2026-10-28 – konverzácie, hľadanie, náhľad príloh, podpisy, skupiny (0.9, druhá časť)

- **Konverzácie** (☰ → Zoskupiť do konverzácií, alebo Nastavenia → Všeobecné; predvolene vypnuté): správy sa spájajú podľa In-Reply-To a References (aj keď odpoveď príde skôr než pôvodná správa, aj cez priečinky – vlastné odpovede v Odoslaných); náhradne podľa predmetu bez „Re:/Odp:/AW:…“, len keď je správa zjavne odpoveď a pôvodná je do 60 dní. Kontá sa nemiešajú. V zozname jeden riadok = najnovšia správa konverzácie v priečinku, s počtom a menami; neprečítaná, ak je neprečítaná ktorákoľvek. Presun, mazanie a „prečítané“ platia pre celú konverzáciu v priečinku, hviezdička len pre správu. Pri čítaní pruh „Konverzácia (n)“ so všetkými správami (aj z iných priečinkov okrem Koša a Spamu, kópie tej istej správy len raz); klik zobrazí danú správu. Pri hľadaní a v archíve sa nezoskupuje. Stará pošta sa doplní na pozadí po spustení (`backfillThreads`). Migrácia 018 (`thread_subject`, indexy). `mail/thread.ts`.
- **Rozšírené hľadanie** (ikona filtra v poli hľadania): od, komu, predmet, dátum od–do (vrátane), s prílohou, neprečítané, s hviezdičkou. To isté priamo v texte: `má:prílohu` / `has:attachment`, `je:neprečítané` / `is:unread`, `je:označené` / `is:flagged`, `po:1.10.2026` / `after:2026-10-01`, `pred:` / `before:`. Filter funguje aj bez textu. Príloha sa pozná až po stiahnutí správy (ako doteraz pri texte – Doar to hlási).
- **Náhľad príloh:** klik na obrázok (PNG, JPEG, GIF, WebP, BMP – nie SVG), PDF alebo text (.txt, .csv, .log) otvorí náhľad; ostatné prílohy majú ďalej ponuku (pravý klik aj pri náhľadových). Obrázok a text v okne nad Doarom (text v UTF-8 alebo Windows-1250), PDF v samostatnom okne vstavaným prehliadačom PDF z dočasnej kópie (bez Node.js, bez siete; len skutočné PDF s hlavičkou `%PDF-`). V `session.webRequest` povolená len vnútorná prípona prehliadača PDF (`chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/`).
- **Podpisy:** viac na konto, formátované (editor ako pri písaní), s logom (PNG/JPG/GIF/WebP do 500 kB, vložené ako data:, široké zmenšené na 240 px). Jeden predvolený (alebo žiadny). V okne správy výber podpisu – vymení sa v texte; pri zmene odosielateľa sa vymení len neupravený podpis. Pri odoslaní (aj pri nahratí konceptu) sa vložené obrázky prerobia na prílohy s Content-ID (multipart/related) – Gmail a Outlook obrázky data: nezobrazujú. Doterajší textový podpis prenesie migrácia 018 ako predvolený. Prečistenie HTML povoľuje `img` len s data: obrázkom (žiadne odkazy na internet).
- **Skupiny v adresári** (len v Doare, do Google sa nesynchronizujú): vytvorenie, premenovanie, odstránenie (kontakty ostanú), zaradenie v karte kontaktu, filter v zozname, „Napísať skupine“ (všetky adresy do Komu). Pri písaní napísanie začiatku názvu skupiny ponúkne celú skupinu. Migrácia 018 (`contact_groups`, `contact_group_members`).
- **Poradie kont:** potiahnutie názvu konta v paneli priečinkov na iné konto, alebo pravý klik → Posunúť konto vyššie/nižšie. Platí aj pre výber odosielateľa. Ukladá sa do `accounts.sort_order` (bez migrácie), `accounts.reorder` prijme len úplný zoznam kont.
- Overené: unit 210, integračné 129, e2e 28 (nové e2e: poradie kont ponukou aj ťahaním, konverzácie zapnúť/prepnúť správu/vypnúť, filter s prílohou a text `od:… je:neprecitane`, náhľad obrázka, textu a PDF, dva podpisy s logom a ich výmena, logo u príjemcu ako Content-ID, skupina a napísanie skupine, našepkanie skupiny). **Neoverené naostro:** PDF náhľad a logo v podpise vo Windows a u príjemcu v Gmaile/Outlooku.
- **Vydanie `v0.9.0` (2026-10-28):** prvá aj druhá časť 0.9 spolu s opravami z 0.8 (hlásenie pri databáze z novšej verzie, ikona na ploche pri novej verzii v inom priečinku a tlačidlo „Vytvoriť ikonu“, kontrola povolení Google, jedno prihlásenie pre poštu aj kontakty).

## 2026-10-29 – oprava náhľadu PDF, farba písma (0.9.1)

- **Náhľad PDF bol prázdny** (0.9.0): pravidlo, ktoré bráni rozhraniu ísť na internet, blokovalo aj vnútorné súbory vstavaného prehliadača PDF (`chrome://resources/…`). Povolené len `chrome://resources/` (súčasť Electronu, nie sieť). E2e test teraz overuje, že sa prehliadač PDF naozaj načítal (predtým len, že sa okno otvorilo).
- **Farba písma a pozadia** v editore (správa aj podpis): dve tlačidlá „A“ (písmo, zvýraznenie) s paletou 10 farieb (červená, oranžová, žltá, zelená, modrá, ružová, fialová, hnedá, čierna, biela – výrazné, podľa používateľa) a „Bez farby“. Vlastné značky TipTap (bez novej knižnice). Jadro pred odoslaním ponechá na `span` len `color` a `background-color` v tvare #rrggbb (prehliadač zapisuje `rgb(…)` – prevedie sa). V tmavej téme sa čierny text v editore ukáže svetlý, odošle sa čierny.
- **Pozadie celej správy** (okno správy, tlačidlo so štvorčekom): 10 svetlých odtieňov a 10 výrazných farieb. V HTML z editora obal `<div data-doar-bg="#rrggbb">`, pri odoslaní farba na `<body>` aj na hlavnom bloku (Gmail štýl `<body>` zahodí), text tmavý. Atribút ostáva v odoslanej podobe, takže koncept zo servera si pozadie zachová. Obal inde než na začiatku (napr. v citácii) sa ignoruje.
- Adresár: kompaktnejšia karta kontaktu, tlačidlá karty vždy viditeľné dole, menšie tlačidlá v lištách.
- Overené: unit 212, e2e 28 (nové: prehliadač PDF sa naozaj načíta, farba písma, zvýraznenia a pozadia správy až u príjemcu). Používateľ overil náhľad PDF vo Windows (dev).
- **Vydanie `v0.9.1` (2026-10-29).**

## 2026-10-29 – Microsoft Graph pre Outlook.com a Microsoft 365 (1.0, prvá časť)

- **Prečo:** Microsoft novým kontám Outlook.com vypína IMAP („User is authenticated but not connected“) aj SMTP („SmtpClientAuthentication is disabled“) a používateľ to zmeniť nemôže. Graph funguje pre Outlook.com, Hotmail aj Microsoft 365.
- **Kontá s prihlásením cez Microsoft ide pošta len cez Graph** (`accounts.protocol = 'graph'`, migrácia 019). Rozsahy prihlásenia: `Mail.ReadWrite`, `Mail.Send`, `offline_access`, `openid`, `email` – v Azure netreba nič meniť (súhlas sa pýta pri prihlásení). Doterajšie kontá Microsoft (IMAP s tokenom) migrácia prepne na Graph, ich priečinky z IMAP zahodí (načítajú sa znova) – treba sa raz prihlásiť znova (iné oprávnenia).
- **Zachované princípy:** originál správy (.eml) sa sťahuje celý (`/$value`), zmeny cez frontu operácií s „Vrátiť späť“, odoslanie len po potvrdení servera (202), nejasný výsledok sa automaticky neopakuje.
- **Zatiaľ nie pre kontá cez Graph:** export a záloha mbox, import a obnova do konta (idú cez IMAP) – chyba `GRAPH_UNSUPPORTED` s vysvetlením. Správa s prílohami nad ~3 MB (`GRAPH_TOO_LARGE`; väčšie by potrebovali nahrávanie príloh po častiach). Upozornenie na novú poštu do minúty (nie hneď).
- **Testy:** falošný server Graph (`test/fixtures/graph-server.ts`) – unit testy synchronizácie (priečinky, stránkovaná delta, neplatný delta odkaz, príznaky, presun s rovnakým ID, natrvalo, odoslanie aj so skrytou kópiou, nedostupný server, koncepty, priečinky, migrácia), e2e sprievodca → pošta → odoslanie → nastavenia konta. Integračný test prihlásenia s IMAP/SMTP tokenom teraz používa Google. **Overené naostro (2026-10-29, testovacie konto Outlook.com, s ktorým IMAP nefungoval):** prihlásenie a súhlas (Microsoft ukazuje „unverified“ – vydavateľ ešte nie je overený), načítanie priečinkov a správ, odoslanie do Gmailu (prvá správa z nového konta skončila v Spame), kópia v Odoslaných, hviezdička, neprečítané, presun do Archívu – zmeny viditeľné na outlook.com.

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
| @tiptap/core, @tiptap/starter-kit, @tiptap/pm | 3.31.4 (pevná verzia) | MIT | editor formátovaného textu (0.2f); závislosti ProseMirror, linkifyjs a pod. – MIT (overené 2026-10-22) |
| sanitize-html | 2.18.1 | MIT | sanitizácia HTML pošty |
| pst-extractor | 1.12.0 (pevná verzia) | MIT | čítanie súborov Outlooku .pst/.ost (import, 0.7); ukážkové súbory balíka (~46 MB) sa do aplikácie nebalia |
| long, uuid-parse | 5.3.2, 1.1.0 | Apache-2.0, MIT | závislosti pst-extractor (overené 2026-10-26) |
| dompurify | 3.4.17 | MPL-2.0 OR Apache-2.0 | záložná sanitizácia (použijeme pod Apache-2.0) |
| iconv-lite, libmime | – | MIT | kódovania |
| vite, electron-vite, @sveltejs/vite-plugin-svelte | – | MIT | zostavenie |
| electron-builder | 26.15.3 (pevná verzia) | MIT | inštalátor pre Windows (len vývoj) |
| vitest | 5.0.5 | MIT | unit testy (len vývoj) |
| @playwright/test | 1.64.1 | Apache-2.0 | testy UI (len vývoj) |
| smtp-server | 3.20.2 | MIT-0 | testovací SMTP server (len vývoj) |
| Dovecot (systémový balík) | 2.3 | MIT + LGPL-2.1 | testovací IMAP server (len vývoj, nedistribuuje sa) |

Pred pridaním ďalšej knižnice over licenciu a doplň ju sem.
