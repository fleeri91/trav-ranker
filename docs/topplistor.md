# Uppdatera topplistor från Svensk Travsport

Appen ger kuskar och tränare en liten bonus utifrån deras placering på Svensk Travsports topplistor. Listorna sparas som JSON-filer i `data/` och uppdateras för hand från webbläsaren. Det tar ett par minuter.

Travsports API är skyddat mot automatiska anrop, så hämta alltid listorna i en vanlig webbläsare och inte med script.

## Senaste 12 månaderna

Appen räknar inte bara på innevarande år. Årets lista och förra årets lista vägs ihop till ungefär "senaste 12 månaderna": årets siffror räknas fullt och förra årets med den del av året som ännu inte har gått. Samma sak gäller kusk-, tränar- och hässtatistiken från ATG.

| Datum       | Förra året väger |
| ----------- | ---------------- |
| 10 januari  | 97 %             |
| 1 april     | 75 %             |
| 1 juli      | 50 %             |
| 1 oktober   | 25 %             |
| 20 december | 3 %              |

I januari, när årets listor nästan är tomma, bygger bonusen alltså i stort sett på förra säsongen och går sedan gradvis över till innevarande år.

## När ska jag uppdatera?

Årets listor ändras långsamt, så en gång i veckan räcker. Ett bra tillfälle är innan du rankar en V85-omgång. `npm run check:charts` varnar när årets fil är äldre än 14 dagar.

Förra årets listor ändras inte när året är slut. Dem sparar du en gång.

## Filerna

Det finns fem listor per år: kuskar och tränare, var för sig för alla lopp och för STL-lopp, plus en ryttarlista för montélopp. STL-listorna används för loppen i V85, montélistan för ryttarna i montélopp och de allmänna listorna för allt annat. Tränare i montélopp tas från den allmänna listan eller STL-listan, eftersom det inte finns någon egen tränarlista för monté. Filnamnen innehåller året:

| Fil                                     | Innehåll           |
| --------------------------------------- | ------------------ |
| `data/travsport-drivers-ÅÅÅÅ.json`      | Kuskar, alla lopp  |
| `data/travsport-trainers-ÅÅÅÅ.json`     | Tränare, alla lopp |
| `data/travsport-drivers-stl-ÅÅÅÅ.json`  | Kuskar, STL-lopp   |
| `data/travsport-trainers-stl-ÅÅÅÅ.json` | Tränare, STL-lopp  |
| `data/travsport-drivers-monte-ÅÅÅÅ.json` | Ryttare, montélopp (`sulkyOrMonte=M`) |

Appen använder årets och förra årets filer, alltså upp till tio stycken, till exempel `travsport-drivers-2026.json` och `travsport-drivers-2025.json`.

Du behöver inte skriva adresserna själv. `npm run check:charts` skriver ut adressen för varje fil som saknas.

Du behöver inte heller ha alla filer. Saknas förra årets fil används bara årets. Saknas en STL- eller montélista används den allmänna. Saknas båda åren räknar appen fram en egen lista från ATG:s statistik för dagens startfält.

## Steg för steg

### 1. Se vilka filer som saknas

```bash
npm run check:charts
```

För varje fil som saknas visas filnamnet och adressen att öppna.

### 2. Öppna listan i webbläsaren

Öppna adressen. Visas sidan "Verifying..." först, vänta några sekunder tills JSON-datan visas.

### 3. Spara som JSON

- **Firefox:** välj fliken **Raw Data** (rådata) och tryck sedan **Ctrl+S**. Spara inte från den formaterade vyn.
- **Chrome och Edge:** tryck **Ctrl+S** direkt.

Spara i projektets `data/`-mapp med exakt filnamnet som `check:charts` visade, till exempel `travsport-drivers-stl-2026.json`. Skriv över den gamla filen om den finns. Kontrollera att filen slutar på `.json` och inte `.json.txt` eller `.html`.

Upprepa för de andra listorna.

### 4. Kontrollera filerna

Kör `npm run check:charts` igen. För varje fil visas antal poster och de tre första namnen. Det här ska stämma:

- Kusklistorna börjar med kuskar och tränarlistorna med tränare.
- STL-listorna och montélistan har en annan topp än de allmänna listorna.
- Årets och förra årets listor skiljer sig åt.
- Inga varningar (⚠).

### 5. Ranka

```bash
npm run rank -- --game V85
# eller
npm run dashboard
```

Loggen visar först hur åren vägs, sedan vilka filer som användes och hur många av dagens kuskar och tränare som hittades. Siffrorna nedan är bara ett exempel:

