# Zadanie: Doar – jednoduchý e-mailový klient pre desktop

Vytvor od začiatku nový e-mailový klient pre Windows, neskôr aj pre macOS a Linux.

Najprv si prečítaj celé zadanie. Pred prvým kódom stručne zhrň, ako mu rozumieš, navrhni štruktúru projektu a upozorni na rozhodnutia, ktoré treba vyriešiť pred implementáciou (bod 17).

Hneď po založení projektu ulož toto zadanie do repozitára ako `docs/ZADANIE.md` a vytvor `CLAUDE.md` so stručnými pravidlami projektu. Pri ďalšej práci sa k nim vracaj, aby sa pri dlhej práci nestratili.

## 1. Cieľ

Jednoduchá aplikácia, ktorá sa ovláda podobne ako Outlook Express a Windows Mail a zvládne ju bežný človek. Má byť rýchla, prehľadná a mať minimalistický moderný dizajn.

Aplikácia vzniká od nuly na otvorených protokoloch IMAP a SMTP. Nejde o kópiu Outlooku ani o spätné inžinierstvo.

Hlavné priority:

1. Spoľahlivé čítanie a odosielanie pošty.
2. Viac kont a spoločná doručená pošta.
3. Export, záloha a obnova e-mailov.
4. Jednoduché ovládanie.
5. Voliteľné AI funkcie s vlastným API kľúčom.

## 2. Platformy a technológie

Prvá podporovaná platforma je Windows. Kód píš od začiatku multiplatformovo, aby sa dal neskôr zostaviť aj pre macOS a Linux.

Dohodnuté technológie:

- Electron + TypeScript.
- IMAP: `imapflow`.
- SMTP: `nodemailer`.
- Spracovanie správ: `mailparser`.
- Lokálna databáza: SQLite s fulltextovým vyhľadávaním FTS5. Pri natívnych moduloch (napr. `better-sqlite3`) počítaj so zostavením pre každú verziu Electronu a platformu.
- Rozhranie: Svelte alebo React. Výber navrhni a zdôvodni pred implementáciou.
- Testovanie rozhrania: Playwright.
- Zostavenie: GitHub Actions, postupne pre všetky tri platformy.

Pred použitím každej knižnice over jej licenciu a kompatibilitu s licenciou projektu (bod 17).

Rozhranie, prácu s poštou, synchronizáciu, úložisko, export/import a AI oddeľ do samostatných častí.

Dlhé operácie nesmú blokovať rozhranie. Zoznam správ sa musí dať používať aj počas synchronizácie či exportu.

## 3. Vydania po etapách

Rozsah je veľký, preto ho rozdeľ na menšie verzie. Každá verzia musí byť samostatne použiteľná a otestovaná, až potom začni ďalšiu.

- **0.1:** jedno konto, sťahovanie a čítanie pošty, odoslanie novej správy a odpovede, export konta do mbox.
- **0.2:** viac kont, spoločná doručená pošta, koncepty, prílohy, presuny, Kôš a Archív, vyhľadávanie, podpis, upozornenia na novú poštu.
- **0.3:** trvalá offline fronta, stavy odosielania, import do konta, lokálny archív mbox, kontrola duplicít.
- **0.4:** AI funkcie, inštalátor pre Windows, automatické aktualizácie.
- **Ďalej:** macOS a Linux, automatické zálohy, triedenie a vyhľadávanie bežnou rečou.

Podrobnosti v ďalších bodoch opisujú cieľový stav. Kedy sa ktorá časť robí, určuje toto rozdelenie.

## 4. Kontá a prihlasovanie

Podporuj viac e-mailových kont naraz.

Používateľ môže zobraziť:

- spoločnú doručenú poštu zo všetkých kont,
- poštu jedného konta,
- jednotlivé priečinky.

V spoločnom zozname musí byť jasne viditeľné, ku ktorému kontu správa patrí.

