/**
 * Backtest: hur väl hade rankingen träffat i avgjorda omgångar?
 *
 *   npm run backtest -- --game V85 --from 2026-08-01
 *   npm run backtest -- --game V85,V86 --from 2026-08-01 --to 2026-09-30
 *   npm run backtest -- --game V85 --from 2026-08-01 --no-market
 *   npm run --silent backtest -- --game V85 --from 2026-08-01 --json > backtest.json
 *   npm run backtest -- --game V85 --from 2026-01-01 --no-market --fit
 *   npm run backtest -- --game V85,V86,V64 --from 2025-09-01 --fit --compare-without driverForm,trainerForm
 *
 * --fit anpassar vikter och temperatur på de tidiga omgångarna och mäter dem på
 * de senaste (--holdout, standard 0.3 = sista 30 % av omgångarna).
 * --results väljer resultatsamling för kusk- och tränarform: "all" (standard,
 * alla svenska lopp) eller en spelform som samlats med npm run collect -- --game.
 * --compare-without anpassar en gång till utan de angivna faktorerna och
 * jämför lopp för lopp: hjälper faktorerna på omgångar anpassningen inte sett?
 *
 * --to är som standard i går. Svaren från ATG sparas i .cache/ i 30 dagar,
 * så en omkörning (t.ex. efter ändrade vikter) går snabbt.
 * --charts är som standard "atg": de sparade Travsport-listorna är dagens och
 * skulle innehålla segrar som kom efter loppen.
 */
import { CHART_SOURCES, type ChartSource } from "../src/clients/charts.ts";
import { runBacktest, type BacktestResult } from "../src/backtest/run.ts";
import { loadResultsHistory } from "../src/pipeline.ts";
import { ALL_RACES, resultsDir } from "../src/results/collect.ts";
import {
  compareWithout,
  fitBacktest,
  type Ablation,
  type FitResult,
  type ModelEval,
} from "../src/backtest/fit.ts";
import type { HitStats } from "../src/backtest/evaluate.ts";
import {
  DEFAULT_CONFIG,
  FACTOR_LABELS,
  withConfig,
  type FactorKey,
} from "../src/scoring/config.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);
const isDate = (s?: string) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
const fail = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};

const today = new Date().toLocaleDateString("sv-SE", {
  timeZone: "Europe/Stockholm",
});
const yesterday = new Date(Date.parse(`${today}T12:00:00Z`) - 86_400_000)
  .toISOString()
  .slice(0, 10);

const from = arg("from");
const to = arg("to") ?? yesterday;
const gameTypes = (arg("game") ?? "V85")
  .split(",")
  .map((s) => s.trim().toUpperCase());
const charts = (arg("charts") ?? "atg") as ChartSource;
const json = flag("json");
const fit = flag("fit");
const holdout = Number(arg("holdout") ?? 0.3);
const resultsScope = arg("results") ?? ALL_RACES;
const without = (arg("compare-without") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean) as FactorKey[];

if (!isDate(from)) fail("Ange startdatum: --from ÅÅÅÅ-MM-DD");
if (!isDate(to)) fail("--to måste vara ÅÅÅÅ-MM-DD");
if (to >= today)
  fail(`--to måste vara före i dag (${today}), dagens lopp är inte avgjorda`);
if ((from as string) > to) fail("--from måste vara före --to");
if (!(holdout > 0 && holdout < 1))
  fail("--holdout måste vara mellan 0 och 1, t.ex. 0.3");
const unknownFactor = without.find((k) => !(k in FACTOR_LABELS));
if (unknownFactor)
  fail(
    `Okänd faktor "${unknownFactor}" i --compare-without. Välj bland: ${Object.keys(FACTOR_LABELS).join(", ")}`,
  );
if (without.length && !fit) fail("--compare-without kräver --fit");
if (!CHART_SOURCES.includes(charts))
  fail(`Okänd --charts "${charts}". Välj: ${CHART_SOURCES.join(", ")}`);

const config = withConfig(flag("no-market") ? { weights: { market: 0 } } : {});

const pct = (x: number) => `${Math.round(x * 100)} %`;
const signedPct = (x: number) =>
  `${x >= 0 ? "+" : "−"}${Math.round(Math.abs(x) * 100)} %`;
const dec = (x: number, d = 2) =>
  x.toLocaleString("sv-SE", {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });
const pad = (s: string, n: number) => s.padEnd(n);
const padL = (s: string, n: number) => s.padStart(n);

const W = { label: 26, top1: 11, top3: 16, rank: 17, data: 8 };

