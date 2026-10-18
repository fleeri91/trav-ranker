/**
 * Backtest: rankar avgjorda omgångar som om loppen inte vore körda, och
 * jämför med vem som faktiskt vann.
 *
 * Mot efterhandsdata:
 * - Hästarnas tidigare resultat räknas bara före loppets datum (pipeline `historical`).
 * - Statistiken i den utökade infon används inte (den är dagens).
 * - Kvar är ATG:s statistik i själva spelet. Om den är från tävlingsdagen eller
 *   dagens datum kontrolleras och redovisas (`snapshot`).
 */
import { atg } from "../clients/atg.ts";
import { toNumber } from "../clients/travsport.ts";
import type { ChartSource } from "../clients/charts.ts";
import { rankDay, raceDate } from "../pipeline.ts";
import type { ScoringConfig } from "../scoring/config.ts";
import type { ResultsHistory } from "../results/history.ts";
import type { AtgExtendedStart, AtgPastResult, AtgRace } from "../types/atg.ts";
import { evaluate, type BacktestReport, type EvalRace } from "./evaluate.ts";

export interface BacktestOptions {
  from: string;
  to: string;
  gameTypes: string[];
  config?: ScoringConfig;
  charts?: ChartSource;
  /** Resultatsamlingen för kusk- och tränarform. Default som i rankDay. */
  results?: ResultsHistory | null;
  log?: (m: string) => void;
}

export interface BacktestResult {
  from: string;
  to: string;
  gameTypes: string[];
  games: { id: string; date: string; races: number }[];
  /** Lopp där vinnaren inte gick att avgöra. */
  racesWithoutResult: number;
  /** Hästar vars årsstatistik i spelet har fler starter än resultatlistan före loppet visar. */
  snapshot: { horses: number; ahead: number };
  report: BacktestReport;
  /** Alla utvärderade lopp, för --fit. */
  races: EvalRace[];
}

/** Alla datum från och med `from` till och med `to` (yyyy-mm-dd). */
export function eachDay(from: string, to: string): string[] {
  const days: string[] = [];
  const end = Date.parse(`${to}T12:00:00Z`);
  for (let t = Date.parse(`${from}T12:00:00Z`); t <= end; t += 86_400_000) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  return days;
}

const recordsOf = (s: AtgExtendedStart): AtgPastResult[] => {
  const r = s.horse?.results;
  if (Array.isArray(r)) return r;
  return r?.records ?? r?.collection ?? [];
};

/**
 * Vinnaren: helst från hästarnas egna resultatlistor (verifierat format,
 * loppet finns med via race.id), annars från spelets `result`-fält.
 */
export function winnersOf(
  raceId: string,
  starts: AtgExtendedStart[],
  race?: AtgRace,
): number[] {
  const fromRecords = starts
    .filter((s) => {
      const rec = recordsOf(s).find((r) => r.race?.id === raceId);
      return toNumber(rec?.place) === 1 && !rec?.disqualified;
    })
    .map((s) => s.startNumber ?? s.number)
    .filter((n): n is number => typeof n === "number");
  if (fromRecords.length) return fromRecords;

  return (race?.starts ?? [])
    .filter(
      (s) =>
        !s.scratched &&
        toNumber(s.result?.place ?? s.result?.finishOrder) === 1,
    )
    .map((s) => s.number);
}

/** Jämför spelets årsstatistik med resultatlistan före loppet. */
function checkSnapshot(
  race: AtgRace | undefined,
  starts: AtgExtendedStart[],
  date: string,
  acc: { horses: number; ahead: number },
) {
  const year = date.slice(0, 4);
  for (const s of starts) {
    const nr = s.startNumber ?? s.number;
    const snapshot = race?.starts?.find((x) => x.number === nr)?.horse
      ?.statistics?.years?.[year]?.starts;
    if (typeof snapshot !== "number") continue;
    const before = recordsOf(s).filter(
      (r) =>
        !r.scratched &&
        (r.date ?? "").startsWith(year) &&
        (r.date ?? "") < date,
    ).length;
    acc.horses++;
    if (snapshot > before) acc.ahead++;
  }
}

export async function runBacktest(
  opts: BacktestOptions,
): Promise<BacktestResult> {
  const {
    from,
    to,
    gameTypes,
    config,
    charts = "atg",
    results,
    log = () => {},
  } = opts;
  const races: EvalRace[] = [];
  const games: BacktestResult["games"] = [];
  const snapshot = { horses: 0, ahead: 0 };
  let racesWithoutResult = 0;

  for (const date of eachDay(from, to)) {
    let ranked;
    try {
      ranked = await rankDay({
        date,
        gameTypes,
        historical: true,
        charts,
        config,
        results,
      });
    } catch (err) {
      log(`${date}: kunde inte hämtas (${(err as Error).message})`);
      continue;
    }
    for (const game of ranked) {
      const raw = await atg.game(game.gameId, { persist: true });
      let withResult = 0;
      for (const ranking of game.races) {
        const rawRace = raw.races?.find((r) => r.id === ranking.raceId);
        const starts = await atg.raceStarts(ranking.raceId, { persist: true });
        const day = rawRace ? raceDate(rawRace, date) : date;
        checkSnapshot(rawRace, starts, day, snapshot);
        const winners = winnersOf(ranking.raceId, starts, rawRace);
        if (!winners.length) {
          racesWithoutResult++;
          continue;
        }
        withResult++;
        races.push({
          raceId: ranking.raceId,
          date: day,
          sport: ranking.sport,
          winners,
          runners: ranking.runners,
        });
      }
      games.push({ id: game.gameId, date, races: withResult });
      log(
        `${date}  ${game.gameId}: ${withResult} av ${game.races.length} lopp med resultat`,
      );
    }
  }

  return {
    from,
    to,
    gameTypes,
    games,
    racesWithoutResult,
    snapshot,
    report: evaluate(races, { temperature: config?.probability.temperature }),
    races,
  };
}
