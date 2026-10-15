import { test } from "node:test";
import assert from "node:assert/strict";
import { renderRankingPdf } from "../src/export/pdf.ts";
import { scoreRace } from "../src/scoring/engine.ts";
import { toRaceInput } from "../src/mappers/atgMapper.ts";
import type { AtgRace } from "../src/types/atg.ts";

const race = (n: number, runners: number): AtgRace => ({
  id: `R${n}`,
  number: n,
  date: "2026-10-10",
  distance: 2140,
  startMethod: "auto",
  startTime: "2026-10-10T16:20:00",
  track: { name: "Solvalla" },
  starts: Array.from({ length: runners }, (_, i) => ({
    number: i + 1,
    horse: {
      name: `Häst ${i + 1} med ett ganska långt namn som får kortas av`,
    },
    driver: { firstName: "Örjan", lastName: "Kihlström" },
    pools: { vinnare: { odds: 300 + i * 250 } },
  })),
});

const pageCount = (pdf: Buffer) =>
  (pdf.toString("latin1").match(/\/Type \/Page\b/g) ?? []).length;

test("PDF skapas med en sida per fullt lopp", async () => {
  const races = [1, 2, 3].map((n) => scoreRace(toRaceInput(race(n, 15), {})));
  const pdf = await renderRankingPdf(
    { gameId: "V85_test", gameType: "V85", races },
    { date: "2026-10-10", computedAt: Date.now() },
  );
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  assert.ok(pageCount(pdf) >= 3);
});

test("PDF för spel utan lopp ger en sida", async () => {
  const pdf = await renderRankingPdf(
    { gameId: "x", gameType: "V4", races: [] },
    { date: "2026-10-10", computedAt: Date.now() },
  );
  assert.equal(pageCount(pdf), 1);
});