function hitRow(label: string, s: HitStats, extra = "") {
  return `  ${pad(label, W.label)}${padL(pct(s.top1), W.top1)}${padL(pct(s.top3), W.top3)}${padL(dec(s.meanWinnerRank, 1), W.rank)}${extra}`;
}

function print(result: BacktestResult) {
  const r = result.report;
  const period = `${result.from} – ${result.to}`;
  console.log(`\nBacktest ${result.gameTypes.join(", ")}, ${period}`);
  console.log(
    `${result.games.length} omgångar, ${r.races} lopp med resultat` +
      (result.racesWithoutResult
        ? ` (${result.racesWithoutResult} utan resultat)`
        : ""),
  );

  if (!r.races) {
    console.log(
      "\nInga lopp att utvärdera. Finns spelet de här datumen, och är loppen avgjorda?",
    );
    if (result.racesWithoutResult) {
      console.log(
        "Loppen hittades men vinnaren kunde inte avgöras – klistra in ett lopps start-svar så justeras tolkningen.",
      );
    }
    return;
  }

  const head = `  ${pad("", W.label)}${padL("Etta vann", W.top1)}${padL("Vinnare topp 3", W.top3)}${padL("Vinnarens plac.", W.rank)}`;
  console.log("\nVem vinner?");
  console.log(head);
  console.log(hitRow("Modellen", r.model));
  console.log(hitRow("Utan statistikfaktorer", r.clean));
  console.log(hitRow("Favoriten (lägst odds)", r.favorite));
  console.log(hitRow("Slumpen", r.random));
  if (r.bySport.length > 1) {
    console.log("\nPer sport");
    console.log(head);
    for (const s of r.bySport) {
      const name = s.sport === "monte" ? "Monté" : "Trav";
      console.log(hitRow(`${name} (${s.model.races} lopp)`, s.model));
      console.log(hitRow(`${name}, slumpen`, s.random));
    }
  }

  console.log("\nFaktor för faktor (rankning på bara den faktorn)");
  console.log(`${head}${padL("Data", W.data)}`);
  const factors = [...r.factors].sort((a, b) => b.stats.top1 - a.stats.top1);
  for (const f of factors)
    console.log(hitRow(f.label, f.stats, padL(pct(f.coverage), W.data)));

  if (r.logLoss) {
    console.log(
      `\nVinstchanser, log loss för vinnaren (lägre är bättre, ${r.logLoss.races} lopp)`,
    );
    console.log(
      `  Modellen ${dec(r.logLoss.model)}   Utan statistikfaktorer ${dec(r.logLoss.clean)}   Marknaden ${dec(r.logLoss.market)}`,
    );
  }

  console.log("\nKalibrering: modellens vinstchans mot hur ofta hästarna vann");
  console.log(
    `  ${pad("Vinstchans", 12)}${padL("Hästar", 8)}${padL("Väntat", 9)}${padL("Utfall", 9)}`,
  );
  for (const b of r.calibration) {
    if (!b.runners) continue;
    console.log(
      `  ${pad(b.label, 12)}${padL(String(b.runners), 8)}${padL(pct(b.expected), 9)}${padL(pct(b.observed), 9)}`,
    );
  }

  const betLine = (
    label: string,
    b: { bets: number; wins: number; roi: number },
  ) =>
    `  ${pad(label, 26)}${padL(String(b.bets), 5)} spel, ${padL(String(b.wins), 3)} vinster, avkastning ${signedPct(b.roi)}`;
  console.log("\nVinnarspel, 1 kr per spel på slutoddset");
  console.log(betLine("Modellens etta", r.topPickBets));
  console.log(
    betLine(`Spelvärde minst ${dec(r.valueBets.threshold)}`, r.valueBets),
  );

  const { horses, ahead } = result.snapshot;
  if (horses) {
    const share = ahead / horses;
    console.log("\nEfterhandsdata");
    console.log(
      `  ${ahead} av ${horses} hästar (${pct(share)}) har fler starter i spelets årsstatistik än före loppet.`,
    );
    console.log(
      share > 0.2
        ? "  ATG:s statistik i spelen verkar vara dagens, inte tävlingsdagens. Klass, segerprocent, kusk och\n" +
            '  tränare kan då bygga på resultat efter loppet – lita mer på raden "Utan statistikfaktorer".'
        : "  Statistiken verkar vara från tävlingsdagen. Alla faktorer kan jämföras rättvist.",
    );
  }
  if (config.weights.market > 0) {
    console.log(
      "\nObs: modellen använder slutoddsen (faktorn Marknad). Kör med --no-market för att se modellen utan dem.",
    );
  }
}

