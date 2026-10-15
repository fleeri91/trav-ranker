import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { blendStats, season } from "../src/scoring/season.ts";
import { blendCharts, loadSeasonChart } from "../src/clients/charts.ts";
import { parseChart } from "../src/clients/travsport.ts";
import { toRaceInput } from "../src/mappers/atgMapper.ts";
import { travsportStats } from "./fixtures.ts";

const near = (a: number, b: number, eps = 0.01) =>
  assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
const id = (n: number) => ({ id: n, sourceOfData: "T", organisation: "TROT" });

test("förra året väger mycket i januari och nästan inget i december", () => {
  const jan = season("2026-01-10");
  assert.deepEqual([jan.year, jan.prevYear], [2026, 2025]);
  near(jan.prevWeight, 0.975);
  near(season("2026-07-02").prevWeight, 0.5);
  assert.ok(season("2026-12-31").prevWeight < 0.01);
});

test("blendStats lägger till förra året viktat", () => {
  const cur = { starts: 2, wins: 0, seconds: 1, thirds: 0, earnings: 1000 };
  const prev = {
    starts: 100,
    wins: 20,
    seconds: 10,
    thirds: 10,
    earnings: 500_000,
  };
  assert.deepEqual(blendStats(cur, prev, 0.5), {
    starts: 52,
    wins: 10,
    seconds: 6,
    thirds: 5,
    earnings: 251_000,
  });
});

test("blendCharts slår ihop samma person och rankar om", () => {
  const cur = parseChart([
    travsportStats("Anna A", { id: id(1), numberOfFirstPlaces: 2 }),
  ]);
  const prev = parseChart([
    travsportStats("Anna A", { id: id(1), numberOfFirstPlaces: 100 }),
    travsportStats("Bertil B", { id: id(2), numberOfFirstPlaces: 80 }),
  ]);
  const blended = blendCharts(cur, prev, 0.9);
  assert.deepEqual(
    blended.map((e) => [e.name, e.rank, e.wins]),
    [
      ["Anna A", 1, 92],
      ["Bertil B", 2, 72],
    ],
  );
  assert.equal(blendCharts(cur, prev, 0), cur);
});

test("loadSeasonChart läser årets och förra årets fil, och det gamla filnamnet", async () => {
  process.env.TRAV_DATA_DIR = await mkdtemp(
    path.join(tmpdir(), "trav-season-"),
  );
  const dir = process.env.TRAV_DATA_DIR;
  await writeFile(
    path.join(dir, "travsport-drivers-2026.json"),
    JSON.stringify([travsportStats("Ny Kusk", { numberOfFirstPlaces: 5 })]),
  );
  await writeFile(
    path.join(dir, "travsport-drivers-2025.json"),
    JSON.stringify([
      travsportStats("Gammal Kusk", { numberOfFirstPlaces: 200 }),
    ]),
  );
  const jan = await loadSeasonChart("drivers", "all", "2026-01-15");
  assert.equal(jan?.files.length, 2);
  assert.equal(jan?.index.entries[0]?.name, "Gammal Kusk");

  await writeFile(
    path.join(dir, "travsport-trainers.json"),
    JSON.stringify([travsportStats("Tränare Utan År")]),
  );
  const logs: string[] = [];
  const legacy = await loadSeasonChart("trainers", "all", "2026-06-01", (m) =>
    logs.push(m),
  );
  assert.equal(legacy?.index.entries[0]?.name, "Tränare Utan År");
  assert.ok(logs.some((m) => m.includes("travsport-trainers-2026.json")));

  assert.equal(await loadSeasonChart("drivers", "stl", "2026-06-01"), null);
});

test("ATG-mappern använder senaste 12 månaderna för kusk och häst", () => {
  const years = {
    "2025": { starts: 100, placement: { "1": 20 } },
    "2026": { starts: 2, placement: { "1": 0 } },
  };
  const race = toRaceInput(
    {
      id: "R1",
      number: 1,
      date: "2026-01-10",
      distance: 2140,
      startMethod: "auto",
      starts: [
        {
          number: 1,
          driver: {
            id: 1,
            firstName: "K",
            lastName: "K",
            statistics: { years },
          },
          horse: { name: "H", statistics: { years } },
        },
      ],
    },
    {},
  );
  const runner = race.runners[0]!;
  near(runner.driver.year.starts, 2 + 100 * 0.975, 0.2);
  near(runner.horseYear.wins, 20 * 0.975, 0.1);
});
