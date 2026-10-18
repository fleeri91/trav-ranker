/**
 * Varje faktor returnerar ett RÅVÄRDE (högre = bättre) eller null om data
 * saknas. Motorn normaliserar sedan råvärdena till 0–100 inom loppet.
 */
import type {
  PastStart,
  Person,
  RaceInput,
  RecentTally,
  Runner,
  StatLine,
} from "../types/domain.ts";
import type { FactorKey, ScoringConfig } from "./config.ts";

export type Normalization =
  | { kind: "minmax" }
  | { kind: "fixed"; min: number; max: number };

export interface FactorDef {
  key: FactorKey;
  normalize: Normalization;
  compute(runner: Runner, race: RaceInput, cfg: ScoringConfig): number | null;
  /** Korta motiveringar som visas i UI ("Barfota runt om – första gången"). */
  notes?(runner: Runner, race: RaceInput, cfg: ScoringConfig): string[];
}

/** Lägsta chans Marknad skiljer på (odds 500). Längre odds räknas som detta. */
const MARKET_MIN_CHANCE = 0.002;

const shrink = (hits: number, n: number, prior: number, k: number) =>
  (hits + prior * k) / (n + k);

const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(a) - Date.parse(b)) / 86_400_000);

/** Standardiserar en km-tid till autostart med sulky på referensdistans. */
export function standardizeKm(
  sec: number,
  method: PastStart["startMethod"],
  distance: number | null,
  cfg: ScoringConfig,
  sport: PastStart["sport"] = "trot",
): number {
  let s = sec;
  if (method === "volte") s -= cfg.speed.volteSecPerKm;
  if (sport === "monte") s -= cfg.speed.monteSecPerKm;
  if (distance)
    s -=
      ((distance - cfg.speed.referenceDistance) / 100) *
      cfg.speed.secPerKmPer100m;
  return s;
}

function personScore(p: Person, cfg: ScoringConfig): number | null {
  if (p.year.starts === 0 && p.chartRank === null) return null;
  const win = shrink(
    p.year.wins,
    p.year.starts,
    cfg.shrinkage.priorWin,
    cfg.shrinkage.personK,
  );
  const top3 = shrink(
    p.year.wins + p.year.seconds + p.year.thirds,
    p.year.starts,
    cfg.shrinkage.priorTop3,
    cfg.shrinkage.personK,
  );
  const chartBonus =
    p.chartRank !== null && p.chartSize > 0
      ? cfg.chart.maxBonus * Math.max(0, 1 - (p.chartRank - 1) / p.chartSize)
      : 0;
  return win * 70 + top3 * 30 + chartBonus;
}

/** Segrar och topp 3 ur resultatsamlingen, krympta mot snittet. */
function recentScore(
  t: RecentTally | null | undefined,
  k: number,
  cfg: ScoringConfig,
): number | null {
  if (!t) return null;
  const { priorWin, priorTop3 } = cfg.shrinkage;
  return (
    0.6 * shrink(t.wins, t.starts, priorWin, k) +
    0.4 * shrink(t.top3, t.starts, priorTop3, k)
  );
}

function ratesFor(line: StatLine) {
  return {
    n: line.starts,
    wins: line.wins,
    top3: line.wins + line.seconds + line.thirds,
  };
}

/** Poäng för en tidigare start: placering plus avdrag för galopp/diskning (samma som formen). */
export function startPoints(p: PastStart, cfg: ScoringConfig): number {
  let pts = p.place ? (cfg.form.placementPoints[p.place - 1] ?? 0) : 0;
  if (p.galloped) pts += cfg.form.gallopPenalty;
  if (p.disqualified) pts += cfg.form.disqPenalty;
  return pts;
}

type KnownGear = PastStart & { gear: NonNullable<PastStart["gear"]> };
const hasGear = (p: PastStart): p is KnownGear => p.gear !== null;

/** Dagens utrustning, eller null om skorna inte är rapporterade. */
function todayGear(r: Runner) {
  if (!r.shoes.reported) return null;
  return {
    frontShod: !r.shoes.frontOff,
    backShod: !r.shoes.backOff,
    american: r.sulky.american,
  };
}

