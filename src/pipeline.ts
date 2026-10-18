import path from "node:path";
import { atg } from "./clients/atg.ts";
import { mapLimit } from "./clients/http.ts";
import {
  CHART_PRESETS,
  ChartIndex,
  fetchPersonChart,
} from "./clients/travsport.ts";
import {
  blendCharts,
  buildAtgCharts,
  loadSeasonChart,
  RACE_TYPE_OF,
  SULKY_OR_MONTE_OF,
  VARIANT_KINDS,
  VARIANT_TAG,
  type ChartKind,
  type ChartSource,
  type ChartVariant,
} from "./clients/charts.ts";
import {
  indexByStartNumber,
  toRaceInput,
  toSport,
} from "./mappers/atgMapper.ts";
import { DEFAULT_CONFIG, type ScoringConfig } from "./scoring/config.ts";
import { scoreRace, type RankedRace } from "./scoring/engine.ts";
import { season } from "./scoring/season.ts";
import {
  ALL_RACES,
  readAllDays,
  type ResultsScope,
} from "./results/collect.ts";
import { ResultsHistory } from "./results/history.ts";
import type {
  AtgExtendedStart,
  AtgGame,
  AtgPerson,
  AtgRace,
  AtgStart,
} from "./types/atg.ts";
import type { RaceInput, Sport } from "./types/domain.ts";

/** Spelformer med flera lopp. Övriga (vinnare, plats, trio…) är per lopp. */
export const MULTI_RACE_GAMES = [
  "V85",
  "V86",
  "GS75",
  "V65",
  "V64",
  "V5",
  "V4",
  "V3",
  "DD",
  "LD",
];

/**
 * Spelformer vars lopp körs i Svensk Travsports Travliga (STL). Deras lopp
 * rankas med STL-topplistorna (typeOfRace=R) när sådana finns.
 */
export const STL_GAME_TYPES = ["V85"];

export interface RankDayOptions {
  date: string;
  gameTypes?: string[];
  /** Ranka bara dessa spel-id (har företräde framför gameTypes). */
  gameIds?: string[];
  /** Hämta utökad startinfo (senaste resultat). Krävs för form/fart. */
  extended?: boolean;
  /**
   * Backtest av en avgjord dag: svaren sparas på disk, och varje lopp rankas
   * bara med resultat från före loppets datum.
   */
  historical?: boolean;
  /** Hur många lopp som hämtas samtidigt (ett ATG-anrop per lopp). */
  concurrency?: number;
  config?: ScoringConfig;
  /**
   * Källa för kusk-/tränartopplistor.
   * auto (default) = sparad fil i data/ om den finns, annars beräknad från ATG.
   */
  charts?: ChartSource;
  /** Vilka sporter som rankas. Default: både trav och monté. */
  sports?: readonly Sport[];
  /**
   * Resultatsamlingen för kusk- och tränarform. Default: alla svenska lopp
   * i data/results/all/ (läses en gång per process). null = använd inte.
   */
  results?: ResultsHistory | null;
  log?: (msg: string) => void;
}

export const SPORTS: readonly Sport[] = ["trot", "monte"];

export interface GameSummary {
  id: string;
  type: string;
  startTime: string | null;
  tracks: string[];
}

/** Dagens spel med flera lopp, sorterade på starttid – för val i dashboarden. */
export async function listGames(date: string): Promise<GameSummary[]> {
  const calendar = await atg.calendarDay(date);
  const trackName = new Map(
    (calendar.tracks ?? []).map((t) => [t.id, t.name ?? `Bana ${t.id}`]),
  );
  const multi = new Set(MULTI_RACE_GAMES);
  return Object.entries(calendar.games ?? {})
    .filter(([type]) => multi.has(type.toUpperCase()))
    .flatMap(([type, list]) =>
      (list ?? []).map((g) => ({
        id: g.id,
        type,
        startTime: g.startTime ?? null,
        tracks: (g.tracks ?? []).map((id) => trackName.get(id) ?? `Bana ${id}`),
      })),
    )
    .sort(
      (a, b) =>
        MULTI_RACE_GAMES.indexOf(a.type.toUpperCase()) -
          MULTI_RACE_GAMES.indexOf(b.type.toUpperCase()) ||
        (a.startTime ?? "").localeCompare(b.startTime ?? ""),
    );
}

export interface GameRanking {
  gameId: string;
  gameType: string;
  races: RankedRace[];
}

const LABELS: Record<ChartKind, string> = {
  drivers: "kuskar",
  trainers: "tränare",
};

