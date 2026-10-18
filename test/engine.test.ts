import { test } from "node:test";
import assert from "node:assert/strict";
import { toRaceInput, kmTimeToSec, toSport } from "../src/mappers/atgMapper.ts";
import { standardizeKm } from "../src/scoring/factors.ts";
import { DEFAULT_CONFIG } from "../src/scoring/config.ts";
import { scoreRace } from "../src/scoring/engine.ts";
import { withConfig } from "../src/scoring/config.ts";
import { ChartIndex, nameKey, parseChart } from "../src/clients/travsport.ts";
import { travsportStats } from "./fixtures.ts";
import type { AtgExtendedStart, AtgRace, AtgStart } from "../src/types/atg.ts";

const t = (s: number, tenths = 0) => ({ minutes: 1, seconds: s, tenths });

function start(
  n: number,
  o: Partial<AtgStart> & {
    stats?: [number, number, number, number, number];
  } = {},
): AtgStart {
  const [starts, w, s2, s3, earn] = o.stats ?? [10, 1, 1, 1, 100_000];
  return {
    id: `R1_${n}`,
    number: n,
    postPosition: n,
    distance: 2140,
    horse: {
      id: 1000 + n,
      name: `Häst ${n}`,
      statistics: {
        years: {
          "2026": {
            starts,
            earnings: earn,
            placement: { "1": w, "2": s2, "3": s3 },
          },
        },
        life: {
          starts: starts * 2,
          earnings: earn * 2,
          placement: { "1": w * 2, "2": s2 * 2, "3": s3 * 2 },
        },
      },
      trainer: { id: 500 + n, firstName: "Tränare", lastName: `T${n}` },
    },
    driver: {
      id: 900 + n,
      firstName: "Kusk",
      lastName: `K${n}`,
      statistics: {
        years: { "2026": { starts: 200, placement: { "1": 20 } } },
      },
    },
    pools: { vinnare: { odds: 1000 } },
    ...o,
  };
}

const ext = (results: object[]): AtgExtendedStart => ({
  horse: { results: { collection: results as never } },
});

const race: AtgRace = {
  id: "R1",
  number: 1,
  date: "2026-10-10",
  distance: 2140,
  startMethod: "auto",
  sport: "trot",
  track: { name: "Solvalla" },
  starts: [
    // Nr 4: stark form, snabb, bra spår, barfota första gången, populär kusk
    start(4, {
      stats: [10, 5, 2, 1, 600_000],
      horse: {
        ...start(4).horse,
        statistics: start(4, { stats: [10, 5, 2, 1, 600_000] }).horse!
          .statistics,
        shoes: {
          reported: true,
          front: { hasShoe: false, changed: true },
          back: { hasShoe: false, changed: true },
        },
      },
      driver: {
        id: 77,
        firstName: "Björn",
        lastName: "Goop",
        statistics: {
          years: {
            "2026": { starts: 300, placement: { "1": 75, "2": 40, "3": 30 } },
          },
        },
      },
      pools: { vinnare: { odds: 250 } },
    }),
    start(2, { pools: { vinnare: { odds: 600 } } }),
    start(9, {
      stats: [10, 0, 0, 1, 20_000],
      pools: { vinnare: { odds: 3500 } },
    }),
    start(3, { scratched: true }),
    start(6, { pools: { vinnare: { odds: 1200 } } }),
  ],
};

const extended = new Map<number, AtgExtendedStart | null>([
  [
    4,
    ext([
      {
        date: "2026-09-25",
        place: 1,
        kmTime: t(11, 5),
        startMethod: "auto",
        distance: 2140,
      },
      {
        date: "2026-09-05",
        place: 2,
        kmTime: t(12, 0),
        startMethod: "auto",
        distance: 2140,
      },
    ]),
  ],
  [
    2,
    ext([
      {
        date: "2026-09-20",
        place: 4,
        kmTime: t(13, 0),
        startMethod: "auto",
        distance: 2140,
      },
    ]),
  ],
  [
    9,
    ext([
      {
        date: "2026-06-01",
        place: 0,
        galloped: true,
        startMethod: "volte",
        distance: 2640,
      },
    ]),
  ],
  [6, null], // utökad info saknas
]);

const driverChart = new ChartIndex(parseChart([travsportStats("Björn Goop")]));

test("kmTimeToSec", () => {
  assert.equal(kmTimeToSec(t(12, 5)), 72.5);
  assert.equal(kmTimeToSec(undefined), null);
});

