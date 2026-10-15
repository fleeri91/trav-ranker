import { test } from "node:test";
import assert from "node:assert/strict";
import { eachDay, winnersOf } from "../src/backtest/run.ts";
import { evaluate, pointsWithout } from "../src/backtest/evaluate.ts";
import { toRaceInput } from "../src/mappers/atgMapper.ts";
import { scoreRace, type RankedRunner } from "../src/scoring/engine.ts";

test("eachDay ger alla datum, båda ändar inräknade", () => {
  assert.deepEqual(eachDay("2026-02-27", "2026-03-02"), [
    "2026-02-27",
    "2026-02-28",
    "2026-03-01",
    "2026-03-02",
  ]);
});

test("vinnaren hämtas ur hästarnas resultatlistor, annars ur spelets result", () => {
  const starts = [
    {
      startNumber: 1,
      horse: { results: { records: [{ place: "3", race: { id: "R1" } }] } },
    },
    {
      startNumber: 2,
      horse: { results: { records: [{ place: "1", race: { id: "R1" } }] } },
    },
    {
      startNumber: 3,
      horse: { results: { records: [{ place: "1", race: { id: "ANNAT" } }] } },
    },
  ];
  assert.deepEqual(winnersOf("R1", starts), [2]);
  const race = {
    id: "R2",
    number: 1,
    starts: [
      { number: 5, result: { place: 1 } },
      { number: 6, result: { place: "2" } },
    ],
  };
  assert.deepEqual(winnersOf("R2", [], race), [5]);
  assert.deepEqual(
    winnersOf("R3", [], { id: "R3", number: 1, starts: [] }),
    [],
  );
});

test("backtest-läget ser bara resultat före loppet och inte dagens statistik", () => {
  const ext = new Map([
    [
      1,
      {
        startNumber: 1,
        horse: {
          statistics: {
            years: { "2026": { starts: 99, placement: { "1": 99 } } },
          },
          results: {
            records: [
              { date: "2026-10-10", place: "1", race: { id: "SAMMA" } },
              { date: "2026-10-17", place: "1", race: { id: "SENARE" } },
              { date: "2026-09-20", place: "4", race: { id: "FÖRE" } },
            ],
          },
        },
      },
    ],
  ]);
  const race = {
    id: "SAMMA",
    number: 1,
    date: "2026-10-10",
    starts: [
      {
        number: 1,
        horse: {
          name: "H",
          statistics: {
            years: { "2026": { starts: 5, placement: { "1": 1 } } },
          },
        },
      },
    ],
  };
  const runner = toRaceInput(race, { extended: ext, before: "2026-10-10" })
    .runners[0]!;
  assert.deepEqual(
    runner.past.map((p) => p.date),
    ["2026-09-20"],
  );
  assert.ok(
    runner.horseYear.starts < 10,
    "statistiken ska komma från spelet, inte den utökade infon",
  );
});

/** Ett lopp där startnummer `best` har bäst form och lägst odds. */
function rankedRace(
  id: string,
  best: number,
  size = 4,
): { raceId: string; runners: RankedRunner[] } {
  const race = {
    id,
    number: 1,
    date: "2026-10-10",
    distance: 2140,
    startMethod: "auto",
    starts: Array.from({ length: size }, (_, i) => ({
      number: i + 1,
      postPosition: 1,
      horse: { name: `H${i + 1}` },
      pools: { vinnare: { odds: i + 1 === best ? 200 : 800 } },
    })),
  };
  const ext = new Map(
    race.starts.map((s) => [
      s.number,
      {
        startNumber: s.number,
        horse: {
          results: {
            records: [
              { date: "2026-09-01", place: s.number === best ? "1" : "6" },
            ],
          },
        },
      },
    ]),
  );
  return {
    raceId: id,
    runners: scoreRace(toRaceInput(race, { extended: ext })).runners,
  };
}

test("evaluate räknar träffar, slumpnivå och spel", () => {
  const a = rankedRace("A", 2); // modellen tror på 2, 2 vinner
  const b = rankedRace("B", 3); // modellen tror på 3, 1 vinner
  const report = evaluate([
    { ...a, winners: [2] },
    { ...b, winners: [1] },
  ]);
  assert.equal(report.races, 2);
  assert.equal(report.model.top1, 0.5);
  assert.equal(report.favorite.top1, 0.5);
  assert.equal(report.random.top1, 0.25);
  assert.deepEqual(
    {
      bets: report.topPickBets.bets,
      wins: report.topPickBets.wins,
      roi: report.topPickBets.roi,
    },
    { bets: 2, wins: 1, roi: 0 }, // 2 kr insats, vinst 2,00 tillbaka
  );
  const form = report.factors.find((f) => f.key === "form");
  assert.equal(form?.stats.top1, 0.5);
  assert.equal(form?.coverage, 1);
});

test("pointsWithout räknar om totalen utan valda faktorer", () => {
  const r = rankedRace("A", 2).runners[0]!;
  const all = pointsWithout(r, []);
  assert.ok(Math.abs(all - r.points) < 0.2);
  assert.notEqual(pointsWithout(r, ["form"]), all);
});

test("lika poäng delar på placeringarna", async () => {
  const { hitStats } = await import("../src/backtest/evaluate.ts");
  const runners = rankedRace("T", 1).runners;
  // Alla har samma poäng: vinnaren har 1/4 chans att vara etta, 3/4 att vara topp 3.
  const s = hitStats([{ raceId: "T", winners: [4], runners }], () => 50);
  assert.equal(s.top1, 0.25);
  assert.equal(s.top3, 0.75);
  assert.equal(s.meanWinnerRank, 2.5);
});

test("evaluate delar upp modellen per sport", () => {
  const a = rankedRace("A", 2);
  const b = rankedRace("B", 3);
  const report = evaluate([
    { ...a, winners: [2] },
    { ...b, sport: "monte", winners: [1] },
  ]);
  assert.deepEqual(
    report.bySport.map((s) => [s.sport, s.model.races, s.model.top1]),
    [
      ["trot", 1, 1],
      ["monte", 1, 0],
    ],
  );
});