const sameGear = (
  a: NonNullable<PastStart["gear"]>,
  b: NonNullable<ReturnType<typeof todayGear>>,
) =>
  a.frontShod === b.frontShod &&
  a.backShod === b.backShod &&
  a.american === b.american;

/** Tidigare starter med exakt samma skor och vagn som i dag (senaste först). */
function startsWithTodaysGear(r: Runner, cfg: ScoringConfig) {
  const today = todayGear(r);
  if (!today) return null;
  const history = r.past.slice(0, cfg.gear.lookback).filter(hasGear);
  const matching = history
    .filter((p) => sameGear(p.gear, today))
    .slice(0, cfg.gear.maxMatches);
  return { today, history, matching };
}

interface FirstTimes {
  barefootAround: boolean;
  barefootFront: boolean;
  barefootBack: boolean;
  american: boolean;
  /** true = avgjort ur historiken, false = bara ATG:s "ändrat sedan förra starten". */
  fromHistory: boolean;
}

/** Vilken utrustning hästen har i dag som den aldrig haft förut. */
export function firstTimeGear(
  r: Runner,
  cfg: ScoringConfig,
): FirstTimes | null {
  const today = todayGear(r);
  if (!today) return null;
  const known = r.past.filter(hasGear);
  if (known.length >= cfg.gear.minHistory) {
    const ever = (f: (g: KnownGear["gear"]) => boolean) =>
      known.some((p) => f(p.gear));
    return {
      barefootAround:
        !today.frontShod &&
        !today.backShod &&
        !ever((g) => !g.frontShod && !g.backShod),
      barefootFront: !today.frontShod && !ever((g) => !g.frontShod),
      barefootBack: !today.backShod && !ever((g) => !g.backShod),
      american: today.american && !ever((g) => g.american),
      fromHistory: true,
    };
  }
  // För kort historik: ATG:s flagga säger bara "ändrat sedan förra starten".
  return {
    barefootAround:
      r.shoes.frontOff &&
      r.shoes.backOff &&
      (r.shoes.frontChanged || r.shoes.backChanged),
    barefootFront: r.shoes.frontOff && r.shoes.frontChanged,
    barefootBack: r.shoes.backOff && r.shoes.backChanged,
    american: r.sulky.american && r.sulky.changed,
    fromHistory: false,
  };
}

