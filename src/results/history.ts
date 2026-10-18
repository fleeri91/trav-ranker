/**
 * Index över insamlade resultat: hur det har gått för en kusk eller tränare
 * under en period före ett datum, totalt eller på en viss bana.
 */
import type { DayResults } from "./collect.ts";

export interface Tally {
  starts: number;
  wins: number;
  top3: number;
}

type Role = "driver" | "trainer";

interface Entry {
  date: string;
  track: number;
  place: number;
}

const DAY_MS = 86_400_000;
const minusDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T12:00:00Z`) - days * DAY_MS)
    .toISOString()
    .slice(0, 10);

/** Första index i en sorterad lista där `date >= target`. */
function lowerBound<T>(xs: T[], target: string, key: (x: T) => string) {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (key(xs[mid]!) < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export class ResultsHistory {
  private readonly people: Record<Role, Map<number, Entry[]>> = {
    driver: new Map(),
    trainer: new Map(),
  };
  /** Insamlade dagar, sorterade. */
  private readonly days: string[];

  constructor(
    days: DayResults[],
    /** Andel av perioden som måste vara insamlad för att svara. */
    private readonly minCoverage = 0.8,
  ) {
    this.days = days.map((d) => d.date).sort();
    for (const day of [...days].sort((a, b) => a.date.localeCompare(b.date))) {
      for (const race of day.races) {
        for (const [driver, trainer, place] of race.starts) {
          const e = { date: day.date, track: race.track, place };
          this.push("driver", driver, e);
          this.push("trainer", trainer, e);
        }
      }
    }
  }

  private push(role: Role, id: number, e: Entry) {
    const list = this.people[role].get(id);
    if (list) list.push(e);
    else this.people[role].set(id, [e]);
  }

  get size() {
    return this.days.length;
  }

  /** Andel av dagarna [before − days, before) som finns insamlade. */
  coverage(before: string, days: number): number {
    const from = minusDays(before, days);
    const n =
      lowerBound(this.days, before, (d) => d) -
      lowerBound(this.days, from, (d) => d);
    return n / days;
  }

  /**
   * Starter, segrar och topp 3 under `days` dagar före `before` (dagen själv
   * räknas inte). null om perioden inte är tillräckligt insamlad.
   */
  tally(
    role: Role,
    id: number | null,
    before: string,
    days: number,
    track?: number,
  ): Tally | null {
    if (id === null || this.coverage(before, days) < this.minCoverage)
      return null;
    const list = this.people[role].get(id) ?? [];
    const from = minusDays(before, days);
    const out: Tally = { starts: 0, wins: 0, top3: 0 };
    const end = lowerBound(list, before, (e) => e.date);
    for (let i = lowerBound(list, from, (e) => e.date); i < end; i++) {
      const e = list[i]!;
      if (track !== undefined && e.track !== track) continue;
      out.starts++;
      if (e.place === 1) out.wins++;
      if (e.place >= 1 && e.place <= 3) out.top3++;
    }
    return out;
  }
}
