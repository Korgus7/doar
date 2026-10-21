# Návrh obrazoviek Doar

Základný drôtený model. Vizuálne detaily sa doladia po sprevádzkovaní hlavných funkcií.

Zásady: málo tlačidiel, veľa vzduchu, systémové písmo (Segoe UI Variable / SF / Cantarell), jedna zvýrazňovacia farba, každé konto má vlastnú farebnú bodku.

## 1. Hlavné okno (tri panely)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ✉ Nová správa   ⟳                         🔍 Hľadať v pošte…           ⚙     │
├────────────────────┬──────────────────────────────┬──────────────────────────┤
│ Všetka doručená 12 │▌• Ján Novák        14:36 ★  │ Faktúra za október        │
│ Na odoslanie     1 │▌  Faktúra za október    📎  │ Ján Novák <jan@firma.sk>  │
│                    │▌  firma · Dobrý deň, v pr…  │ Komu: ja · 21. 10. 14:36  │
│ ▌jan@firma.sk      │                              │ ↩ Odpovedať ↩↩ Všetkým → │
│   Doručená pošta 8 │▍  Eva K.           Včera    │──────────────────────────│
│   Odoslané         │▍  Re: Stretnutie            │ ┌──────────────────────┐ │
│   Koncepty       1 │▍  osobné · Ďakujem, potv…   │ │ Vzdialené obrázky sú │ │
│   Archív           │                              │ │ blokované. [Zobraziť]│ │
│   Spam             │▌  Newsletter       Po       │ └──────────────────────┘ │
│   Kôš              │▌  Novinky v októbri         │ Dobrý deň,               │
│   ▸ Projekty       │▌  firma · Prinášame…        │ v prílohe posielam…      │
│                    │                              │                          │
│ ▍osobne@mail.sk    │                              │ 📎 faktura.pdf 120 kB ⤓  │
│   Doručená pošta 4 │                              │                          │
├────────────────────┴──────────────────────────────┴──────────────────────────┤
│ ● Synchronizované 14:37 · jan@firma.sk: sťahujem 1 240 / 3 100 správ         │
└──────────────────────────────────────────────────────────────────────────────┘
```

- **Konto správy** je v spoločnom zozname viditeľné dvakrát: farebný pruh vľavo (▌ ▍ = farba konta) a krátky názov konta pred úryvkom textu („firma“, „osobné“). Farba nie je jediný nosič informácie (kvôli farbosleposti).
- **Neprečítaná správa** = tučný odosielateľ a predmet + bodka •. Je to iný znak ako farba konta, takže sa nepletú.
- Hlavné tlačidlá sú len tri: *Nová správa*, *Synchronizovať*, *Nastavenia*. Ostatné akcie sú v kontextovom menu, v paneli správy a na klávesových skratkách.
- **Na odoslanie** (ako Pošta na odoslanie v Outlook Expresse) sa zobrazí len vtedy, keď nie je prázdna. Ukazuje stavy: čaká, odosiela sa, chyba, nejasný výsledok.
- **Stavový riadok:** stav synchronizácie, režim offline, chyby (kliknuteľné, s vysvetlením), upozornenie „schránka ešte nie je stiahnutá celá – vyhľadávanie nemusí byť úplné“.
- Čakajúca lokálna zmena má jemný ⏳ symbol, zlyhaná ⚠ s možnosťou zopakovať.
- Po presune do Koša alebo archivovaní sa na 8 sekúnd zobrazí lišta **„Presunuté do Koša · Vrátiť späť“**.
- **Úzke okno** (pod ~1000 px): panel čítania sa skryje a správa sa otvorí cez celú pravú časť so šípkou späť.
- Veľkosť okna, šírky panelov a posledný otvorený priečinok sa pamätajú.
- Viditeľný fokus (výrazný obrys) na všetkých ovládacích prvkoch. Kontrast textu aspoň 4,5 : 1 v oboch témach.

### Prvé spustenie

Bez konta sa zobrazí len uvítanie s jedným tlačidlom **Pridať konto** (sprievodca, bod 3) a voľbou jazyka.

### Klávesnica (návrh)

| Skratka | Akcia |
|---------|-------|
| Ctrl+N | nová správa |
| Ctrl+R / Ctrl+Shift+R | odpovedať / odpovedať všetkým |
| Ctrl+F | preposlať (ako v Outlook Expresse, Windows Mail aj Outlooku) |
| Ctrl+E | hľadať |
| Del | do Koša |
| Shift+Del | natrvalo (s potvrdením) |
| E (v zozname) | archivovať |
| Ctrl+Q / Ctrl+U | prečítané / neprečítané |
| Ctrl+P | tlač |
| F5 | synchronizovať |
| F6 | prepínanie medzi panelmi |
| ↑ ↓ / Enter | pohyb v zozname / otvoriť |

## 2. Okno novej správy

```
┌──────────────────────────────────────────────────────────┐
│ Odoslať ➤                                   📎  …        │
├──────────────────────────────────────────────────────────┤
│ Od:    ● jan@firma.sk (Ján Novák)               ▾        │
│ Komu:  eva@…  [eva.kovacova@mail.sk ×]                   │
│ Kópia / Skrytá kópia  (zobrazí sa po kliknutí)           │
│ Predmet: Re: Stretnutie                                  │
├──────────────────────────────────────────────────────────┤
│ Text správy…                                             │
│                                                          │
│ --                                                       │
│ Ján Novák                                                │
│ ──── Dňa 20. 10. 2026 napísala Eva K.: ────              │
│ > Ďakujem, potvrdzujem…                                  │
├──────────────────────────────────────────────────────────┤
│ Koncept uložený 14:40                                    │
└──────────────────────────────────────────────────────────┘
```

- Pole **Od** je vždy viditeľné a prepínateľné. Pri odpovedi sa vopred vyberie konto, na ktoré správa prišla.
- Verzia 0.1 píše čistý text. HTML pôvodnú správu pri odpovedi prevedie na čitateľný citovaný text. Formátovanie pribudne vo verzii 0.2.

## 3. Pridanie konta (sprievodca)

```
Krok 1   Meno ______   E-mail ______   Heslo ______        [Pokračovať]
           → automatické zistenie (známi poskytovatelia, autoconfig, DNS SRV)