export const FACTORS: FactorDef[] = [
  {
    key: "form",
    normalize: { kind: "minmax" },
    compute(r, race, cfg) {
      const recent = r.past.slice(0, cfg.form.recencyWeights.length);
      if (!recent.length) return null;
      let sum = 0;
      let wsum = 0;
      recent.forEach((p, i) => {
        // Starter i den andra disciplinen (monté/sulky) säger mindre om dagens lopp.
        const sportWeight =
          race.sport && p.sport && p.sport !== race.sport
            ? cfg.form.crossSportWeight
            : 1;
        const w = (cfg.form.recencyWeights[i] ?? 0) * sportWeight;
        sum += w * startPoints(p, cfg);
        wsum += w;
      });
      return wsum ? sum / wsum : null;
    },
    notes(r, race) {
      const last = r.past.slice(0, 5);
      const out: string[] = [];
      const gallops = last.filter((p) => p.galloped || p.disqualified).length;
      if (gallops >= 2)
        out.push(`Galopp/diskning i ${gallops} av senaste ${last.length}`);
      if (last[0]?.place === 1) out.push("Vann senast");
      if (
        race.sport === "monte" &&
        r.past.length &&
        !r.past.some((p) => p.sport === "monte")
      )
        out.push("Montédebut");
      return out;
    },
  },
  {
    key: "speed",
    normalize: { kind: "minmax" },
    compute(r, _race, cfg) {
      const recent = r.past
        .slice(0, cfg.speed.lookback)
        .filter((p) => p.kmTimeSec !== null && !p.galloped && !p.disqualified)
        .map((p) =>
          standardizeKm(
            p.kmTimeSec as number,
            p.startMethod,
            p.distance,
            cfg,
            p.sport,
          ),
        );
      const recentBest = recent.length ? Math.min(...recent) : null;
      const record =
        r.recordKmSec !== null
          ? standardizeKm(r.recordKmSec, r.recordStartMethod, null, cfg)
          : null;
      if (recentBest === null && record === null) return null;
      const w = cfg.speed.recentWeight;
      const blended =
        recentBest !== null && record !== null
          ? w * recentBest + (1 - w) * record
          : ((recentBest ?? record) as number);
      return -blended; // snabbare tid = högre värde
    },
  },
  {
    key: "class",
    normalize: { kind: "minmax" },
    compute(r) {
      const perStart = (l: StatLine) =>
        l.starts > 0 ? l.earnings / l.starts : null;
      const y = perStart(r.horseYear);
      const l = perStart(r.horseLife);
      if (y === null && l === null) return null;
      // log dämpar stjärnhästar så de inte trycker ihop resten av fältet
      const ly = y !== null ? Math.log1p(y) : null;
      const ll = l !== null ? Math.log1p(l) : null;
      return ly !== null && ll !== null
        ? 0.6 * ly + 0.4 * ll
        : ((ly ?? ll) as number);
    },
  },
  {
    key: "winRate",
    normalize: { kind: "minmax" },
    compute(r, _race, cfg) {
      const line = r.horseYear.starts >= 3 ? r.horseYear : r.horseLife;
      const { n, wins, top3 } = ratesFor(line);
      if (n === 0) return null;
      const { horseK, priorWin, priorTop3 } = cfg.shrinkage;
      return (
        0.6 * shrink(wins, n, priorWin, horseK) +
        0.4 * shrink(top3, n, priorTop3, horseK)
      );
    },
  },
  {
    key: "driver",
    normalize: { kind: "minmax" },
    compute: (r, _race, cfg) => personScore(r.driver, cfg),
    notes: (r, race) =>
      r.driver.chartRank !== null && r.driver.chartRank <= 10
        ? [
            `Topp-10 ${race.sport === "monte" ? "ryttare" : "kusk"} (#${r.driver.chartRank})`,
          ]
        : [],
  },
  {
    key: "trainer",
    normalize: { kind: "minmax" },
    compute: (r, _race, cfg) => personScore(r.trainer, cfg),
    notes: (r) =>
      r.trainer.chartRank !== null && r.trainer.chartRank <= 10
        ? [`Topp-10 tränare (#${r.trainer.chartRank})`]
        : [],
  },
  {
    key: "position",
    normalize: { kind: "fixed", min: 0, max: 10 },
    compute(r, race, cfg) {
      const table =
        race.startMethod === "volte" ? cfg.position.volte : cfg.position.auto;
      const base = table[r.postPosition] ?? cfg.position.fallback;
      const handicap = Math.max(0, r.distance - race.distance);
      return base - (handicap / 20) * cfg.position.handicapPer20m;
    },
    notes(r, race) {
      const handicap = r.distance - race.distance;
      return handicap > 0 ? [`${handicap} m tillägg`] : [];
    },
  },
  {
    // Hur hästen har gått med exakt dagens skor och vagn, krympt mot hästens
    // snitt så att 1–2 starter inte väger för tungt. Saknas = ny utrustning.
    key: "gearForm",
    normalize: { kind: "minmax" },
    compute(r, _race, cfg) {
      const g = startsWithTodaysGear(r, cfg);
      if (!g || !g.matching.length) return null;
      const all = g.history.map((p) => startPoints(p, cfg));
      const avgAll = all.reduce((a, b) => a + b, 0) / all.length;
      const sum = g.matching.reduce((s, p) => s + startPoints(p, cfg), 0);
      const k = cfg.gear.shrinkK;
      return (sum + k * avgAll) / (g.matching.length + k);
    },
    notes(r, _race, cfg) {
      const g = startsWithTodaysGear(r, cfg);
      if (!g || !g.matching.length) return [];
      const label = [
        !g.today.frontShod && !g.today.backShod
          ? "Barfota runt om"
          : !g.today.frontShod
            ? "Barfota fram"
            : !g.today.backShod
              ? "Barfota bak"
              : "",
        g.today.american ? "amerikansk vagn" : "",
      ]
        .filter(Boolean)
        .join(", ");
      if (!label) return [];
      const n = g.matching.length;
      const wins = g.matching.filter((p) => p.place === 1).length;
      const top3 = g.matching.filter(
        (p) => p.place !== null && p.place <= 3,
      ).length;
      const winText = wins === 1 ? "1 seger" : `${wins} segrar`;
      return [
        `${label[0]!.toUpperCase()}${label.slice(1)}: ${winText}, ${top3} topp 3 på ${n} starter så`,
      ];
    },
  },
  {
    // Bonus för utrustning hästen aldrig haft förut (avgjort ur historiken).
    key: "gearChange",
    normalize: { kind: "fixed", min: 0, max: 6 },
    compute(r, _race, cfg) {
      const f = firstTimeGear(r, cfg);
      if (!f) return 0;
      const c = cfg.gear;
      let v = 0;
      if (f.barefootAround) v += c.firstBarefootAround;
      else {
        if (f.barefootFront) v += c.firstBarefootOneEnd;
        if (f.barefootBack) v += c.firstBarefootOneEnd;
      }
      if (f.american) v += c.firstAmerican;
      return f.fromHistory ? v : v * c.changedOnlyShare;
    },
    notes(r, _race, cfg) {
      const f = firstTimeGear(r, cfg);
      if (!f) return [];
      const when = f.fromHistory
        ? "för första gången"
        : "ändrat sedan förra starten";
      const out: string[] = [];
      if (f.barefootAround) out.push(`Barfota runt om ${when}`);
      else {
        if (f.barefootFront) out.push(`Barfota fram ${when}`);
        if (f.barefootBack) out.push(`Barfota bak ${when}`);
      }
      if (f.american) out.push(`Amerikansk vagn ${when}`);
      return out;
    },
  },
  {
    key: "freshness",
    normalize: { kind: "fixed", min: 0, max: 10 },
    compute(r, race, cfg) {
      const last = r.past[0]?.date;
      if (!last || !race.date) return null;
      const d = daysBetween(race.date, last);
      const f = cfg.freshness;
      if (d < 0) return null;
      if (d >= f.idealMinDays && d <= f.idealMaxDays) return 10;
      if (d < f.idealMinDays) return 7;
      if (d <= f.longLayoffDays)
        return (
          10 - ((d - f.idealMaxDays) / (f.longLayoffDays - f.idealMaxDays)) * 4
        );
      return 3;
    },
    notes(r, race) {
      const last = r.past[0]?.date;
      if (!last || !race.date) return [];
      const d = daysBetween(race.date, last);
      return d > 90 ? [`Comeback efter ${d} dagar`] : [];
    },
  },
  {
    // Kuskens form just nu: senaste veckornas lopp, alla svenska banor.
    key: "driverForm",
    normalize: { kind: "fixed", min: 0, max: 0.5 },
    compute: (r, _race, cfg) => recentScore(r.recent?.driver, cfg.recentForm.k, cfg),
  },
  {
    // Stallform: tränarens lopp senaste månaden. Ett stall i slag vinner ofta
    // flera lopp i rad.
    key: "trainerForm",
    normalize: { kind: "fixed", min: 0, max: 0.5 },
    compute: (r, _race, cfg) =>
      recentScore(r.recent?.trainer, cfg.stableForm.k, cfg),
  },
  {
    key: "driverTrack",
    normalize: { kind: "fixed", min: 0, max: 0.5 },
    compute: (r, _race, cfg) =>
      recentScore(r.recent?.driverTrack, cfg.trackForm.k, cfg),
  },
  {
    key: "market",
    // Log-chans på en fast skala: då ger rätt vikt exakt oddsens chanser (softmax
    // tar bort det som är lika för alla i loppet). Minmax per lopp kunde inte det.
    normalize: { kind: "fixed", min: Math.log(MARKET_MIN_CHANCE), max: 0 },
    compute(r) {
      const p = r.odds
        ? 1 / r.odds
        : r.betDistribution
          ? r.betDistribution / 100
          : null;
      return p !== null ? Math.log(Math.max(p, MARKET_MIN_CHANCE)) : null;
    },
  },
];