```
Säsong: 2026 + 25 % av 2025
Topplista kuskar: 118 st från travsport-drivers-2026.json + travsport-drivers-2025.json
Topplista kuskar: 31 av 64 i dagens fält finns på listan
Topplista kuskar (STL): 52 av 64 i dagens fält finns på listan
```

Listorna innehåller de 100 bästa per år, så alla kommer inte med. Står det 0 eller bara ett fåtal matchar namnen inte, och då behöver namnmatchningen ses över.

## Vid årsskiftet

Ingenting behöver ändras i koden. Det nya året plockas upp automatiskt, och förra årets filer får full vikt i början av året. Gör så här i januari:

1. Spara det gamla årets fyra listor en sista gång, så att de innehåller hela säsongen. Har du redan sparat dem i slutet av december räcker det.
2. Kör `npm run check:charts` och spara det nya årets listor. De är nästan tomma de första veckorna, men det gör inget.

Listor som är två år gamla används inte längre och kan raderas.

## Parametrarna

Vill du ändra urvalet kan du redigera adressen. Ordningen spelar ingen roll.

| Parameter               | Värden                         | Betydelse                                                    |
| ----------------------- | ------------------------------ | ------------------------------------------------------------ |
| `chartTypeSearchParam`  | `1`, `2`                       | 1 = kuskar, 2 = tränare                                      |
| `typeOfRace`            | `B`, `R`                       | B = alla lopp, R = STL                                       |
| `year`                  | t.ex. `2026`                   | Säsong                                                       |
| `returnNumberOfEntries` | `10`, `30`, `50`, `100`, `200` | Antal personer i listan                                      |
| `breed`                 | `B`, `V`, `K`                  | Båda raserna, varmblod, kallblod                             |
| `gender`                | `B`, `M`, `K`                  | Båda, män, kvinnor                                           |
| `licenseType`           | `S`, `A`, `B`, `K`             | Alla licenser, A-, B- eller K-licens                         |
| `homeTrack`             | `A`, `S`, bane-id              | Hemmabana: alla banor, alla svenska banor eller en viss bana |
| `raceOnTrack`           | `A`, `S`, bane-id              | Bana där loppen körts, samma värden som ovan                 |
| `sulkyOrMonte`          | `B`, `S`, `M`                  | Båda, sulky, monté                                           |
| `category`              | `1`                            | Ska alltid vara 1                                            |
| `list`, `onlyYouth`     | `S`, `false`                   | Ändra inte                                                   |

Vill du hitta en lista som inte finns här kan du öppna topplistorna på [sportapp.travsport.se](https://sportapp.travsport.se), trycka **F12** och välja fliken **Network**. Välj sedan listan på sidan. Anropet `listpersonchart` innehåller adressen med rätt parametrar.

## Felsökning

| Meddelande från `check:charts`              | Orsak                                                                                              | Åtgärd                                                                |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `saknas`                                    | Filen finns inte, eller har fel namn                                                               | Spara med exakt filnamn i `data/`                                     |
| `… används som årets lista. Byt gärna namn` | En fil har det gamla namnet utan år                                                                | Kör `mv`-kommandot som visas                                          |
| `fel: Unexpected token '<'`                 | En HTML-sida sparades i stället för JSON, till exempel verifieringssidan eller den formaterade vyn | Vänta tills JSON-datan visas och spara från Raw Data-fliken (Firefox) |
| `innehåller inga poster`                    | Filen är JSON men inte en topplista, till exempel ett felmeddelande                                | Öppna adressen igen och kontrollera att en lista med namn visas       |
| `Tränarlistan … är identisk med kusklistan` | Kusklistan sparades två gånger                                                                     | Spara tränarlistan från adressen med `chartTypeSearchParam=2`         |
| `STL-listan är identisk med den allmänna`   | STL-listan sparades från fel adress                                                                | Spara från adressen med `typeOfRace=R`                                |
| `montélistan är identisk med den allmänna`  | Montélistan sparades från fel adress                                                               | Spara från adressen med `sulkyOrMonte=M`                              |
| `… och … är identiska – kontrollera year=`  | Samma års lista sparades under båda årens namn                                                     | Spara förra årets lista från adressen med förra årets `year=`         |
| `… dagar gammal`                            | Årets fil har inte uppdaterats på länge                                                            | Hämta listan igen                                                     |

## Köra utan Travsport

Vill du inte hålla listorna uppdaterade alls kan du ranka med topplistor som räknas fram från ATG:s statistik. Den är alltid aktuell och vägs också över de senaste 12 månaderna, men saknar uppdelningen på STL:

```bash
npm run rank -- --game V85 --charts atg
```
