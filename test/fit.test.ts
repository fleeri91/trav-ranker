import { test } from "node:test";
import assert from "node:assert/strict";
import { fitBeta, splitByDate } from "../src/backtest/fit.ts";
import type { EvalRace } from "../src/backtest/evaluate.ts";

let seed = 11;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

/** Lopp där faktor 0 avgör och faktor 1 är brus. */
function synthetic(n: number, strength: number) {
  return Array.from({ length: n }, () => {
    const x = Array.from({ length: 10 }, () => [rnd(), rnd()]);
    const z = x.map((row) => strength * row[0]!);
    const e = z.map(Math.exp);
    const sum = e.reduce((a, b) => a + b, 0);
    let u = rnd() * sum;
    let winner = 0;
    while ((u -= e[winner]!) > 0) winner++;
    return { x, winner };
  });
}

test("anpassningen hittar faktorn som avgör och plattar till en överdriven skala", () => {
  const data = synthetic(400, 3);
  const beta = fitBeta(data, [10, 10], 0);
  assert.ok(beta[0]! > beta[1]! * 3, `β = ${beta}`);
  assert.ok(beta[0]! < 6, "skalan ska dras ner från 10 mot den sanna 3");
  assert.ok(beta.every((b) => b >= 0));
});

test("regulariseringen håller kvar vikterna när datan säger lite", () => {
  const data = synthetic(10, 0);
  const free = fitBeta(data, [5, 5], 0);
  const held = fitBeta(data, [5, 5], 1);
  const dist = (b: number[]) => Math.abs(b[0]! - 5) + Math.abs(b[1]! - 5);
  assert.ok(dist(held) < dist(free));
});

test("träning och test delas per tävlingsdag, test sist", () => {
  const races = [
    "2026-08-01",
    "2026-08-01",
    "2026-08-08",
    "2026-08-15",
    "2026-08-22",
  ].map(
    (date, i): EvalRace => ({
      raceId: `R${i}`,
      date,
      winners: [1],
      runners: [],
    }),
  );
  const split = splitByDate(races, 0.5);
  assert.deepEqual(split.trainDates, ["2026-08-01", "2026-08-08"]);
  assert.deepEqual(split.testDates, ["2026-08-15", "2026-08-22"]);
  assert.equal(split.train.length, 3);
});

test("en faktor med vikt 0 kan få vikt igen om den förutsäger vinnaren", () => {
  // Faktor 0 avgör, men börjar med vikt 0.
  const data = synthetic(400, 3);
  const beta = fitBeta(data, [0, 5], 0.02);
  assert.ok(beta[0]! > 1, `β = ${beta}`);
});

test("med svag regularisering kan en stark faktor få den skärpa den behöver", () => {
  // Vinnaren dras med styrka 6 på faktor 0 (som marknaden på log-skala).
  const data = synthetic(600, 6);
  const beta = fitBeta(data, [2, 0]);
  assert.ok(beta[0]! > 4.5, `β = ${beta}`);
});