Krok 2   Našli sme nastavenia:  IMAP mail.firma.sk:993 SSL/TLS
                                SMTP mail.firma.sk:465 SSL/TLS
         [Upraviť ručne]                                   [Overiť a uložiť]

Ručne    IMAP server / port / zabezpečenie (SSL/TLS, STARTTLS)
         SMTP server / port / zabezpečenie / overenie
         Používateľské meno (ak sa líši od e-mailu)
         ☐ Ukladať kópiu odoslaných do priečinka Odoslané (predvolene podľa poskytovateľa)
```

- Overenie: test prihlásenia IMAP aj SMTP. Pri chybe sa zobrazí zrozumiteľná správa (napr. „nesprávne heslo“, „server nedostupný“, „certifikát nie je platný“).
- Neplatný certifikát sa **neprijme potichu**.

## 3a. Nejasný výsledok odoslania

```
Nie je isté, či sa správa „Re: Stretnutie“ odoslala.
Spojenie so serverom sa prerušilo práve pri odosielaní. V priečinku
Odoslané sme ju nenašli, ale server ju mohol prijať.

   [Neodosielať]   [Odoslať znova]      (predvolené: Neodosielať)
```

## 4. Záloha konta (export)

```
Zálohovať konto jan@firma.sk
  Súbor: D:\Zálohy\Doar-jan@firma.sk-2026-10-21-1440.mbox   [Zmeniť]
  ⚠ Záloha nie je šifrovaná – obsahuje čitateľnú poštu.
  ℹ Prázdne priečinky sa zo zálohy neobnovujú.
                                                         [Začať zálohu]
Priebeh
  1. Zisťujem priečinky a správy ........ hotovo (12 priečinkov, 3 100 správ)
  2. Kontrolujem lokálnu kópiu .......... chýba 640 originálov
  3. Sťahujem chýbajúce ................. ███████░░░ 450 / 640
  4. Zapisujem súbor .................... čaká
                                                              [Zrušiť]
Súhrn
  ✔ Úplná záloha · začiatok 14:40:02 · koniec 14:52:31 · 3 100 správ · 1,8 GB
  Priečinok          očakávané  exportované  nedostupné
  Doručená pošta         1 820        1 820           0
  …
                                     [Otvoriť priečinok]  [Zavrieť]
```

## 5. Nastavenia

Karty: **Všeobecné** (jazyk, téma, spúšťanie, ikona v lište, upozornenia) · **Kontá** (zoznam, upraviť, podpis, priečinky so špeciálnou funkciou, odstrániť konto s vysvetlením, že pošta na serveri ostane) · **Súkromie** (vzdialený obsah, povolení odosielatelia) · **AI** (0.4: poskytovateľ, model, kľúč, test).