const PERSON_OF: Record<ChartKind, (s: AtgStart) => AtgPerson | undefined> = {
  drivers: (s) => s.driver,
  trainers: (s) => s.horse?.trainer,
};

/** Hur många av dagens kuskar/tränare som hittas på topplistan – kontroll av namnmatchningen. */
function coverage(games: AtgGame[], chart: ChartIndex, kind: ChartKind) {
  const seen = new Map<string, { name: string; matched: boolean }>();
  for (const race of games.flatMap((g) => g.races ?? [])) {
    for (const start of race.starts ?? []) {
      const p = PERSON_OF[kind](start);
      const name = [p?.firstName, p?.lastName].filter(Boolean).join(" ");
      if (!p || !name) continue;
      seen.set(String(p.id ?? name), {
        name,
        matched: Boolean(chart.find(p.id ?? null, name)),
      });
    }
  }
  const all = [...seen.values()];
  return { matched: all.filter((x) => x.matched).length, total: all.length };
}

type ChartSet = Record<ChartKind, ChartIndex>;
type Loaded = {
  index: ChartIndex;
  from: "file" | "travsport" | "atg" | "fallback";
};

/**
 * Laddar kusk- och tränarlistor för en variant. För "stl" och "monte" faller
 * vi tillbaka på de allmänna listorna (fallback) om ingen egen lista finns.
 * Montévarianten har bara en ryttarlista; tränarna tas alltid från fallback.
 * `usedVariant` är sant om minst en lista faktiskt kom från varianten.
 */
async function loadCharts(
  source: ChartSource,
  games: AtgGame[],
  date: string,
  log: (m: string) => void,
  variant: ChartVariant = "all",
  fallback?: ChartSet,
): Promise<ChartSet & { usedVariant: boolean }> {
  if (source === "none")
    return {
      drivers: new ChartIndex(),
      trainers: new ChartIndex(),
      usedVariant: false,
    };

  const atgCharts = buildAtgCharts(games, date);
  const tag = VARIANT_TAG[variant];
  const s = season(date);

  const labelOf = (kind: ChartKind) =>
    variant === "monte" && kind === "drivers" ? "ryttare" : `${LABELS[kind]}${tag}`;

  const load = async (kind: ChartKind): Promise<Loaded> => {
    const label = labelOf(kind);

    if (source === "auto" || source === "file") {
      try {
        const fromFile = await loadSeasonChart(kind, variant, date, log);
        if (fromFile) {
          const names = fromFile.files.map((f) => path.basename(f)).join(" + ");
          log(`Topplista ${label}: ${fromFile.index.size} st från ${names}`);
          return { index: fromFile.index, from: "file" };
        }
        if (source === "file")
          log(
            `Topplista ${label}: inga sparade filer för ${s.year} eller ${s.prevYear}`,
          );
      } catch (err) {
        log(
          `Topplista ${label}: kunde inte läsa fil (${(err as Error).message})`,
        );
      }
    }

    if (source === "travsport") {
      try {
        const fetchYear = (year: number) =>
          fetchPersonChart(
            {
              ...CHART_PRESETS[kind],
              typeOfRace: RACE_TYPE_OF[variant],
              sulkyOrMonte: SULKY_OR_MONTE_OF[variant],
              year,
            },
            {
              onStale: (age, err) =>
                log(
                  `Topplista ${label} ${year}: kunde inte uppdateras (${(err as Error).message}) – använder sparad lista från ${Math.round(age / 3_600_000)} h sedan`,
                ),
            },
          );
        const current = await fetchYear(s.year);
        const previous = s.prevWeight > 0 ? await fetchYear(s.prevYear) : [];
        const entries = blendCharts(current, previous, s.prevWeight);
        if (entries.length) {
          log(`Topplista ${label}: ${entries.length} st från Travsport`);
          return { index: new ChartIndex(entries), from: "travsport" };
        }
      } catch (err) {
        log(
          `Topplista ${label}: Travsport gav ingen data (${(err as Error).message})`,
        );
      }
    }

    if (fallback) {
      log(`Topplista ${label}: ingen egen lista – använder den allmänna listan`);
      return { index: fallback[kind], from: "fallback" };
    }

    const fromAtg = atgCharts[kind];
    log(
      `Topplista ${label}: ${fromAtg.size} st beräknade från ATG (dagens startfält)`,
    );
    return { index: fromAtg, from: "atg" };
  };

  // Sekventiellt: skonsamt mot Travsport om live-källan används.
  const drivers = await load("drivers");
  let trainers: Loaded =
    !VARIANT_KINDS[variant].includes("trainers") && fallback
      ? { index: fallback.trainers, from: "fallback" }
      : await load("trainers");

  // Skydd: en tränarlista som är identisk med kusklistan är fel parameter/fel fil.
  if (
    (trainers.from === "file" || trainers.from === "travsport") &&
    trainers.index.sameAs(drivers.index)
  ) {
    log(
      `Topplista tränare${tag}: identisk med kusklistan (fel fil?) – använder ${fallback ? "den allmänna listan" : "ATG"}`,
    );
    trainers = fallback
      ? { index: fallback.trainers, from: "fallback" }
      : { index: atgCharts.trainers, from: "atg" };
  }

  for (const [kind, loaded] of [
    ["drivers", drivers],
    ["trainers", trainers],
  ] as const) {
    if (loaded.from !== "file" && loaded.from !== "travsport") continue;
    const c = coverage(games, loaded.index, kind);
    log(
      `Topplista ${labelOf(kind)}: ${c.matched} av ${c.total} i dagens fält finns på listan`,
    );
  }

  const fromVariant = (l: Loaded) =>
    l.from === "file" || l.from === "travsport";
  return {
    drivers: drivers.index,
    trainers: trainers.index,
    usedVariant: fromVariant(drivers) || fromVariant(trainers),
  };
}

