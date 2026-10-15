import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildAtgCharts,
  chartFile,
  loadChartFile,
  loadSeasonChart,
} from "../src/clients/charts.ts";
import type { AtgGame, AtgPerson } from "../src/types/atg.ts";
import { travsportStats } from "./fixtures.ts";

const person = (
  id: number,
  last: string,
  wins: number,
  earnings = 0,
): AtgPerson => ({
  id,
  firstName: "Test",
  lastName: last,
  statistics: {
    years: { "2026": { starts: 100, earnings, placement: { "1": wins } } },
  },
});

const game = (id: string, drivers: AtgPerson[]): AtgGame => ({
  id,
  races: [
    {
      id: `${id}_R1`,
      number: 1,
      starts: drivers.map((d, i) => ({
        number: i + 1,
        driver: d,
        horse: { trainer: person(500 + i, `T${i}`, i) },
      })),
    },
  ],
});

test("ATG-topplista rankar på årets segrar och räknar varje person en gång", () => {
  const a = person(1, "A", 10);
  const b = person(2, "B", 40);
  const c = person(3, "C", 10, 999);
  const charts = buildAtgCharts(
    [game("G1", [a, b]), game("G2", [b, c])],
    "2026-12-31",
  );
  assert.equal(charts.drivers.size, 3);
  assert.equal(charts.drivers.find(2, null)?.rank, 1);
  assert.equal(charts.drivers.find(3, null)?.rank, 2); // lika segrar, mer intjänat
  assert.equal(charts.drivers.find(null, "A Test")?.rank, 3);
});

test("sparad Travsport-fil läses, saknad fil ger null", async () => {
  process.env.TRAV_DATA_DIR = await mkdtemp(path.join(tmpdir(), "trav-data-"));
  assert.equal(await loadChartFile("trainers"), null);
  await writeFile(
    path.join(process.env.TRAV_DATA_DIR, "travsport-drivers.json"),
    JSON.stringify([travsportStats("Björn Goop", { numberOfFirstPlaces: 75 })]),
  );
  const index = await loadChartFile("drivers");
  assert.equal(index?.find(null, "Goop Björn")?.wins, 75);
});

test("STL-listan läses från egen fil", async () => {
  process.env.TRAV_DATA_DIR = await mkdtemp(path.join(tmpdir(), "trav-data-"));
  await writeFile(
    path.join(process.env.TRAV_DATA_DIR, "travsport-drivers-stl.json"),
    JSON.stringify([travsportStats("Örjan Kihlström")]),
  );
  assert.equal(await loadChartFile("drivers"), null);
  const stl = await loadChartFile("drivers", "stl");
  assert.ok(stl?.find(null, "Örjan Kihlström"));
});

test("montélistan läses från egen fil", async () => {
  process.env.TRAV_DATA_DIR = await mkdtemp(path.join(tmpdir(), "trav-data-"));
  assert.equal(
    path.basename(chartFile("drivers", "monte", 2026)),
    "travsport-drivers-monte-2026.json",
  );
  await writeFile(
    chartFile("drivers", "monte"),
    JSON.stringify([travsportStats("Iina Rastas")]),
  );
  assert.equal(await loadChartFile("drivers"), null);
  const monte = await loadChartFile("drivers", "monte");
  assert.ok(monte?.find(null, "Iina Rastas"));
});

test("montélistan hittas även som travsport-drivers-ÅÅÅÅ-monté.json", async () => {
  process.env.TRAV_DATA_DIR = await mkdtemp(path.join(tmpdir(), "trav-data-"));
  await writeFile(
    path.join(process.env.TRAV_DATA_DIR, "travsport-drivers-2026-monté.json"),
    JSON.stringify([travsportStats("Jonathan Carré")]),
  );
  const monte = await loadChartFile("drivers", "monte", undefined, 2026);
  assert.ok(monte?.find(null, "Jonathan Carré"));
  const season = await loadSeasonChart("drivers", "monte", "2026-10-12");
  assert.ok(season?.index.find(null, "Jonathan Carré"));
  assert.equal(await loadChartFile("drivers", "all", undefined, 2026), null);
});
