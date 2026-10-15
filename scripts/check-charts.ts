/**
 * Kontrollerar manuellt sparade topplistor i data/ – gör inga nätverksanrop.
 * Visar årets och förra årets listor. Saknas en fil skrivs adressen ut som du
 * öppnar i webbläsaren och sparar.
 *
 *   npm run check:charts
 */
import { existsSync } from "node:fs";
import path from "node:path";
import {
  CHART_VARIANTS,
  RACE_TYPE_OF,
  SULKY_OR_MONTE_OF,
  VARIANT_KINDS,
  VARIANT_TAG,
  chartFile,
  findChartFile,
  loadChartFile,
  type ChartKind,
  type ChartVariant,
} from "../src/clients/charts.ts";
import {
  CHART_PRESETS,
  buildChartUrl,
  chartQuery,
  type ChartIndex,
} from "../src/clients/travsport.ts";
import { season } from "../src/scoring/season.ts";

const today = new Date().toLocaleDateString("sv-SE", {
  timeZone: "Europe/Stockholm",
});
const s = season(today);
const KINDS: ChartKind[] = ["drivers", "trainers"];
const LABEL: Record<ChartKind, string> = {
  drivers: "Kuskar",
  trainers: "Tränare",
};
const loaded = new Map<string, ChartIndex>();
const key = (kind: ChartKind, variant: ChartVariant, year: number) =>
  `${kind}-${variant}-${year}`;

console.log(
  `Idag (${today}) räknas ${s.year} fullt och ${s.prevYear} med ${Math.round(s.prevWeight * 100)} %.`,
);

for (const variant of CHART_VARIANTS) {
  for (const kind of VARIANT_KINDS[variant]) {
    for (const year of [s.year, s.prevYear]) {
      const file =
        findChartFile(kind, variant, year) ?? chartFile(kind, variant, year);
      console.log(
        `\n── ${LABEL[kind]}${VARIANT_TAG[variant]} ${year}  ${path.basename(file)}`,
      );
      try {
        const index = await loadChartFile(
          kind,
          variant,
          (m) => console.log(`  ⚠ ${m}`),
          year,
        );
        if (!index) {
          const legacy = chartFile(kind, variant);
          if (year === s.year && existsSync(legacy)) {
            console.log(
              `  saknas, men ${path.basename(legacy)} används som årets lista. Byt gärna namn:`,
            );
            console.log(`  mv "${legacy}" "${file}"`);
            continue;
          }
          const url = buildChartUrl(
            chartQuery({
              ...CHART_PRESETS[kind],
              typeOfRace: RACE_TYPE_OF[variant],
              sulkyOrMonte: SULKY_OR_MONTE_OF[variant],
              year,
            }),
          );
          console.log(
            "  saknas – öppna i webbläsaren och spara som filen ovan:",
          );
          console.log(`  ${url}`);
          continue;
        }
        loaded.set(key(kind, variant, year), index);
        console.log(`  ${index.size} poster. Topp 3:`);
        for (const e of index.entries.slice(0, 3))
          console.log("   ", JSON.stringify(e));
      } catch (err) {
        console.log(`  fel: ${(err as Error).message}`);
      }
    }
  }
}

const warn = (
  a: ChartIndex | undefined,
  b: ChartIndex | undefined,
  text: string,
) => {
  if (a && b?.sameAs(a)) console.log(`\n⚠ ${text}`);
};
for (const year of [s.year, s.prevYear]) {
  for (const variant of CHART_VARIANTS) {
    const tag = `${VARIANT_TAG[variant]} ${year}`;
    warn(
      loaded.get(key("drivers", variant, year)),
      loaded.get(key("trainers", variant, year)),
      `Tränarlistan${tag} är identisk med kusklistan – fel fil.`,
    );
  }
  for (const kind of KINDS) {
    warn(
      loaded.get(key(kind, "all", year)),
      loaded.get(key(kind, "stl", year)),
      `${LABEL[kind]} ${year}: STL-listan är identisk med den allmänna – sparades den med typeOfRace=R?`,
    );
  }
  warn(
    loaded.get(key("drivers", "all", year)),
    loaded.get(key("drivers", "monte", year)),
    `Kuskar ${year}: montélistan är identisk med den allmänna – sparades den med sulkyOrMonte=M?`,
  );
}
for (const variant of CHART_VARIANTS) {
  for (const kind of VARIANT_KINDS[variant]) {
    warn(
      loaded.get(key(kind, variant, s.year)),
      loaded.get(key(kind, variant, s.prevYear)),
      `${LABEL[kind]}${VARIANT_TAG[variant]}: ${s.year} och ${s.prevYear} är identiska – kontrollera year= i adressen.`,
    );
  }
}