function printFit(f: FitResult) {
  console.log("\n════════ Anpassning (--fit) ════════");
  console.log(
    `Tränad på ${f.train.rounds} omgångar (${f.train.races} lopp) t.o.m. ${f.train.until}.\n` +
      `Testad på ${f.test.rounds} omgångar (${f.test.races} lopp) från ${f.test.from}, som anpassningen inte har sett.`,
  );
  if (f.test.races < 60)
    console.log("Få testlopp – skillnader på några procentenheter är osäkra.");

  console.log(
    `\n  ${pad("", 16)}${padL("Nuvarande", 11)}${padL("Anpassad", 11)}`,
  );
  for (const k of f.keys) {
    console.log(
      `  ${pad(FACTOR_LABELS[k], 16)}${padL(pct(f.current.weights[k] ?? 0), 11)}${padL(pct(f.fitted.weights[k] ?? 0), 11)}`,
    );
  }
  console.log(
    `  ${pad("Temperatur", 16)}${padL(dec(f.current.temperature, 1), 11)}${padL(dec(f.fitted.temperature, 1), 11)}`,
  );

  const row = (label: string, e: ModelEval) =>
    hitRow(label, e, padL(dec(e.logLoss), 11));
  // Lopp för lopp mot oddsen: skillnad ± medelfel. Negativt = bättre än oddsen.
  const vs = (k: keyof NonNullable<FitResult["vsMarket"]>) => {
    const p = f.vsMarket?.[k];
    if (!p) return "";
    const sign = p.diff >= 0 ? "+" : "−";
    return padL(`${sign}${dec(Math.abs(p.diff))} ± ${dec(p.se)}`, 16);
  };
  console.log("\nPå testomgångarna");
  console.log(
    `  ${pad("", W.label)}${padL("Etta vann", W.top1)}${padL("Vinnare topp 3", W.top3)}${padL("Vinnarens plac.", W.rank)}${padL("Log loss", 11)}` +
      (f.vsMarket ? padL("Mot oddsen", 16) : ""),
  );
  console.log(row("Nuvarande", f.results.current) + vs("current"));
  console.log(
    row(
      `Bara ny temperatur (${dec(f.recalibrated.temperature, 1)})`,
      f.results.recalibrated,
    ) + vs("recalibrated"),
  );
  if (f.results.marketOnly && f.marketOnly) {
    console.log(
      row(
        `Bara marknaden (${dec(f.marketOnly.temperature, 1)})`,
        f.results.marketOnly,
      ) + vs("marketOnly"),
    );
  }
  console.log(row("Anpassade vikter", f.results.fitted) + vs("fitted"));
  console.log(
    hitRow(
      "Favoriten (lägst odds)",
      f.results.favorite,
      f.results.marketLogLoss !== null
        ? padL(dec(f.results.marketLogLoss), 11)
        : "",
    ),
  );

  const chosenLabel = {
    current: "nuvarande värden",
    recalibrated: "bara ny temperatur",
    marketOnly: "bara marknaden",
    fitted: "anpassade vikter",
  }[f.recommended];

  console.log(`\nKalibrering på testomgångarna, ${chosenLabel}`);
  console.log(
    `  ${pad("Vinstchans", 12)}${padL("Hästar", 8)}${padL("Väntat", 9)}${padL("Utfall", 9)}`,
  );
  for (const b of f.calibration) {
    if (!b.runners) continue;
    console.log(
      `  ${pad(b.label, 12)}${padL(String(b.runners), 8)}${padL(pct(b.expected), 9)}${padL(pct(b.observed), 9)}`,
    );
  }

  const betLine = (
    label: string,
    b: { bets: number; wins: number; roi: number },
  ) =>
    `  ${pad(label, 26)}${padL(String(b.bets), 5)} spel, ${padL(String(b.wins), 3)} vinster, avkastning ${signedPct(b.roi)}`;
  console.log(`\nVinnarspel på testomgångarna, ${chosenLabel}`);
  console.log(betLine("Modellens etta", f.topPickBets));
  console.log(
    betLine(`Spelvärde minst ${dec(f.valueBets.threshold)}`, f.valueBets),
  );

  const temperature = (t: number) =>
    `  probability: { temperature: ${Math.round(t * 10) / 10} },`;
  console.log("\nRekommendation");
  if (f.recommended === "current") {
    console.log(
      "  Inget alternativ är tydligt bättre än de nuvarande värdena på testomgångarna\n" +
        "  (minst 0,01 lägre log loss och mer än två medelfel, lopp för lopp).",
    );
    console.log(
      "  Behåll dem, eller kör igen med fler lopp (tidigare --from, fler spel som --game V85,V86,V64).",
    );
    return;
  }
  if (f.recommended === "recalibrated") {
    console.log(
      "  Behåll vikterna men byt temperatur – det ger bäst vinstchanser på testomgångarna.",
    );
    console.log("  Ersätt i src/scoring/config.ts:\n");
    console.log(temperature(f.recalibrated.temperature));
    return;
  }
  const pick =
    f.recommended === "marketOnly" && f.marketOnly ? f.marketOnly : f.fitted;
  console.log(
    f.recommended === "marketOnly"
      ? "  Bara oddsen träffar bäst på omgångar de inte sett – de andra faktorerna tillför inget än.\n" +
          "  Rankingen blir då oddsens. Vill du ändå använda dem, ersätt i src/scoring/config.ts:"
      : "  De anpassade vikterna träffar bäst på omgångar de inte sett. Ersätt i src/scoring/config.ts:",
  );
  const all = Object.keys(FACTOR_LABELS) as FactorKey[];
  const lines = all.map((k) => {
    const fitted = f.keys.includes(k);
    const w = fitted ? (pick.weights[k] ?? 0) : DEFAULT_CONFIG.weights[k];
    const note = fitted
      ? ""
      : "  // inte med i anpassningen, värdet från config.ts";
    return `    ${k}: ${(Math.round(w * 100) / 100).toFixed(2)},${note}`;
  });
  console.log(`\n  weights: {\n${lines.join("\n")}\n  },`);
  console.log(temperature(pick.temperature));
  if (!f.keys.includes("market")) {
    console.log(
      "\n  Marknad var avstängd (--no-market) och ingick inte. Behåll dess vikt som den är.",
    );
  }
}

