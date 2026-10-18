/**
 * Resultatsamling: lopp per dag med kusk, tränare och placering. Ger kusk- och
 * tränarform och kusk per bana.
 *
 * Omfång ("scope"):
 * - "all": alla svenska travlopp, via ATG:s vinnarspel per lopp
 *   (`vinnare_<lopp-id>`) – ett anrop per lopp.
 * - en spelform, t.ex. "V85": bara loppen i den spelformens omgångar – ett
 *   anrop per omgång.
 *
 * Varje dag sparas kompakt i data/results/<scope>/ÅÅÅÅ-MM-DD.json. En avgjord
 * dag ändras inte, så den hämtas bara en gång.
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { atg } from "../clients/atg.ts";
import { toNumber } from "../clients/travsport.ts";
import type { AtgRace } from "../types/atg.ts";

export const RESULTS_DIR =
  process.env.TRAV_RESULTS_DIR ?? path.join(process.cwd(), "data", "results");

/** "all" (alla svenska travlopp) eller en spelform, t.ex. "V85". */
export type ResultsScope = string;
export const ALL_RACES: ResultsScope = "all";

const normalizeScope = (scope: ResultsScope) =>
  scope.toLowerCase() === ALL_RACES ? ALL_RACES : scope.toUpperCase();

export const resultsDir = (scope: ResultsScope = ALL_RACES) =>
  path.join(RESULTS_DIR, normalizeScope(scope));

/** En start: kusk-id, tränar-id, placering (1–3 = pris, 0 = oplacerad/diskad). */
export type ResultStart = [driver: number, trainer: number, place: number];

export interface ResultRace {
  id: string;
  track: number;
  starts: ResultStart[];
}

export interface DayResults {
  date: string;
  /** Falskt om något lopp saknade resultat när dagen hämtades. */
  complete: boolean;
  races: ResultRace[];
}

const fileFor = (date: string, scope: ResultsScope) =>
  path.join(resultsDir(scope), `${date}.json`);

export async function readDay(
  date: string,
  scope: ResultsScope = ALL_RACES,
): Promise<DayResults | null> {
  try {
    return JSON.parse(
      await readFile(fileFor(date, scope), "utf8"),
    ) as DayResults;
  } catch {
    return null;
  }
}

/** Alla sparade dagar i ett omfång, äldst först. */
export async function readAllDays(
  scope: ResultsScope = ALL_RACES,
): Promise<DayResults[]> {
  let files: string[];
  try {
    files = await readdir(resultsDir(scope));
  } catch {
    return [];
  }
  const days = await Promise.all(
    files
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .sort()
      .map((f) => readDay(f.slice(0, 10), scope)),
  );
  return days.filter((d): d is DayResults => d !== null);
}

export function toResultRace(race: AtgRace): ResultRace | null {
  const track = race.track?.id;
  if (race.status !== "results" || typeof track !== "number") return null;
  const starts: ResultStart[] = [];
  for (const s of race.starts ?? []) {
    if (s.scratched) continue;
    const driver = s.driver?.id;
    const trainer = s.horse?.trainer?.id;
    if (typeof driver !== "number" || typeof trainer !== "number") continue;
    const place = toNumber(s.result?.place) ?? 0;
    starts.push([driver, trainer, place > 0 ? place : 0]);
  }
  return starts.length ? { id: race.id, track, starts } : null;
}

export interface CollectOptions {
  scope?: ResultsScope;
  log?: (m: string) => void;
}

/**
 * Hämtar och sparar en dags resultat. En sparad komplett dag hämtas inte igen.
 * Med "all": bara svenska travbanor (trav och monté); galopp och utländska
 * banor hoppas över. Med en spelform: loppen i dagens omgångar av den.
 */
export async function collectDay(
  date: string,
  { scope = ALL_RACES, log = () => {} }: CollectOptions = {},
): Promise<DayResults> {
  const saved = await readDay(date, scope);
  if (saved?.complete) return saved;

  const calendar = await atg.calendarDay(date, { persist: true });
  let games: { id: string }[];
  if (normalizeScope(scope) === ALL_RACES) {
    const tracks = new Set(
      (calendar.tracks ?? [])
        .filter((t) => t.countryCode === "SE" && t.sport === "trot")
        .map((t) => t.id),
    );
    games = (calendar.games?.vinnare ?? []).filter((g) =>
      (g.tracks ?? []).some((t) => tracks.has(t)),
    );
  } else {
    const wanted = normalizeScope(scope);
    games = Object.entries(calendar.games ?? {})
      .filter(([type]) => type.toUpperCase() === wanted)
      .flatMap(([, list]) => list ?? []);
  }

  const races: ResultRace[] = [];
  const seen = new Set<string>();
  let missing = 0;
  for (const g of games) {
    try {
      const game = await atg.settledGame(g.id);
      for (const race of game.races ?? []) {
        if (seen.has(race.id)) continue;
        seen.add(race.id);
        // Inte avgjort ännu: dagen hämtas igen nästa gång. Avgjort men utan
        // användbara starter (t.ex. utländska kuskar utan id) hoppas över.
        if (race.status !== "results") missing++;
        const r = toResultRace(race);
        if (r) races.push(r);
      }
    } catch (err) {
      missing++;
      log(`  ! ${g.id}: ${(err as Error).message}`);
    }
  }

  const day: DayResults = { date, complete: missing === 0, races };
  await mkdir(resultsDir(scope), { recursive: true });
  await writeFile(fileFor(date, scope), JSON.stringify(day));
  log(
    `${date}: ${races.length} lopp` + (missing ? `, ${missing} utan resultat` : ""),
  );
  return day;
}
