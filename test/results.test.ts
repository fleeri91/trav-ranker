import { test } from "node:test";
import assert from "node:assert/strict";
import { toResultRace, type DayResults } from "../src/results/collect.ts";
import { ResultsHistory } from "../src/results/history.ts";
import type { AtgRace } from "../src/types/atg.ts";

/** En dag per datum från 2026-09-01, alla med ett lopp på bana 5. */
function days(n: number, starts: (i: number) => DayResults["races"][0]["starts"]) {
  return Array.from({ length: n }, (_, i) => ({
    date: new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10),
    complete: true,
    races: [{ id: `r${i}`, track: i % 2 ? 5 : 7, starts: starts(i) }],
  }));
}

test("tally räknar bara dagar före datumet och inom perioden", () => {
  // Kusk 1 vinner varje dag, kusk 2 blir trea. Tränare 9 för båda.
  const h = new ResultsHistory(
    days(30, () => [
      [1, 9, 1],
      [2, 9, 3],
    ]),
  );
  // 2026-09-30 är dag 30: 21 dagar före = 09-09 … 09-29.
  assert.deepEqual(h.tally("driver", 1, "2026-09-30", 21), {
    starts: 21,
    wins: 21,
    top3: 21,
  });
  assert.deepEqual(h.tally("driver", 2, "2026-09-30", 21), {
    starts: 21,
    wins: 0,
    top3: 21,
  });
  assert.equal(h.tally("trainer", 9, "2026-09-30", 21)!.starts, 42);
  // Okänd kusk inom en insamlad period: noll starter, inte "okänt".
  assert.deepEqual(h.tally("driver", 3, "2026-09-30", 21), {
    starts: 0,
    wins: 0,
    top3: 0,
  });
});

test("tally per bana, och null när perioden inte är insamlad", () => {
  const h = new ResultsHistory(days(30, () => [[1, 9, 0]]));
  // Udda dagar (09-02, 09-04 …) är bana 5.
  assert.equal(h.tally("driver", 1, "2026-09-30", 20, 5)!.starts, 10);
  assert.equal(h.tally("driver", 1, "2026-09-30", 20, 7)!.starts, 10);
  // 180 dagar bakåt är till största delen inte insamlat.
  assert.equal(h.tally("driver", 1, "2026-09-30", 180), null);
  assert.equal(h.tally("driver", null, "2026-09-30", 21), null);
});

test("toResultRace: strukna hoppas över, oplacerad = 0, bara avgjorda lopp", () => {
  const race: AtgRace = {
    id: "2026-10-17_7_2",
    number: 2,
    status: "results",
    track: { id: 7 },
    starts: [
      { number: 1, driver: { id: 11 }, horse: { trainer: { id: 21 } }, result: { place: 0 } },
      { number: 2, driver: { id: 12 }, horse: { trainer: { id: 22 } }, result: { place: 1 } },
      { number: 3, scratched: true, driver: { id: 13 }, horse: { trainer: { id: 23 } } },
    ],
  };
  assert.deepEqual(toResultRace(race), {
    id: "2026-10-17_7_2",
    track: 7,
    starts: [
      [11, 21, 0],
      [12, 22, 1],
    ],
  });
  assert.equal(toResultRace({ ...race, status: "upcoming" }), null);
});