Pri pridávaní konta skús nastavenia servera zistiť automaticky (známi poskytovatelia, autoconfig). Vždy ich musí byť možné zadať ručne: IMAP a SMTP server, porty a zabezpečenie. Používaj zabezpečené spojenie a overovanie certifikátov.

Spôsob prihlásenia prispôsob poskytovateľovi:

- heslo alebo heslo aplikácie tam, kde je podporované,
- OAuth pre poskytovateľov, ktorí ho vyžadujú.

**Obmedzenia OAuth, ktoré treba zohľadniť:**

- **Google:** plný prístup k pošte (`https://mail.google.com/`) vyžaduje overenie aplikácie a platený bezpečnostný audit. Bez neho aplikácia beží v testovacom režime a prihlásenie vyprší zhruba po týždni. Pre Gmail preto ako hlavnú cestu odporúčaj heslo aplikácie (vyžaduje dvojstupňové overenie). OAuth pre Google nesľubuj.
- **Microsoft (Outlook.com, Microsoft 365):** heslom sa už prihlásiť nedá, OAuth je nutný. Treba zaregistrovať aplikáciu v Azure a pre bezproblémové prihlásenie aj overiť vydavateľa. Ak bude Microsoft medzi prvými poskytovateľmi, zahrň OAuth už do tej etapy.

Heslá, OAuth tokeny a AI kľúče ukladaj cez bezpečné úložisko operačného systému (Windows Credential Manager, macOS Keychain, Linux Secret Service). Neukladaj ich v otvorenom texte do databázy, konfigurácie ani logov.

Ak bezpečné úložisko nie je dostupné, nepouži bez upozornenia nezašifrovanú náhradu.

## 5. Základné funkcie pošty

Cieľový rozsah pre bežné používanie (rozdelenie podľa verzií v bode 3):

- prijímanie a čítanie správ,
- vytvorenie a odoslanie správy,
- odpoveď, odpoveď všetkým a preposlanie,
- adresáti, kópia a skrytá kópia,
- našepkávanie adries pri písaní z prijatej a odoslanej pošty (bez synchronizácie kontaktov),
- pridávanie a ukladanie príloh,
- automatické ukladanie konceptov,
- prečítané/neprečítané a hviezdičky,
- presúvanie správ medzi priečinkami,
- archivovanie a presun do Koša,
- označenie ako spam / nie je spam,
- vytvorenie priečinka,
- vyhľadávanie podľa odosielateľa, adresáta, predmetu a textu,
- jednoduchý podpis pre každé konto,
- upozornenie na novú poštu (IMAP IDLE, inak pravidelná kontrola),
- beh na pozadí s ikonou v systémovej lište (voliteľné),
- tlač správy.

**Editor správ:** pred implementáciou navrhni, či prvá verzia píše len čistý text, alebo aj jednoduché formátovanie (tučné, kurzíva, odkazy, zoznamy). Odpoveď na HTML správu musí zachovať citovaný obsah čitateľný.

Vyhľadávanie v prvej verzii prebieha nad lokálne stiahnutou poštou. Rozhranie musí upozorniť, ak ešte nie je stiahnutá celá schránka.

Pri odpovedi sa predvolene použije konto, na ktoré správa prišla. Pri novej správe musí byť odosielajúce konto zreteľné a prepínateľné.

Priečinky Odoslané, Koncepty, Kôš, Archív a Spam rozpoznávaj podľa údajov servera (IMAP SPECIAL-USE), nie len podľa ich názvov. Ak server tieto údaje neposkytne, použi známe názvy a umožni používateľovi priradenie zmeniť.

## 6. Synchronizácia a offline režim

Pošta sa medzi zariadeniami synchronizuje cez IMAP. Vlastný cloud sa nebuduje. Po prihlásení na inom zariadení alebo vo webmaile musí byť vidieť prijatú aj odoslanú poštu.

Aplikácia:

- používa IMAP, nie POP3,
- predvolene presúva vymazané správy do Koša,
- natrvalé vymazanie vykoná len na výslovný pokyn s potvrdením,
- ukladá odoslanú poštu na server do priečinka Odoslané,
- synchronizuje koncepty na server,
- nesynchronizuje vlastné nastavenia ani AI kľúč medzi zariadeniami.