function printAblation(a: Ablation) {
  const names = a.without.map((k) => FACTOR_LABELS[k]).join(", ");
  console.log(`\n════════ Med och utan ${names} (--compare-without) ════════`);
  if (!a.diff) {
    console.log("  För få testlopp för en jämförelse.");
    return;
  }
  const { diff, se, races } = a.diff;
  const sign = diff >= 0 ? "+" : "−";
  console.log(
    `  Log loss med − utan, lopp för lopp (${races} testlopp): ${sign}${dec(Math.abs(diff), 3)} ± ${dec(se, 3)}`,
  );
  console.log(
    Math.abs(diff) < 0.001
      ? "  Ingen skillnad – faktorerna fick (nästan) ingen vikt i anpassningen."
      : diff + 2 * se < 0
      ? "  De hjälper: bättre med än utan, med mer än två medelfels marginal."
      : diff - 2 * se > 0
        ? "  De stjälper: sämre med än utan, med mer än två medelfels marginal."
        : "  Ingen säker skillnad – inom två medelfel.",
  );
}

const log = json ? () => {} : (m: string) => console.error(m);

loadResultsHistory(resultsScope)
  .then((results) => {
    log(
      `Resultatsamling: ${results.size} dagar i ${resultsDir(resultsScope)}` +
        (results.size
          ? ""
          : ` – kusk- och tränarform blir neutrala. Kör npm run collect${resultsScope === ALL_RACES ? "" : ` -- --game ${resultsScope}`} först.`),
    );
    return runBacktest({
      from: from as string,
      to,
      gameTypes,
      config,
      charts,
      results,
      log,
    });
  })
  .then((result) => {
    let fitted: FitResult | undefined;
    let ablation: Ablation | undefined;
    let fitError: string | undefined;
    if (fit) {
      const excluded: FactorKey[] = flag("no-market") ? ["market"] : [];
      try {
        fitted = fitBacktest(result.races, config, holdout, excluded);
        if (without.length)
          ablation = compareWithout(
            result.races,
            config,
            holdout,
            excluded,
            without,
            fitted,
          );
      } catch (err) {
        fitError = (err as Error).message;
      }
    }
    if (json) {
      const { races: _races, ...rest } = result;
      return console.log(
        JSON.stringify({ ...rest, fit: fitted ?? fitError, ablation }, null, 2),
      );
    }
    print(result);
    if (fitted) printFit(fitted);
    if (ablation) printAblation(ablation);
    if (fitError) console.log(`\n--fit: ${fitError}`);
  })
  .catch((err) => {
    console.error("Fel:", err);
    process.exit(1);
  });