/** Loppets datum (yyyy-mm-dd), med spelets datum som reserv. */
export function raceDate(race: AtgRace, fallback: string): string {
  return (race.date ?? race.startTime ?? fallback).slice(0, 10);
}

const historyLoads = new Map<string, Promise<ResultsHistory>>();
/** Resultatsamlingen från data/results/<scope>/, läst en gång per process. */
export function loadResultsHistory(
  scope: ResultsScope = ALL_RACES,
): Promise<ResultsHistory> {
  let load = historyLoads.get(scope);
  if (!load) {
    load = readAllDays(scope).then((days) => new ResultsHistory(days));
    historyLoads.set(scope, load);
  }
  return load;
}

/** Lägger på kusk- och tränarform från resultatsamlingen, före `before`. */
export function withRecent(
  input: RaceInput,
  history: ResultsHistory,
  before: string,
  trackId: number | undefined,
  cfg: ScoringConfig,
): RaceInput {
  const { recentForm, trackForm } = cfg;
  return {
    ...input,
    runners: input.runners.map((r) => ({
      ...r,
      recent: {
        driver: history.tally("driver", r.driver.id, before, recentForm.days),
        trainer: history.tally(
          "trainer",
          r.trainer.id,
          before,
          recentForm.days,
        ),
        driverTrack:
          trackId === undefined
            ? null
            : history.tally(
                "driver",
                r.driver.id,
                before,
                trackForm.days,
                trackId,
              ),
      },
    })),
  };
}