**Kópia odoslanej pošty:** niektorí poskytovatelia (napr. Gmail, Microsoft) ukladajú odoslanú správu do Odoslaných sami, iní nie. Spoľahlivo sa to automaticky zistiť nedá. Použi tabuľku známych poskytovateľov a pre ostatné kontá nastavenie „ukladať kópiu odoslaných", aby nevznikali dvojité kópie.

Lokálne zmeny sa ukladajú do trvalej fronty operácií, ktorá prežije reštart aplikácie.

Pri presune, archivovaní alebo zmene príznakov možno výsledok ihneď zobraziť lokálne. Rozhranie však musí vedieť odlíšiť čakajúcu, dokončenú a neúspešnú operáciu.

**Odosielanie** má samostatné stavy: koncept, čaká na odoslanie, odosiela sa, odoslané, chyba, nejasný výsledok.

- Správu označ za odoslanú až po potvrdení SMTP serverom.
- Ak sa spojenie preruší v okamihu, keď už server mohol správu prijať, neposielaj ju automaticky znovu. Skontroluj priečinok Odoslané podľa `Message-ID`. Ak to nerozhodne, opýtaj sa používateľa, či správu odoslať znova.
- Odoslanie a uloženie kópie do Odoslaných sleduj samostatne. Zlyhanie uloženia kópie nesmie spôsobiť nové odoslanie adresátovi.

Bez internetu musí fungovať:

- čítanie stiahnutých správ a príloh,
- lokálne vyhľadávanie,
- písanie konceptov,
- zaradenie správ do fronty na odoslanie,
- zaradenie podporovaných zmien do synchronizačnej fronty.

Chýbajúci obsah jasne označ. Synchronizácia musí spracovať aj zmeny vykonané cez webmail alebo iné zariadenie a rešpektovať identifikátory a stav priečinkov na IMAP serveri (UID, UIDVALIDITY).

## 7. Lokálne úložisko

Okrem údajov potrebných pre rozhranie ukladaj aj originálne správy vrátane MIME obsahu a príloh.

Originály zachovaj bez úprav. Údaje pre vyhľadávanie a zobrazovanie ukladaj oddelene.

Pred implementáciou navrhni, či budú originály v SQLite alebo v samostatných súboroch. Zohľadni veľké schránky, rýchlosť exportu a spoľahlivosť úložiska.

Úvodná synchronizácia môže byť postupná: najprv zoznam správ, následne úplný obsah. Zobraz jej priebeh a stav úplnosti lokálnej kópie.

Odstránenie konta z aplikácie nesmie vymazať poštu zo servera. Používateľovi vysvetli, čo sa odstráni lokálne.

Databázu navrhni s verziovanými migráciami, aby aktualizácie aplikácie nestratili údaje.

## 8. Export a záloha do mbox — jadro projektu

Používateľ musí vedieť exportovať jedno konto do jedného súboru `.mbox` vo variante mboxrd.

Export zahŕňa všetky správy dostupné v IMAP priečinkoch daného konta v čase zálohy: doručené, odoslané, koncepty, Kôš, spam a ďalšie dostupné priečinky vrátane príloh.

Natrvalo odstránené správy, ktoré už server neposkytuje, nemožno zálohovať.

**Gmail a podobné služby so štítkami:** v Gmaile je jedna správa viditeľná vo viacerých priečinkoch naraz (Doručená pošta, Všetka pošta, štítky, Dôležité, S hviezdičkou). Export všetkých priečinkov by tú istú správu uložil viackrát a import by vytvoril duplicity. Pri Gmaile exportuj každú správu len raz (zo Všetkej pošty plus Koš a Spam) a jej štítky zapíš do metadát (Gmail ich poskytuje cez `X-GM-LABELS`). Virtuálne priečinky ako Dôležité a S hviezdičkou neexportuj ako samostatné kópie.

Pred úplným exportom aplikácia:

1. Zistí dostupné priečinky a správy.
2. Overí úplnosť lokálnej kópie.
3. Stiahne chýbajúce originály a prílohy.
4. Vytvorí export a zobrazí výsledný súhrn.

Schránka sa počas zálohy môže meniť. Definuj konzistentný postup výberu správ a do súhrnu uveď čas začiatku a konca zálohy, počty a prípadné nedostupné správy. Neúplný export nesmie byť označený ako úplná úspešná záloha.

Pre obnovu v našej aplikácii zachovaj:

- pôvodný priečinok vrátane hierarchie (pri Gmaile štítky),
- interný dátum prijatia zo servera,
- stav prečítané/neprečítané,
- hviezdičku a ďalšie podporované používateľské príznaky.

Samotný mbox tieto údaje jednotne nedefinuje. Pred implementáciou navrhni a zdokumentuj vlastné verziované metadáta v exportovaných správach s hlavičkami s prefixom `X-Doar-`.

Stav prečítania a hviezdičku zapisuj navyše aj do štandardných hlavičiek `Status:` a `X-Status:`, aby ich videli aj iné programy (napr. Thunderbird).

Vyrieš kódovanie názvov priečinkov, konflikt s už existujúcimi hlavičkami a odstránenie iba vlastných exportných metadát pri obnove. Originály v lokálnom úložisku neupravuj.

Bežné mbox nástroje majú vedieť čítať správy a prílohy. Obnova vlastných metadát je garantovaná len našou aplikáciou.

Prázdne priečinky sa v prvej verzii cez mbox neobnovujú. Túto hranicu jasne uveď v rozhraní a dokumentácii.

Export musí:

- spracúvať veľké súbory priebežne bez načítania celej schránky do pamäte,
- zobrazovať priebeh a umožňovať zrušenie,
- rozlíšiť hotový súbor od rozpracovaného (napr. dočasný názov a premenovanie až po dokončení),
- správne ošetriť pravidlá mboxrd,
- hlásiť nedostatok miesta a chyby zápisu.

Export neobsahuje heslá ani API kľúče. V prvej verzii nie je šifrovaný. Používateľ musí vedieť, že obsahuje čitateľnú poštu.

## 9. Import a lokálny archív

Podporuj dva spôsoby použitia súboru mbox.

**Lokálny archív**

Súbor možno otvoriť bez nahrávania na server. Používateľ môže čítať správy, vyhľadávať a ukladať prílohy aj offline.

Archív sa otvára iba na čítanie a pôvodný súbor sa nemení.

**Import do konta**

Správy sa nahrajú cez IMAP APPEND.

Pred importom používateľ vyberie cieľové konto a jednu z možností:

- obnoviť pôvodné priečinky podľa našich metadát,
- vložiť všetky správy do jedného zvoleného priečinka.

Pri cudzom mbox bez našich metadát použi zvolený cieľový priečinok. Existujúcu poštu neprepisuj ani nemaž.

Zachovaj obsah správ, prílohy, dátumy a podporované príznaky v rozsahu možností servera. Obmedzenia oznám v súhrne.

Navrhni kontrolu duplicít. Nespoliehaj sa iba na `Message-ID` (môže chýbať alebo sa opakovať). Rozlišuj opakovaný import od legitímneho výskytu rovnakej správy vo viacerých priečinkoch.

Import musí zobrazovať priebeh, umožniť zrušenie a bezpečné pokračovanie po prerušení. Pred opakovaním operácie s nejasným výsledkom over, či už bola správa nahraná.

Pri zaplnenej schránke alebo chybe servera zobraz, čo sa podarilo, čo zlyhalo a ako pokračovať.

Automatické zálohy do zvoleného priečinka sú neskoršia funkcia.

PST nepodporujeme pre zložitosť implementácie a nižšiu prioritu.

## 10. AI funkcie

AI je voliteľná. Bez nej musí byť aplikácia plnohodnotným e-mailovým klientom.

Podporované pripojenia:

- Anthropic,
- OpenRouter,
- lokálny model cez OpenAI-kompatibilné API.