test("rankar starkaste hästen först och utesluter strukna", () => {
  const input = toRaceInput(race, { driverChart, extended });
  const ranked = scoreRace(input);
  assert.equal(ranked.runners[0]?.number, 4);
  assert.equal(ranked.runners.at(-1)?.number, 9);
  assert.deepEqual(ranked.scratched, [3]);
  assert.equal(ranked.runners.length, 4);
  assert.deepEqual(
    ranked.runners.map((r) => r.rank),
    [1, 2, 3, 4],
  );
});

test("sannolikheter summerar till 1 och marknaden saknar överrundning", () => {
  const ranked = scoreRace(toRaceInput(race, { driverChart, extended }));
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  assert.ok(
    Math.abs(sum(ranked.runners.map((r) => r.winProbability)) - 1) < 1e-3,
  );
  assert.ok(
    Math.abs(sum(ranked.runners.map((r) => r.marketProbability ?? 0)) - 1) <
      1e-3,
  );
});

test("saknad data ger neutral poäng och lägre confidence", () => {
  const ranked = scoreRace(toRaceInput(race, { driverChart, extended }));
  const nr6 = ranked.runners.find((r) => r.number === 6)!;
  const nr4 = ranked.runners.find((r) => r.number === 4)!;
  assert.equal(nr6.factors.form.raw, null);
  assert.equal(nr6.factors.form.score, 50);
  assert.ok(nr6.confidence < nr4.confidence);
});

test("motiveringar och topplista kopplas på", () => {
  const ranked = scoreRace(toRaceInput(race, { driverChart, extended }));
  const nr4 = ranked.runners.find((r) => r.number === 4)!;
  assert.ok(nr4.notes.includes("Barfota runt om ändrat sedan förra starten"));
  assert.ok(nr4.notes.some((n) => n.startsWith("Topp-10 kusk")));
});

test("bara marknaden med rätt temperatur ger exakt oddsens chanser", () => {
  const weights = Object.fromEntries(
    Object.keys(DEFAULT_CONFIG.weights).map((k) => [k, k === "market" ? 1 : 0]),
  );
  const ranked = scoreRace(
    toRaceInput(race, { driverChart, extended }),
    withConfig({
      weights,
      // Marknadens skala är ln(0,002)–0, så 100/ln(500) återskapar oddsen.
      probability: { ...DEFAULT_CONFIG.probability, temperature: 100 / Math.log(500) },
    } as Parameters<typeof withConfig>[0]),
  );
  for (const r of ranked.runners) {
    assert.ok(r.marketProbability !== null);
    assert.ok(
      Math.abs(r.winProbability - r.marketProbability) < 1e-3,
      `nr ${r.number}: ${r.winProbability} mot ${r.marketProbability}`,
    );
  }
});

test("vikt 0 stänger av en faktor", () => {
  const ranked = scoreRace(
    toRaceInput(race, { extended }),
    withConfig({ weights: { market: 0 } }),
  );
  assert.ok(ranked.runners.every((r) => r.factors.market.weight === 0));
});

test("tillägg ger avdrag på spår/distans", () => {
  const withHandicap: AtgRace = {
    ...race,
    startMethod: "volte",
    starts: [start(1, { distance: 2160 }), start(2)],
  };
  const ranked = scoreRace(toRaceInput(withHandicap, {}));
  const nr1 = ranked.runners.find((r) => r.number === 1)!;
  const nr2 = ranked.runners.find((r) => r.number === 2)!;
  assert.ok(nr1.factors.position.score < nr2.factors.position.score);
  assert.ok(nr1.notes.includes("20 m tillägg"));
});

test("parser läser Travsports format och hoppar över trasiga poster", () => {
  assert.equal(nameKey("Örjan Kihlström"), nameKey("Kihlstrom Orjan"));
  const entries = parseChart([
    travsportStats("Mats E Djuse", {
      id: { id: 4711, sourceOfData: "T", organisation: "TROT" },
      numberOfFirstPlaces: 279,
      prizeMoney: 41841372,
    }),
    { name: "Saknar statistik" },
    travsportStats("Magnus A Djuse"),
  ]);
  assert.equal(entries.length, 2);
  assert.deepEqual(
    {
      rank: entries[0]?.rank,
      id: entries[0]?.id,
      wins: entries[0]?.wins,
      earnings: entries[0]?.earnings,
    },
    { rank: 1, id: 4711, wins: 279, earnings: 41841372 },
  );
  assert.equal(entries[1]?.rank, 2);
  const index = new ChartIndex(entries);
  assert.equal(index.find(4711, null)?.name, "Mats E Djuse");
  assert.equal(index.find(null, "Djuse Magnus A.")?.name, "Magnus A Djuse");
});

