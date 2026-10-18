/**
 * Samlar travresultat per dag till data/results/<omfång>/ (för kusk- och
 * tränarform och kusk per bana).
 *
 *   npm run collect -- --game V85 --from 2025-08-01
 *   npm run collect -- --game V85 --from 2026-10-01 --to 2026-10-10
 *   npm run collect -- --from 2025-08-01          (alla svenska travlopp)
 *
 * --game väljer en spelform: bara loppen i dess omgångar hämtas, ett anrop per
 * omgång. Utan --game hämtas alla svenska travlopp (ett anrop per lopp).
 *
 * --to är som standard i går. Dagar som redan är sparade och kompletta hämtas
 * inte igen, så kör samma kommando för att fylla på.
 */
import { eachDay } from "../src/backtest/run.ts";
import { ALL_RACES, collectDay, resultsDir } from "../src/results/collect.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const isDate = (s?: string): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);

const today = new Date().toLocaleDateString("sv-SE", {
  timeZone: "Europe/Stockholm",
});
const yesterday = new Date(Date.parse(`${today}T12:00:00Z`) - 86_400_000)
  .toISOString()
  .slice(0, 10);

const scope = arg("game") ?? ALL_RACES;
const from = arg("from");
const to = arg("to") ?? yesterday;
if (!isDate(from)) {
  console.error("Ange startdatum: --from ÅÅÅÅ-MM-DD");
  process.exit(1);
}
if (!isDate(to) || to >= today) {
  console.error(`--to måste vara ÅÅÅÅ-MM-DD och före i dag (${today})`);
  process.exit(1);
}

console.log(
  `Samlar ${scope === ALL_RACES ? "alla svenska travlopp" : scope.toUpperCase()} till ${resultsDir(scope)}`,
);
let races = 0;
let incomplete = 0;
for (const date of eachDay(from, to)) {
  const day = await collectDay(date, { scope, log: (m) => console.log(m) });
  races += day.races.length;
  if (!day.complete) incomplete++;
}
console.log(
  `\nKlart: ${eachDay(from, to).length} dagar, ${races} lopp` +
    (incomplete ? `, ${incomplete} dagar med lopp utan resultat` : ""),
);
