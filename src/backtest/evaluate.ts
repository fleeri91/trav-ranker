/**
 * Mått för backtest: hur väl poängen förutsäger vinnaren. Ren funktion utan
 * nätverk, så den går att testa och återanvända.
 */
import type { RankedRunner } from "../scoring/engine.ts";
import type { Sport } from "../types/domain.ts";
import {
  DEFAULT_CONFIG,
  FACTOR_LABELS,
  type FactorKey,
} from "../scoring/config.ts";

export interface EvalRace {
  raceId: string;
  /** Tävlingsdag (yyyy-mm-dd), för att dela upp i tränings- och testomgångar. */
  date?: string;
  /** Trav eller monté. Saknas = trav. */
  sport?: Sport;
  /** Vinnarens startnummer (flera vid dött lopp). */
  winners: number[];
  runners: RankedRunner[];
}

export interface HitStats {
  races: number;
  /** Andel lopp där den högst rankade vann. */
  top1: number;
  /** Andel lopp där vinnaren fanns bland de tre högst rankade. */
  top3: number;
  /** Vinnarens genomsnittliga placering i rankingen (1 = bäst). */
  meanWinnerRank: number;
}

export interface Bets {
  bets: number;
  wins: number;
  /** Avkastning per insatt krona: 0,1 = +10 %, −0,2 = −20 %. */
  roi: number;
}

export interface BacktestReport {
  races: number;
  model: HitStats;
  /** Modellen utan faktorer som bygger på ATG:s statistik (kan innehålla efterhandsdata). */
  clean: HitStats;
  favorite: HitStats;
  random: HitStats;
  /** Modellen uppdelad per sport (bara sporter med lopp). */
  bySport: { sport: Sport; model: HitStats; random: HitStats }[];
  factors: {
    key: FactorKey;
    label: string;
    coverage: number;
    stats: HitStats;
  }[];
  logLoss: {
    races: number;
    model: number;
    clean: number;
    market: number;
  } | null;
  calibration: {
    label: string;
    runners: number;
    expected: number;
    observed: number;
  }[];
  topPickBets: Bets;
  valueBets: Bets & { threshold: number };
}

/** Faktorer som räknas på ATG:s statistik i spelet (år, karriär, kusk, tränare). */
export const SNAPSHOT_FACTORS: FactorKey[] = [
  "class",
  "winRate",
  "driver",
  "trainer",
];
export const VALUE_THRESHOLD = 1.15;

export const BUCKETS = [
  { label: "0–5 %", lo: 0, hi: 0.05 },
  { label: "5–10 %", lo: 0.05, hi: 0.1 },
  { label: "10–20 %", lo: 0.1, hi: 0.2 },
  { label: "20–35 %", lo: 0.2, hi: 0.35 },
  { label: "35–100 %", lo: 0.35, hi: 1.0001 },
];

const ordered = (runners: RankedRunner[], score: (r: RankedRunner) => number) =>
  [...runners].sort((a, b) => score(b) - score(a) || a.number - b.number);

/**
 * Vinnarens placering när hästarna ordnas efter `score`. Lika poäng delar på
 * placeringarna (som om de lottades), så att t.ex. en faktor där alla har 50
 * inte får träff bara för att startnummer 1 råkar stå först.
 * Ger förväntad etta-andel, topp 3-andel och placering, eller null om vinnaren saknas.
 */
function winnerOutcome(
  race: EvalRace,
  score: (r: RankedRunner) => number,
): { top1: number; top3: number; rank: number } | null {
  const winners = race.runners.filter((r) => race.winners.includes(r.number));
  if (!winners.length) return null;
  const best = Math.max(...winners.map(score));
  const higher = race.runners.filter((r) => score(r) > best).length;
  const tied = race.runners.filter((r) => score(r) === best).length;
  const tiedWinners = winners.filter((r) => score(r) === best).length;
  // Platserna higher+1 … higher+tied lottas; minst en av vinnarna hamnar på den bästa.
  const share = (limit: number) => {
    const slots = Math.max(0, Math.min(limit, higher + tied) - higher);
    return Math.min(1, (slots * tiedWinners) / tied);
  };
  return {
    top1: share(1),
    top3: share(3),
    rank: higher + (tied + 1) / (tiedWinners + 1),
  };
}

export function hitStats(
  races: EvalRace[],
  score: (r: RankedRunner) => number,
): HitStats {
  let n = 0;
  let top1 = 0;
  let top3 = 0;
  let rankSum = 0;
  for (const race of races) {
    const o = winnerOutcome(race, score);
    if (!o) continue;
    n++;
    top1 += o.top1;
    top3 += o.top3;
    rankSum += o.rank;
  }
  return n
    ? { races: n, top1: top1 / n, top3: top3 / n, meanWinnerRank: rankSum / n }
    : { races: 0, top1: 0, top3: 0, meanWinnerRank: 0 };
}

/** Vad en slumpvis rankning ger i snitt. */
function randomStats(races: EvalRace[]): HitStats {
  const valid = races.filter((r) => r.runners.length && r.winners.length);
  const n = valid.length || 1;
  const sum = (f: (size: number) => number) =>
    valid.reduce((s, r) => s + f(r.runners.length), 0) / n;
  return {
    races: valid.length,
    top1: sum((k) => 1 / k),
    top3: sum((k) => Math.min(3, k) / k),
    meanWinnerRank: sum((k) => (k + 1) / 2),
  };
}

export function softmax(xs: number[], temperature: number): number[] {
  const m = Math.max(...xs);
  const e = xs.map((x) => Math.exp((x - m) / temperature));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map((v) => v / s);
}

