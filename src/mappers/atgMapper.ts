import type {
  AtgExtendedStart,
  AtgHorse,
  AtgPastResult,
  AtgPerson,
  AtgRace,
  AtgRecord,
  AtgStart,
  AtgStatBlock,
  AtgTime,
} from "../types/atg.ts";
import type {
  PastStart,
  Person,
  RaceInput,
  Runner,
  Sport,
  StartMethod,
  StatLine,
} from "../types/domain.ts";
import type { ChartIndex } from "../clients/travsport.ts";
import { toNumber } from "../clients/travsport.ts";
import { blendStats, season, type Season } from "../scoring/season.ts";

export function toStartMethod(v: unknown): StartMethod {
  if (typeof v !== "string") return "unknown";
  const s = v.toLowerCase();
  if (s.startsWith("a")) return "auto";
  if (s.startsWith("v")) return "volte";
  return "unknown";
}

/**
 * ATG:s sport: "trot" och "monté" rankas, allt annat (galopp) ger null.
 * Saknas fältet räknas loppet som trav.
 */
export function toSport(v: unknown): Sport | null {
  if (v === undefined || v === null || v === "") return "trot";
  if (typeof v !== "string") return null;
  const s = v.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
  if (s === "trot") return "trot";
  if (s === "monte") return "monte";
  return null;
}

export function kmTimeToSec(t?: AtgTime | null): number | null {
  // En kod (t.ex. galopp) betyder att tiden inte är jämförbar.
  if (!t || typeof t.seconds !== "number" || t.code) return null;
  const sec = (t.minutes ?? 1) * 60 + t.seconds + (t.tenths ?? 0) / 10;
  // Rimlighetskoll för travkm-tider (ca 1.07–1.40)
  return sec > 60 && sec < 110 ? sec : null;
}

function statLine(b?: AtgStatBlock): StatLine {
  return {
    starts: b?.starts ?? 0,
    wins: b?.placement?.["1"] ?? 0,
    seconds: b?.placement?.["2"] ?? 0,
    thirds: b?.placement?.["3"] ?? 0,
    earnings: b?.earnings ?? 0,
  };
}

/** Senaste 12 månaderna: i år + viktad del av förra året (se scoring/season.ts). */
function seasonLine(
  years: Record<string, AtgStatBlock> | undefined,
  s: Season,
): StatLine {
  return blendStats(
    statLine(years?.[String(s.year)]),
    statLine(years?.[String(s.prevYear)]),
    s.prevWeight,
  );
}

function personName(p?: AtgPerson): string {
  return (
    [p?.firstName, p?.lastName].filter(Boolean).join(" ") ||
    p?.shortName ||
    "Okänd"
  );
}

function toPerson(
  p: AtgPerson | undefined,
  s: Season,
  chart?: ChartIndex,
): Person {
  const name = personName(p);
  const id = p?.id ?? null;
  return {
    id,
    name,
    year: seasonLine(p?.statistics?.years, s),
    chartRank: chart?.find(id, name)?.rank ?? null,
    chartSize: chart?.size ?? 0,
  };
}

function bestRecord(
  horse: AtgHorse | undefined,
  method: StartMethod,
): { sec: number | null; method: StartMethod } {
  const records: AtgRecord[] = [
    ...(horse?.statistics?.life?.records ?? []),
    ...(horse?.record ? [horse.record] : []),
  ];
  const parsed = records
    .map((r) => ({
      sec: kmTimeToSec(r.time),
      method: toStartMethod(r.startMethod),
    }))
    .filter((r): r is { sec: number; method: StartMethod } => r.sec !== null);
  const sameMethod = parsed.filter((r) => r.method === method);
  const pool = sameMethod.length ? sameMethod : parsed;
  if (!pool.length) return { sec: null, method: "unknown" };
  return pool.reduce((a, b) => (b.sec < a.sec ? b : a));
}

function pastResults(horse?: AtgHorse): AtgPastResult[] {
  const r = horse?.results;
  if (Array.isArray(r)) return r;
  return r?.records ?? r?.collection ?? [];
}

/** Svaret från /races/:id/start/ som uppslag på startnummer. */
export function indexByStartNumber(
  starts: AtgExtendedStart[] | null | undefined,
): Map<number, AtgExtendedStart> {
  const map = new Map<number, AtgExtendedStart>();
  for (const s of starts ?? []) {
    const nr = s.startNumber ?? s.number;
    if (typeof nr === "number") map.set(nr, s);
  }
  return map;
}

/** Amerikansk vagn? ATG anger kod ("VA" = vanlig) och text ("Amerikansk"). */
export function isAmericanSulky(code?: string, text?: string): boolean {
  return /^am/i.test(code ?? "") || /amerik/i.test(text ?? "");
}

/** Utrustningen i en tidigare start (`start.horse` i resultatposten, true = skodd). */
function pastGear(r: AtgPastResult): PastStart["gear"] {
  const shoes = r.start?.horse?.shoes;
  const sulky = r.start?.horse?.sulky?.type;
  if (
    typeof shoes?.front !== "boolean" ||
    typeof shoes?.back !== "boolean" ||
    !sulky
  )
    return null;
  return {
    frontShod: shoes.front,
    backShod: shoes.back,
    american: isAmericanSulky(sulky.code, sulky.text),
  };
}