Používateľ si zadá vlastný kľúč, poskytovateľa a model. Lokálny server môže fungovať aj bez kľúča.

Prvá verzia AI obsahuje:

- zhrnutie e-mailu,
- návrh odpovede,
- pomoc s písaním a úpravou textu.

Obsah sa posiela AI až na pokyn používateľa. Musí byť jasné, ktorému poskytovateľovi sa odošle a aký rozsah správy alebo konverzácie sa použije. Prílohy sa automaticky neposielajú.

Obsah e-mailov považuj za nedôveryhodné dáta, nie za pokyny pre aplikáciu. AI návrh musí používateľ skontrolovať a sám odoslať. AI nesmie samostatne odosielať, mazať ani presúvať poštu.

Triedenie a vyhľadávanie bežnou rečou patria do neskoršej etapy.

## 11. Bezpečnosť

HTML pošta je nedôveryhodná:

- sanitizuj ju,
- zobrazuj ju v izolovanom prostredí s reštriktívnym CSP,
- zakáž skripty a prístup k privilegovaným funkciám,
- predvolene blokuj vzdialené obrázky a iné vzdialené zdroje (s možnosťou povoliť pre odosielateľa),
- externé odkazy otváraj v systémovom prehliadači až po akcii používateľa,
- prílohy automaticky nespúšťaj.

V Electrone zapni izoláciu kontextu a sandbox, vypni Node.js integráciu v rozhraní a sprístupni len nevyhnutné, kontrolované komunikačné rozhranie.

Do logov nezapisuj heslá, tokeny, API kľúče ani telá správ. Diagnostika má byť použiteľná bez zverejnenia obsahu pošty.

Aplikácia neodosiela žiadnu telemetriu.

## 12. Dizajn a ovládanie

Predvolené rozloženie má tri panely: kontá a priečinky, zoznam správ, čítanie správy.

Požiadavky:

- svetlý a tmavý režim,
- slovenské rozhranie, pripravené na ďalšie jazyky,
- prehľadné písmo a dostatočný kontrast,
- ovládanie klávesnicou a viditeľný fokus,
- málo hlavných tlačidiel,
- doplnkové akcie dostupné aj bez použitia myši,
- zrozumiteľné stavy synchronizácie a chýb,
- zapamätanie veľkosti okna a panelov.

Základný návrh obrazoviek priprav na začiatku. Vizuálne detaily dolaďuj po sprevádzkovaní hlavných funkcií.

## 13. Aktualizácie a vydávanie

- Aplikácia sa vie sama aktualizovať (napr. `electron-updater` z vydaní na GitHube). Aktualizácia sa nainštaluje až so súhlasom používateľa.
- Podpisovanie aplikácie (Windows) a podpis s notarizáciou (macOS) vyrieš pred verejným vydaním. Bez nich zobrazí Windows varovanie SmartScreen a macOS blokovanie spustenia.

## 14. Testovanie a podmienky dokončenia

Používaj testovací IMAP/SMTP server, napríklad GreenMail alebo vhodnú alternatívu, a testovacie kontá.

Over najmä:

- prijímanie, odosielanie, koncepty a prílohy,
- viac kont a správny výber odosielateľa,
- synchronizáciu zmien z iného klienta,
- offline režim a obnovu po reštarte,
- nejasný výsledok odoslania a ochranu pred duplicitami,
- export a import mboxrd,
- Unicode názvy a vnorené priečinky,
- správanie pri Gmaile a štítkoch (duplicity v exporte),
- veľké správy, prílohy a poškodený vstupný súbor,
- prerušenie exportu/importu, nedostatok miesta a zaplnenie konta,
- izoláciu HTML a blokovanie vzdialeného obsahu.

Pre export a obnovu vykonaj test na pripravenej schránke: export, import do prázdneho testovacieho konta a porovnanie počtu správ podľa priečinkov, obsahu, príloh, dátumov a podporovaných príznakov. Rozdiely spôsobené serverom musia byť vysvetlené.