test("id-träff med fel namn godtas inte", () => {
  const index = new ChartIndex(
    parseChart([
      travsportStats("Mats E Djuse", {
        id: { id: 77, sourceOfData: "T", organisation: "TROT" },
      }),
    ]),
  );
  assert.equal(index.find(77, "Björn Goop"), undefined);
  assert.equal(index.find(77, "Mats Djuse")?.name, "Mats E Djuse");
});

test("parser tål att listan ligger inslagen i ett objekt", () => {
  assert.equal(parseChart({ list: [travsportStats("A B")] }).length, 1);
  assert.equal(parseChart("<!DOCTYPE html>").length, 0);
});

test("namnmatchning tål initialer men aldrig tvetydigt", async () => {
  const { ChartIndex } = await import("../src/clients/travsport.ts");
  const unique = new ChartIndex(
    parseChart([
      travsportStats("Magnus A Djuse"),
      travsportStats("Carl Johan Jepson"),
    ]),
  );
  assert.ok(unique.find(null, "Magnus A. Djuse"));
  assert.ok(unique.find(null, "Magnus Djuse"));
  assert.ok(unique.find(null, "Jepson Carl Johan"));

  const twoMats = new ChartIndex(
    parseChart([
      travsportStats("Mats E Djuse"),
      travsportStats("Mats K Djuse"),
    ]),
  );
  assert.equal(twoMats.find(null, "Mats Djuse"), undefined);
  assert.equal(twoMats.find(null, "Mats E. Djuse")?.name, "Mats E Djuse");
});

test("identiska listor upptäcks", async () => {
  const { ChartIndex } = await import("../src/clients/travsport.ts");
  const a = new ChartIndex(
    parseChart([travsportStats("A B"), travsportStats("C D")]),
  );
  const b = new ChartIndex(
    parseChart([travsportStats("A B"), travsportStats("C D")]),
  );
  const c = new ChartIndex(parseChart([travsportStats("E F")]));
  assert.ok(a.sameAs(b));
  assert.ok(!a.sameAs(c));
});

test("resultat från /races/:id/start/ (records) tolkas rätt", async () => {
  const { indexByStartNumber } = await import("../src/mappers/atgMapper.ts");
  const raceStarts = [
    {
      startNumber: 4,
      horse: {
        results: {
          records: [
            {
              date: "2026-09-25",
              place: 1,
              kmTime: { minutes: 1, seconds: 11, tenths: 5 },
              race: { sport: "trot", startMethod: "auto" },
              distance: 2140,
            },
            {
              date: "2026-09-10",
              place: 0,
              kmTime: { code: "g" },
              race: { sport: "trot" },
            },
            {
              date: "2026-08-30",
              place: 2,
              kmTime: { minutes: 1, seconds: 14, tenths: 0, code: "u" },
              race: { sport: "trot" },
            },
            {
              date: "2026-08-01",
              place: 1,
              kmTime: { minutes: 1, seconds: 35, tenths: 0 },
              race: { sport: "gallop" },
            },
            { date: "2026-07-20", scratched: true, race: { sport: "trot" } },
          ],
        },
      },
    },
  ];
  const ext = indexByStartNumber(raceStarts);
  assert.ok(ext.has(4));
  const input = toRaceInput({ ...race, starts: [start(4)] }, { extended: ext });
  const past = input.runners[0]!.past;
  assert.equal(past.length, 3); // galopplopp och struken start bort
  assert.deepEqual(
    past.map((p) => [p.place, p.kmTimeSec, p.galloped]),
    [
      [1, 71.5, false],
      [null, null, true],
      [2, null, false], // tid med kod räknas inte som ren tid
    ],
  );
});

test("riktig resultatpost från ATG tolkas rätt", async () => {
  const { toPastStart } = await import("../src/mappers/atgMapper.ts");
  // Post från /races/2026-10-11_17_4/start/ (förkortad)
  const record = {
    date: "2026-09-25",
    link: true,
    kmTime: { minutes: 1, seconds: 23, tenths: 7 },
    odds: 395,
    place: "6",
    galloped: true,
    race: {
      id: "2026-09-25_16_9",
      sport: "trot",
      type: "regular",
      number: 9,
      startMethod: "volte",
      firstPrize: 5000000,
    },
    track: { id: 16, name: "Gävle", condition: "light", countryCode: "SE" },
    start: {
      distance: 2200,
      postPosition: 1,
      driver: {
        id: 740606,
        firstName: "Magnus A",
        lastName: "Djuse",
        shortName: "Dju MA",
      },
      horse: {
        shoes: { front: true, back: true },
        sulky: { type: { code: "VA", text: "Vanlig" } },
      },
    },
  };
  assert.deepEqual(toPastStart(record), {
    date: "2026-09-25",
    place: 6,
    kmTimeSec: 83.7,
    startMethod: "volte",
    sport: "trot",
    distance: 2200,
    galloped: true,
    disqualified: false,
    odds: 3.95,
    gear: { frontShod: true, backShod: true, american: false },
  });
});