/** Totalpoäng räknad utan vissa faktorer (vikterna skalas om bland de övriga). */
export function pointsWithout(r: RankedRunner, excluded: FactorKey[]): number {
  let sum = 0;
  let weight = 0;
  for (const [key, f] of Object.entries(r.factors) as [
    FactorKey,
    RankedRunner["factors"][FactorKey],
  ][]) {
    if (excluded.includes(key) || f.weight <= 0) continue;
    sum += f.weight * f.score;
    weight += f.weight;
  }
  return weight ? sum / weight : 0;
}

/** Totalpoäng med andra vikter (faktorpoängen återanvänds, vikterna skalas till summa 1). */
export function pointsWith(
  r: RankedRunner,
  weights: Partial<Record<FactorKey, number>>,
): number {
  let sum = 0;
  let weight = 0;
  for (const [key, w] of Object.entries(weights) as [FactorKey, number][]) {
    const f = r.factors[key];
    if (!f || w <= 0) continue;
    sum += w * f.score;
    weight += w;
  }
  return weight ? sum / weight : 0;
}

export function bets(
  races: EvalRace[],
  pick: (race: EvalRace) => RankedRunner[],
): Bets {
  let n = 0;
  let wins = 0;
  let returned = 0;
  for (const race of races) {
    for (const r of pick(race)) {
      if (!r.odds) continue;
      n++;
      if (race.winners.includes(r.number)) {
        wins++;
        returned += r.odds;
      }
    }
  }
  return { bets: n, wins, roi: n ? (returned - n) / n : 0 };
}

export function evaluate(
  races: EvalRace[],
  opts: { temperature?: number; excluded?: FactorKey[] } = {},
): BacktestReport {
  const temperature =
    opts.temperature ?? DEFAULT_CONFIG.probability.temperature;
  const excluded = opts.excluded ?? SNAPSHOT_FACTORS;
  const valid = races.filter((r) => r.winners.length && r.runners.length);

  // Faktor för faktor: rangordna bara på faktorns poäng (även faktorer med vikt 0).
  const keys = (Object.keys(FACTOR_LABELS) as FactorKey[]).filter((k) =>
    valid.some((r) =>
      r.runners.some((h) => h.factors[k] && h.factors[k].raw !== null),
    ),
  );
  const factors = keys.map((key) => {
    const all = valid.flatMap((r) => r.runners);
    const withData = all.filter((h) => h.factors[key]?.raw !== null).length;
    return {
      key,
      label: FACTOR_LABELS[key],
      coverage: all.length ? withData / all.length : 0,
      stats: hitStats(valid, (h) => h.factors[key]?.score ?? 50),
    };
  });

  // Favoriten = lägst vinnarodds. En häst utan odds räknas som längst odds,
  // så att loppet ändå räknas (förut föll hela loppet bort).
  const priced = valid.filter((r) => r.runners.some((h) => h.odds));
  const favorite = hitStats(priced, (h) => -(h.odds ?? Infinity));

  // Log loss för vinnaren, på lopp där marknadens sannolikhet finns.
  const withMarket = valid.filter((r) =>
    r.runners.every((h) => h.marketProbability !== null),
  );
  let logLoss: BacktestReport["logLoss"] = null;
  if (withMarket.length) {
    let model = 0;
    let clean = 0;
    let market = 0;
    for (const race of withMarket) {
      const winner = race.winners[0];
      const idx = race.runners.findIndex((h) => h.number === winner);
      if (idx < 0) continue;
      const cleanProbs = softmax(
        race.runners.map((h) => pointsWithout(h, excluded)),
        temperature,
      );
      const ln = (p: number) => -Math.log(Math.max(p, 1e-6));
      model += ln(race.runners[idx]!.winProbability);
      clean += ln(cleanProbs[idx]!);
      market += ln(race.runners[idx]!.marketProbability ?? 0);
    }
    const n = withMarket.length;
    logLoss = {
      races: n,
      model: model / n,
      clean: clean / n,
      market: market / n,
    };
  }

  // Kalibrering: stämmer modellens vinstchanser med utfallet?
  const calibration = BUCKETS.map(({ label, lo, hi }) => {
    const inBucket = valid.flatMap((race) =>
      race.runners
        .filter((h) => h.winProbability >= lo && h.winProbability < hi)
        .map((h) => ({
          p: h.winProbability,
          won: race.winners.includes(h.number),
        })),
    );
    const n = inBucket.length;
    return {
      label,
      runners: n,
      expected: n ? inBucket.reduce((s, x) => s + x.p, 0) / n : 0,
      observed: n ? inBucket.filter((x) => x.won).length / n : 0,
    };
  });

  return {
    races: valid.length,
    model: hitStats(valid, (h) => h.points),
    clean: hitStats(valid, (h) => pointsWithout(h, excluded)),
    favorite,
    random: randomStats(valid),
    bySport: (["trot", "monte"] as const)
      .map((sport) => {
        const subset = valid.filter((r) => (r.sport ?? "trot") === sport);
        return {
          sport,
          model: hitStats(subset, (h) => h.points),
          random: randomStats(subset),
        };
      })
      .filter((s) => s.model.races > 0),
    factors,
    logLoss,
    calibration,
    topPickBets: bets(valid, (race) =>
      ordered(race.runners, (h) => h.points).slice(0, 1),
    ),
    valueBets: {
      threshold: VALUE_THRESHOLD,
      ...bets(valid, (race) =>
        race.runners.filter((h) => (h.value ?? 0) >= VALUE_THRESHOLD),
      ),
    },
  };
}
