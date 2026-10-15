# trav-ranker

Rankar varje start i varje travlopp i ATG:s spel, både med sulky och monté, med ett viktat poängsystem (0–100).

```bash
npm install
npm test
npm run rank -- --date 2026-10-10 --game V75          # tabell i terminalen
npm run rank -- --date 2026-10-10 --game V75 --json   # JSON för UI/DB
npm run rank -- --game V86 --no-market                # utan odds/streck i modellen
npm run rank -- --game V85 --no-monte                 # bara lopp med sulky
```

## Flöde

```
calendar/day/:date ──► games/:gameId ──► races[] (sport = trot/monté, dedup per raceId)
                                             │
                     races/:raceId/start/:nr ┤  (max 4 parallellt, cachas)
                                             ▼
Travsport topplistor (kusk/tränare) ──► atgMapper ──► Runner (domänmodell)
                                                        ▼
                                              scoring/engine ──► RankedRace
```

## Struktur

| Fil | Ansvar |
| --- | --- |
| `src/clients/http.ts` | fetch med timeout, retry/backoff, TTL-cache, dedupe, `mapLimit` |
| `src/clients/atg.ts` | de tre ATG-endpointsen |
| `src/clients/travsport.ts` | topplistor, alla query-parametrar typade, tolerant parser, namnmatchning |
| `src/mappers/atgMapper.ts` | rå ATG-JSON → domänmodell (enda stället som känner till API-formen) |
| `src/scoring/config.ts` | vikter och alla heuristiker – kalibreras här |
| `src/scoring/factors.ts` | de tio faktorerna |
| `src/scoring/engine.ts` | normalisering, viktning, rank, sannolikhet, värde |
| `src/pipeline.ts` | orkestrerar dag → spel → lopp → rankning |

## Poängmodellen

Varje faktor ger ett råvärde, normaliseras till 0–100 inom loppet (min–max, eller fast skala
för spår/utrustning/vila), saknad data = 50. Totalpoäng = Σ vikt × faktorpoäng.

| Faktor | Vikt | Underlag |
| --- | --- | --- |
| Form | 20 % | Placeringspoäng 10/7/5/3/2/1 senaste 5, viktat på färskhet, avdrag galopp/disk |
| Fart | 18 % | Bästa km-tid senaste 5 (+ rekord), standardiserad till auto/2140 m |
| Klass | 12 % | Intjänat per start (år + livs), log-dämpat |
| Segerprocent | 10 % | Seger- och topp-3-andel med bayesiansk krympning |
| Kusk | 12 % | Årets statistik + bonus för placering på Travsports topplista |
| Tränare | 7 % | Samma som kusk |
| Spår/distans | 10 % | Spårtabell per startmetod, avdrag per 20 m tillägg |
| Utrustning | 4 % | Barfota, barfota första gången, byte till amerikansk vagn |
| Vila | 2 % | Dagar sedan senaste start |
| Marknad | 5 % | Streckprocent/odds (stäng av med `--no-market`) |

### Monté

Montélopp rankas med samma faktorer. Skillnaderna:

- Hästens tidigare starter i både trav och monté räknas. Starter i den andra disciplinen väger 70 % i formen (`form.crossSportWeight`).
- Km-tider från montélopp räknas om till sulky med `speed.monteSecPerKm` (0,6 s/km, medianen för samma hästar i ATG-cachen).
- "Kusk" är ryttaren. Ryttarbonusen tas från `data/travsport-drivers-monte-ÅÅÅÅ.json` (eller `travsport-drivers-ÅÅÅÅ-monté.json`) om filen finns, annars från den allmänna kusklistan.
- Ingen vagn: bonusen för byte till amerikansk vagn gäller inte. Skorna räknas som vanligt.
- Anteckningen "Montédebut" visas för hästar utan tidigare montéstarter.
- Backtesten visar träffsäkerheten per sport.

Utöver poängen: `confidence` (andel vikt med riktig data), `winProbability` (softmax),
`marketProbability` och `value` = modell / marknad.

## Att verifiera mot riktiga svar

1. ATG `races/:raceId/start/` – antaget att startnummer läggs till sist, och att resultat ligger i `horse.results.collection`.
2. ATG-odds och streckprocent antas vara i hundradelar (450 = 4.50, 1534 = 15.34 %).
3. Travsport: vilken `category`/`chartTypeSearchParam` som ger kuskar resp. tränare (`CHART_PRESETS`), och svarets fältnamn.
4. Om ATG:s person-id är samma som Travsports (då matchar vi på id, annars på namn).

ATG:s API är inofficiellt – håll nere anropstakten och kolla villkoren innan något publiceras.