export function toPastStart(r: AtgPastResult): PastStart {
  const placeNum = toNumber(r.place);
  const odds = toNumber(r.odds);
  return {
    date: (r.date ?? r.race?.date ?? null)?.slice(0, 10) ?? null,
    place: placeNum && placeNum > 0 ? placeNum : null,
    kmTimeSec: kmTimeToSec(r.kmTime),
    startMethod: toStartMethod(r.startMethod ?? r.race?.startMethod),
    sport: toSport(r.race?.sport) ?? "trot",
    // I /start/-svaret ligger distansen under `start` (hästens egen, inkl. tillägg).
    distance: r.start?.distance ?? r.distance ?? r.race?.distance ?? null,
    // Galopp syns antingen som flagga eller som "g" i km-tidens kod.
    galloped: Boolean(r.galloped) || /g/i.test(r.kmTime?.code ?? ""),
    disqualified: Boolean(r.disqualified),
    // ATG-odds anges i hundradelar (450 = 4.50)
    odds: odds ? (odds >= 100 ? odds / 100 : odds) : null,
    gear: pastGear(r),
  };
}

export interface MapContext {
  gameId?: string;
  gameType?: string;
  driverChart?: ChartIndex;
  trainerChart?: ChartIndex;
  /** Utökad startinfo per startnummer (från /races/:id/start/) */
  extended?: Map<number, AtgExtendedStart | null>;
  /**
   * Backtest: räkna bara med resultat FÖRE detta datum (yyyy-mm-dd), och ta
   * bara resultatlistan från den utökade infon – dess statistik är dagens,
   * inte tävlingsdagens, och skulle avslöja facit.
   */
  before?: string;
}

export function toRunner(
  start: AtgStart,
  race: AtgRace,
  ctx: MapContext,
): Runner {
  const ext = ctx.extended?.get(start.number) ?? undefined;
  // Den utökade hästen har mer data; slå ihop med spelets häst. I backtest
  // tas bara resultatlistan därifrån (se MapContext.before).
  const horse: AtgHorse = ctx.before
    ? { ...(start.horse ?? {}), results: ext?.horse?.results }
    : { ...(start.horse ?? {}), ...(ext?.horse ?? {}) };
  const s = season(race.date ?? race.startTime ?? new Date().toISOString());
  const method = toStartMethod(race.startMethod);
  const rec = bestRecord(horse, method);

  const sport = toSport(race.sport) ?? "trot";
  const past = pastResults(horse)
    // Strukna starter och galopplopp räknas inte. Trav och monté blandas –
    // faktorerna väger starter i den andra disciplinen lägre.
    .filter((r) => !r.scratched && toSport(r.race?.sport) !== null)
    .filter((r) => !ctx.before || (r.date ?? r.race?.date ?? "") < ctx.before)
    .map(toPastStart)
    .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));

  const winPool = start.pools?.["vinnare"];
  const gamePool = ctx.gameType ? start.pools?.[ctx.gameType] : undefined;
  const odds = toNumber(winPool?.odds);
  const dist = toNumber(gamePool?.betDistribution);

  return {
    startId: start.id ?? `${race.id}_${start.number}`,
    number: start.number,
    postPosition: start.postPosition ?? start.number,
    distance: start.distance ?? race.distance ?? 0,
    scratched: Boolean(start.scratched),

    horseId: horse.id ?? null,
    horseName: horse.name ?? `Nr ${start.number}`,
    age: horse.age ?? null,
    sex: horse.sex ?? null,

    horseYear: seasonLine(horse.statistics?.years, s),
    horseLife: statLine(horse.statistics?.life),
    recordKmSec: rec.sec,
    recordStartMethod: rec.method,
    past,

    driver: toPerson(start.driver ?? ext?.driver, s, ctx.driverChart),
    trainer: toPerson(horse.trainer, s, ctx.trainerChart),

    shoes: {
      reported: Boolean(horse.shoes?.reported ?? horse.shoes?.front),
      frontOff: horse.shoes?.front?.hasShoe === false,
      backOff: horse.shoes?.back?.hasShoe === false,
      frontChanged: Boolean(horse.shoes?.front?.changed),
      backChanged: Boolean(horse.shoes?.back?.changed),
    },
    // Ingen vagn i monté.
    sulky:
      sport === "monte"
        ? { american: false, changed: false }
        : {
            american: isAmericanSulky(
              horse.sulky?.type?.code,
              horse.sulky?.type?.text,
            ),
            changed: Boolean(horse.sulky?.type?.changed),
          },

    odds: odds ? odds / 100 : null,
    betDistribution: dist !== null ? dist / 100 : null,
  };
}

export function toRaceInput(race: AtgRace, ctx: MapContext): RaceInput {
  return {
    raceId: race.id,
    gameId: ctx.gameId,
    number: race.number,
    name: race.name ?? `Lopp ${race.number}`,
    date: (race.date ?? race.startTime ?? "").slice(0, 10),
    trackName: race.track?.name ?? "Okänd bana",
    distance: race.distance ?? 0,
    startMethod: toStartMethod(race.startMethod),
    sport: toSport(race.sport) ?? "trot",
    startTime: race.startTime ?? null,
    runners: (race.starts ?? []).map((s) => toRunner(s, race, ctx)),
  };
}