test("toSport: trav och monté rankas, galopp inte", () => {
  assert.equal(toSport("trot"), "trot");
  assert.equal(toSport("monté"), "monte");
  assert.equal(toSport("MONTE"), "monte");
  assert.equal(toSport(undefined), "trot");
  assert.equal(toSport("gallop"), null);
});

test("montétid standardiseras till sulky", () => {
  const cfg = withConfig({
    speed: { ...DEFAULT_CONFIG.speed, monteSecPerKm: 0.6 },
  });
  const sulky = standardizeKm(72, "auto", 2140, cfg);
  assert.equal(sulky, 72);
  assert.ok(
    Math.abs(standardizeKm(72, "auto", 2140, cfg, "monte") - 71.4) < 1e-9,
  );
});

const monteResults = (sports: string[]) =>
  ext(
    sports.map((sport, i) => ({
      date: `2026-09-${String(25 - i * 5).padStart(2, "0")}`,
      place: 1,
      kmTime: t(14),
      race: { sport, startMethod: "auto" },
      distance: 2140,
    })),
  );

test("montélopp: blandad historik, ingen vagn, ryttare och montédebut", () => {
  const monteRace: AtgRace = {
    ...race,
    id: "M1",
    sport: "monté",
    starts: [
      start(1, {
        horse: {
          ...start(1).horse,
          sulky: { type: { code: "AM", text: "Amerikansk", changed: true } },
        },
        driver: { ...start(1).driver, firstName: "Björn", lastName: "Goop" },
      }),
      start(2),
    ],
  };
  const extended = new Map<number, AtgExtendedStart | null>([
    [1, monteResults(["trot", "trot", "gallop"])],
    [2, monteResults(["monté", "trot"])],
  ]);
  const input = toRaceInput(monteRace, { extended, driverChart });
  assert.equal(input.sport, "monte");
  const [a, b] = input.runners;
  assert.deepEqual(
    a!.past.map((p) => p.sport),
    ["trot", "trot"],
  ); // galopp bort, trav kvar
  assert.deepEqual(
    b!.past.map((p) => p.sport),
    ["monte", "trot"],
  );
  assert.deepEqual(a!.sulky, { american: false, changed: false });

  const ranked = scoreRace(input);
  assert.equal(ranked.sport, "monte");
  const one = ranked.runners.find((r) => r.number === 1)!;
  assert.ok(one.notes.includes("Montédebut"));
  assert.ok(one.notes.some((n) => n.startsWith("Topp-10 ryttare")));
  assert.ok(!one.notes.includes("Byter till amerikansk vagn"));
  assert.ok(
    !ranked.runners.find((r) => r.number === 2)!.notes.includes("Montédebut"),
  );
});

test("starter i den andra disciplinen väger lägre i formen", () => {
  // Häst 1: vann i monté, sist i trav. Häst 2: tvärtom. Travlopp idag.
  const results = (first: string, second: string) =>
    ext([
      { date: "2026-09-25", place: 1, race: { sport: first } },
      { date: "2026-09-20", place: 8, race: { sport: second } },
    ]);
  const input = toRaceInput(
    { ...race, starts: [start(1), start(2)] },
    {
      extended: new Map([
        [1, results("monté", "trot")],
        [2, results("trot", "monté")],
      ]),
    },
  );
  const ranked = scoreRace(input, withConfig({ weights: { market: 0 } }));
  const form = (nr: number) =>
    ranked.runners.find((r) => r.number === nr)!.factors.form.raw!;
  // Utan nedviktning vore formen lika (samma placeringar, olika sport).
  assert.ok(form(2) > form(1));
});

test("faktorer med vikt 0 räknas men påverkar inte poängen", () => {
  const input = toRaceInput(race, { driverChart, extended });
  const off = scoreRace(input, withConfig({ weights: { form: 0 } }));
  const nr4 = off.runners.find((r) => r.number === 4)!;
  assert.notEqual(nr4.factors.form.raw, null);
  assert.equal(nr4.factors.form.weight, 0);
  assert.equal(nr4.factors.form.contribution, 0);
});