export async function rankDay(opts: RankDayOptions): Promise<GameRanking[]> {
  const {
    date,
    gameTypes = MULTI_RACE_GAMES,
    gameIds,
    extended = true,
    historical = false,
    concurrency = 3,
    config = DEFAULT_CONFIG,
    charts = "auto",
    sports = SPORTS,
    log = () => {},
  } = opts;
  const history =
    opts.results === undefined ? await loadResultsHistory() : opts.results;

  const fetchOpts = { persist: historical };
  const calendar = await atg.calendarDay(date, fetchOpts);
  const wanted = new Set(gameTypes.map((g) => g.toUpperCase()));
  const listed = Object.entries(calendar.games ?? {})
    .filter(([type]) => (gameIds ? true : wanted.has(type.toUpperCase())))
    .flatMap(([type, list]) => (list ?? []).map((g) => ({ type, id: g.id })))
    .filter((g) => !gameIds || gameIds.includes(g.id));

  log(
    `ATG: ${listed.length} spel ${date} (${[...new Set(listed.map((g) => g.type))].join(", ") || "–"})`,
  );
  if (!listed.length) return [];

  // 1. Hämta alla spel först – ATG-topplistan byggs av hela dagens startfält.
  const games = await mapLimit(listed, 2, async ({ id, type }) => ({
    type,
    game: await atg.game(id, fetchOpts),
  }));

  // 2. Topplistor: allmänna för alla lopp, STL-listor för lopp i STL-spel.
  // 2. Topplistor: allmänna för alla lopp, STL-listor för lopp i STL-spel.
  //    Årets och förra årets siffror vägs ihop till senaste 12 månaderna.
  const s = season(date);
  log(
    `Säsong: ${s.year}${s.prevWeight > 0 ? ` + ${Math.round(s.prevWeight * 100)} % av ${s.prevYear}` : ""}`,
  );
  const allCharts = await loadCharts(
    charts,
    games.map((g) => g.game),
    date,
    log,
  );

  // Dagens STL-spel hämtas även om bara t.ex. V5 valts: ett lopp kan ingå i
  // flera spel (V85 och V5) och ska rankas likadant oavsett vilket man tittar på.
  const stlIds = Object.entries(calendar.games ?? {})
    .filter(([type]) => STL_GAME_TYPES.includes(type.toUpperCase()))
    .flatMap(([, list]) => (list ?? []).map((g) => g.id));
  const stlGames = await mapLimit(
    stlIds,
    2,
    async (id) =>
      games.find((g) => g.game.id === id)?.game ?? atg.game(id, fetchOpts),
  );
  const stlRaceIds = new Set(
    stlGames.flatMap((g) => (g.races ?? []).map((r) => r.id)),
  );
  const wantStl =
    stlGames.length > 0 &&
    (charts === "auto" || charts === "file" || charts === "travsport");
  const stlCharts = wantStl
    ? await loadCharts(charts, stlGames, date, log, "stl", allCharts)
    : null;

  // Montélopp får en egen ryttarlista (sulkyOrMonte=M) när en sådan finns.
  const isMonte = (r: AtgRace) => toSport(r.sport) === "monte";
  const monteGames = games
    .map(({ game }) => ({
      ...game,
      races: (game.races ?? []).filter(isMonte),
    }))
    .filter((g) => g.races.length);
  const wantMonte =
    sports.includes("monte") &&
    monteGames.length > 0 &&
    (charts === "auto" || charts === "file" || charts === "travsport");
  const monteCharts = wantMonte
    ? await loadCharts(charts, monteGames, date, log, "monte", allCharts)
    : null;

  // 3. Ranka varje lopp en gång (samma lopp kan ingå i flera spel).
  const raceCache = new Map<string, Promise<RankedRace>>();

  const rankRace = (race: AtgRace, gameId: string, gameType: string) => {
    const cached = raceCache.get(race.id);
    if (cached) return cached;
    const job = (async () => {
      const stl = Boolean(stlCharts?.usedVariant && stlRaceIds.has(race.id));
      const monteList = Boolean(monteCharts?.usedVariant && isMonte(race));
      const base = stl && stlCharts ? stlCharts : allCharts;
      // Ryttare från montélistan, tränare som i övriga lopp (STL eller alla).
      const chartSet =
        monteList && monteCharts
          ? { drivers: monteCharts.drivers, trainers: base.trainers }
          : base;
      // Ett anrop per lopp ger hästarnas tidigare resultat för alla starter.
      let extendedByNumber = new Map<number, AtgExtendedStart>();
      if (extended) {
        try {
          extendedByNumber = indexByStartNumber(
            await atg.raceStarts(race.id, fetchOpts),
          );
        } catch (err) {
          log(
            `  ! utökad info saknas för lopp ${race.number} (${race.id}): ${(err as Error).message}`,
          );
        }
      }
      const parsed = toRaceInput(race, {
        gameId,
        gameType,
        driverChart: chartSet.drivers,
        trainerChart: chartSet.trainers,
        extended: extendedByNumber,
        before: historical ? raceDate(race, date) : undefined,
      });
      // Bara dagar före loppets datum, även live (dagens tidigare lopp räknas inte).
      const input = history?.size
        ? withRecent(
            parsed,
            history,
            raceDate(race, date),
            race.track?.id,
            config,
          )
        : parsed;
      return {
        ...scoreRace(input, config),
        topList: stl ? "stl" : "all",
        ...(monteList ? { monteList } : {}),
      } satisfies RankedRace;
    })();
    raceCache.set(race.id, job);
    return job;
  };

  return mapLimit(games, 2, async ({ type, game }) => {
    const ranked = (game.races ?? []).filter((r) => {
      const sport = toSport(r.sport);
      return sport !== null && sports.includes(sport);
    });
    const monte = ranked.filter(isMonte).length;
    log(
      `ATG: ${game.id} – ${ranked.length} lopp${monte ? ` (varav ${monte} monté)` : ""}`,
    );
    const races = await mapLimit(ranked, concurrency, (race) =>
      rankRace(race, game.id, type),
    );
    return { gameId: game.id, gameType: type, races };
  });
}
