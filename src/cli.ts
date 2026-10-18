/**
 * Användning:
 *   npm run rank -- --date 2026-10-10 --game V75
 *   npm run rank -- --date 2026-10-10 --game V75,V5 --json > ranking.json
 *   npm run rank -- --no-market        (rankning utan odds/streckprocent)
 *   npm run rank -- --no-monte         (bara travlopp med sulky)
 *   npm run rank -- --charts atg       (topplistor: auto | atg | file | travsport | none)
 */
import { rankDay, SPORTS } from "./pipeline.ts";
import { CHART_SOURCES, type ChartSource } from "./clients/charts.ts";
import {
  FACTOR_LABELS,
  MONTE_FACTOR_LABELS,
  withConfig,
  type FactorKey,
} from "./scoring/config.ts";
import type { RankedRace } from "./scoring/engine.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const today = new Date().toLocaleDateString("sv-SE", {
  timeZone: "Europe/Stockholm",
});
const date = arg("date") ?? today;
const gameTypes = arg("game")
  ?.split(",")
  .map((s) => s.trim());
const json = flag("json");
const config = withConfig(flag("no-market") ? { weights: { market: 0 } } : {});
const chartsArg = arg("charts") ?? "auto";
if (!CHART_SOURCES.includes(chartsArg as ChartSource)) {
  console.error(
    `Okänd --charts "${chartsArg}". Välj: ${CHART_SOURCES.join(", ")}`,
  );
  process.exit(1);
}
const charts = chartsArg as ChartSource;
const sports = flag("no-monte") ? SPORTS.filter((s) => s !== "monte") : SPORTS;

const factorLabel = (k: FactorKey, race: RankedRace) =>
  (race.sport === "monte" ? MONTE_FACTOR_LABELS[k] : undefined) ??
  FACTOR_LABELS[k];

const pad = (s: string | number, n: number) => String(s).padEnd(n).slice(0, n);
const padL = (s: string | number, n: number) => String(s).padStart(n).slice(-n);

function topFactors(
  r: RankedRace["runners"][number],
  race: RankedRace,
): string {
  return (
    Object.entries(r.factors) as [
      FactorKey,
      { score: number; weight: number },
    ][]
  )
    .filter(([, f]) => f.weight > 0)
    .sort((a, b) => b[1].score * b[1].weight - a[1].score * a[1].weight)
    .slice(0, 2)
    .map(([k, f]) => `${factorLabel(k, race)} ${Math.round(f.score)}`)
    .join(", ");
}

function printRace(race: RankedRace) {
  const monte = race.sport === "monte";
  console.log(
    `\n  Lopp ${race.number} · ${race.trackName} · ${race.distance} m ${race.startMethod}` +
      (monte ? " · Monté" : "") +
      (race.scratched.length ? ` · struken: ${race.scratched.join(", ")}` : ""),
  );
  console.log(
    `  ${pad("#", 3)}${pad("Nr", 4)}${pad("Häst", 20)}${pad(monte ? "Ryttare" : "Kusk", 18)}${padL("Poäng", 6)}${padL("V%", 6)}${padL("Egen", 6)}${padL("Odds", 7)}${padL("Värde", 7)}  Styrkor`,
  );
  for (const r of race.runners) {
    console.log(
      `  ${pad(r.rank, 3)}${pad(r.number, 4)}${pad(r.horseName, 20)}${pad(r.driverName, 18)}` +
        `${padL(r.points.toFixed(1), 6)}${padL((r.winProbability * 100).toFixed(0), 6)}${padL(r.own.rank, 6)}` +
        `${padL(r.odds?.toFixed(2) ?? "–", 7)}${padL((r.poolValue ?? r.value)?.toFixed(2) ?? "–", 7)}  ${topFactors(r, race)}` +
        (r.confidence < 0.6 ? "  (låg datatäckning)" : "") +
        (r.notes.length ? `\n${" ".repeat(9)}↳ ${r.notes.join(" · ")}` : ""),
    );
  }
}

const log = json ? () => {} : (m: string) => console.error(m);

rankDay({ date, gameTypes, config, charts, sports, log })
  .then((games) => {
    if (json) return console.log(JSON.stringify(games, null, 2));
    if (!games.length) return console.log(`Inga matchande spel ${date}.`);
    for (const g of games) {
      console.log(`\n=== ${g.gameType} · ${g.gameId} ===`);
      g.races.forEach(printRace);
    }
  })
  .catch((err) => {
    console.error("Fel:", err);
    process.exit(1);
  });
