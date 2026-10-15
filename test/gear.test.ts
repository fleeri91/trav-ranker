import { test } from "node:test";
import assert from "node:assert/strict";
import { toRaceInput } from "../src/mappers/atgMapper.ts";
import { scoreRace } from "../src/scoring/engine.ts";
import { withConfig } from "../src/scoring/config.ts";
import type { AtgExtendedStart, AtgRace } from "../src/types/atg.ts";

type Gear = { front: boolean; back: boolean; sulky?: string };

/**
 * Egna vikter i testet, så att det inte beror på vad som står i config.ts.
 * En faktor med vikt 0 räknas fortfarande, men ger inga taggar.
 */
const GEAR_CONFIG = withConfig({
  weights: { gearForm: 0.03, gearChange: 0.04 },
});

/** Häst med dagens utrustning `today` och tidigare starter (senaste först). */
function horse(
  nr: number,
  today: Gear & { changed?: boolean },
  history: Array<Gear & { place: number }>,
) {
  const start = {
    number: nr,
    horse: {
      name: `H${nr}`,
      shoes: {
        reported: true,
        front: { hasShoe: today.front, changed: today.changed ?? false },
        back: { hasShoe: today.back, changed: today.changed ?? false },
      },
      sulky: {
        type: { code: today.sulky ?? "VA", changed: today.changed ?? false },
      },
    },
  };
  const ext: AtgExtendedStart = {
    startNumber: nr,
    horse: {
      results: {
        records: history.map((h, i) => ({
          date: `2026-09-${String(28 - i * 3).padStart(2, "0")}`,
          place: String(h.place),
          race: { id: `old${nr}_${i}`, sport: "trot" },
          start: {
            horse: {
              shoes: { front: h.front, back: h.back },
              sulky: { type: { code: h.sulky ?? "VA" } },
            },
          },
        })),
      },
    },
  };
  return { start, ext };
}

function rank(horses: ReturnType<typeof horse>[]) {
  const race: AtgRace = {
    id: "R",
    number: 1,
    date: "2026-10-10",
    distance: 2140,
    startMethod: "auto",
    starts: horses.map((h) => h.start),
  };
  const extended = new Map(horses.map((h) => [h.start.number, h.ext]));
  return scoreRace(toRaceInput(race, { extended }), GEAR_CONFIG);
}

const shod = (place: number): Gear & { place: number } => ({
  front: true,
  back: true,
  place,
});
const barefoot = (place: number): Gear & { place: number } => ({
  front: false,
  back: false,
  place,
});

test("barfota runt om och amerikansk vagn för första gången ger full bonus", () => {
  const ranked = rank([
    horse(1, { front: false, back: false, sulky: "AM" }, [
      shod(3),
      shod(4),
      shod(2),
      shod(5),
    ]),
    horse(2, { front: true, back: true }, [shod(3), shod(4), shod(2), shod(5)]),
  ]);
  const first = ranked.runners.find((r) => r.number === 1)!;
  assert.equal(first.factors.gearChange.raw, 6);
  assert.equal(first.factors.gearChange.score, 100);
  assert.ok(first.notes.includes("Barfota runt om för första gången"));
  assert.ok(first.notes.includes("Amerikansk vagn för första gången"));
  assert.equal(
    ranked.runners.find((r) => r.number === 2)!.factors.gearChange.raw,
    0,
  );
});

test("ingen bonus om hästen gått barfota runt om förut, även om skorna åkt av sedan förra starten", () => {
  const ranked = rank([
    horse(1, { front: false, back: false, changed: true }, [
      shod(3),
      barefoot(1),
      shod(2),
      shod(4),
    ]),
  ]);
  assert.equal(ranked.runners[0]!.factors.gearChange.raw, 0);
});

test("barfota fram för första gången ger halv bonus", () => {
  const ranked = rank([
    horse(1, { front: false, back: true }, [
      shod(3),
      shod(4),
      { front: true, back: false, place: 2 },
    ]),
  ]);
  assert.equal(ranked.runners[0]!.factors.gearChange.raw, 2);
  assert.ok(
    ranked.runners[0]!.notes.includes("Barfota fram för första gången"),
  );
});

test("för kort historik: ATG:s ändrat-flagga ger halva bonusen", () => {
  const ranked = rank([
    horse(1, { front: false, back: false, changed: true }, [shod(3)]),
  ]);
  assert.equal(ranked.runners[0]!.factors.gearChange.raw, 2);
  assert.ok(
    ranked.runners[0]!.notes.includes(
      "Barfota runt om ändrat sedan förra starten",
    ),
  );
});

test("rustningsformen räknar bara starter med dagens utrustning", () => {
  const ranked = rank([
    // Vinner barfota, sämre skodd: idag barfota
    horse(1, { front: false, back: false }, [
      shod(6),
      barefoot(1),
      shod(7),
      barefoot(2),
      shod(8),
    ]),
    // Samma resultat men omvänt: idag barfota, men det är där den gått dåligt
    horse(2, { front: false, back: false }, [
      shod(1),
      barefoot(6),
      shod(2),
      barefoot(7),
      shod(1),
    ]),
    // Aldrig barfota förut: ingen rustningsform alls
    horse(3, { front: false, back: false }, [shod(1), shod(2), shod(3)]),
  ]);
  const by = (n: number) => ranked.runners.find((r) => r.number === n)!;
  assert.ok(by(1).factors.gearForm.score > by(2).factors.gearForm.score);
  assert.equal(by(3).factors.gearForm.raw, null);
  assert.ok(
    by(1).notes.some((n) =>
      n.startsWith("Barfota runt om: 1 seger, 2 topp 3 på 2 starter"),
    ),
  );
});
