import { test } from "node:test";
import assert from "node:assert/strict";
import { withPoolValue } from "../src/pipeline.ts";
import type { RankedRace, RankedRunner } from "../src/scoring/engine.ts";
import type { AtgRace } from "../src/types/atg.ts";

const runner = (number: number, winProbability: number) =>
  ({ number, winProbability, notes: [] }) as unknown as RankedRunner;

const ranked = {
  runners: [runner(1, 0.5), runner(2, 0.3), runner(3, 0.2)],
} as unknown as RankedRace;

// V85-procent i hundradels-procent: 60 %, 20 %, 20 %.
const race = (dist: (number | undefined)[]): AtgRace => ({
  id: "r",
  number: 1,
  starts: dist.map((d, i) => ({
    number: i + 1,
    pools: d === undefined ? {} : { V85: { betDistribution: d } },
  })),
});

test("poolValue = vinstchans ÷ andel av insatserna, med noteringar", () => {
  const out = withPoolValue(ranked, race([6000, 2000, 2000]), "V85");
  assert.equal(out.pool, "V85");
  assert.deepEqual(
    out.runners.map((r) => [r.poolShare, r.poolValue]),
    [
      [0.6, 0.83],
      [0.2, 1.5],
      [0.2, 1],
    ],
  );
  assert.ok(out.runners[1]!.notes[0]!.startsWith("Underspelad i V85"));
  assert.deepEqual(out.runners[0]!.notes, []); // 0,83 är inte under 0,8
  // Samma lopp i ett annat spel ändras inte.
  assert.equal(ranked.runners[1]!.poolValue, undefined);
});

test("överspelad favorit får en notering", () => {
  const out = withPoolValue(ranked, race([7000, 1500, 1500]), "V85");
  assert.equal(out.runners[0]!.poolValue, 0.71);
  assert.ok(out.runners[0]!.notes[0]!.startsWith("Överspelad i V85"));
});

test("utan fördelning för alla hästar lämnas loppet orört", () => {
  assert.equal(withPoolValue(ranked, race([6000, 2000, undefined]), "V85"), ranked);
  assert.equal(withPoolValue(ranked, race([6000, 2000, 2000]), "vinnare"), ranked);
});