Pred označením poskytovateľa za podporovaného over prihlásenie, príjem, odosielanie a ukladanie odoslanej pošty na jeho testovacom konte.

Nevymýšľaj výsledky testov. Uveď, čo bolo overené, čo zlyhalo a čo ostáva neoverené.

## 15. Poradie práce

1. Vyjasnenie otvorených rozhodnutí (bod 17) a kontrola prostredia.
2. Uloženie zadania do `docs/ZADANIE.md` a vytvorenie `CLAUDE.md`.
3. Návrh architektúry, dátového modelu a základných obrazoviek.
4. Základ projektu a testovací IMAP/SMTP server.
5. Verzia 0.1 (bod 3).
6. Verzia 0.2.
7. Verzia 0.3.
8. Verzia 0.4.
9. Overenie a zostavenie pre macOS a Linux.

Priebežne overuj zostavenie na ostatných platformách, aby nevznikali zbytočné závislosti od Windowsu.

## 16. Inšpirácia a rozsah

Existujúce projekty možno použiť ako inšpiráciu pre ovládanie a architektúru:

- **Skim** (https://github.com/nikserg/skim), licencia MIT. Windows klient v Ruste a Tauri. Dobrý vzor minimalistického dizajnu, AI s vlastným kľúčom a offline fronty. Nemá export ani import a neukladá originálne správy.
- **Mailspring** (https://github.com/Foundry376/Mailspring), licencia GPL-3.0. Electron klient s exportom do mbox. Jeho kód nepreberaj, aby projekt nemusel byť pod GPL.

Údaje o ich funkciách a licenciách pred použitím over. Kód ani iné časti nepreberaj bez kontroly licencie a kompatibility s licenciou nášho projektu.

Do prvej verzie nepatrí kalendár, synchronizácia kontaktov, vlastný cloud, pravidlá automatizácie, podpora PST ani samostatne konajúci AI agent.

## 17. Otvorené rozhodnutia pred začatím

Pred prvým kódom sa ma v jednej stručnej správe opýtaj na:

1. Názov projektu a repozitára. Pracovný návrh je `mailklient`.
2. Či má byť repozitár súkromný. Založ ho až po mojom potvrdení.
3. Licenciu projektu (napr. MIT, iná otvorená licencia, alebo súkromný projekt bez licencie). Ovplyvňuje, ktoré knižnice a ktorý kód smieme použiť.
4. Prvých podporovaných poskytovateľov a typ kont. Najmä Gmail (heslo aplikácie), Microsoft (osobné konto alebo Microsoft 365, vyžaduje OAuth) a slovenskí poskytovatelia alebo vlastný server.
5. Voľbu Svelte alebo React, s tvojím odporúčaním a krátkym zdôvodnením.
6. Editor správ: len čistý text, alebo aj jednoduché formátovanie.

Ako predvolený návrh použi slovenské rozhranie a tri panely. Ostatné bežné implementačné rozhodnutia navrhni sám. Pýtaj sa vtedy, keď menia rozsah, bezpečnosť, kompatibilitu alebo správanie zálohy.

## 18. Prostredie a pravidlá spolupráce

Pracujeme na mojom pracovnom PC s Windows. Najprv over dostupné nástroje, ich verzie a možnosti zostavenia, spustenia a testovania. Dostupnosť nástrojov ani prístup k obrazovke nepredpokladaj.

Pred inštaláciou mi povedz, čo treba doplniť a prečo, a vyžiadaj si súhlas.

Používaj testovací server a testovaciu poštu. K mojej skutočnej pošte pristupuj až po mojom výslovnom povolení.

Odpovedaj po slovensky, stručne a jasne.

Bežné lokálne úpravy a testy v schválenom rozsahu vykonávaj priebežne. Pred založením repozitára, inštaláciou, publikovaním alebo prístupom k skutočnej pošte sa opýtaj.

Commit a push vykonaj iba na moju požiadavku.

Po každej etape stručne zhrň, čo funguje, ako si to overil a čo zostáva.
