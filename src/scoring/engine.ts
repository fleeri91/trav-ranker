import type { RaceInput, Runner, Sport } from "../types/domain.ts";
import {
  DEFAULT_CONFIG,
  type FactorKey,
  type ScoringConfig,
} from "./config.ts";
import { FACTORS, type Normalization } from "./factors.ts";

export interface FactorResult {
  raw: number | null;
  /** 0–100 inom loppet. 50 (neutral) om data saknas. */
  score: number;
  weight: number;
  /** weight * score – faktorns bidrag till totalpoängen. */
  contribution: number;
}

export interface RankedRunner {
  rank: number;
  number: number;
  horseName: string;
  driverName: string;
  trainerName: string;
  /** Totalpoäng 0–100. */
  points: number;
  /** 0–1: hur stor del av vikterna som hade riktig data. */
  confidence: number;
  /** Modellens vinstsannolikhet (softmax över poängen). */
  winProbability: number;
  /** Marknadens sannolikhet (från odds, utan överrundning). */
  marketProbability: number | null;
  /** > 1 = modellen tror mer på hästen än marknaden. */
  value: number | null;
  odds: number | null;
  factors: Record<FactorKey, FactorResult>;
  notes: string[];
}

export interface RankedRace {
  raceId: string;
  number: number;
  name: string;
  trackName: string;
  distance: number;
  startMethod: string;
  sport: Sport;
  startTime: string | null;
  runners: RankedRunner[];
  scratched: number[];
  topList?: "all" | "stl";
  /** Sant om ryttarbonusen kommer från montétopplistan. */
  monteList?: boolean;
}

const NEUTRAL = 50;

function normalize(values: (number | null)[], n: Normalization): number[] {
  if (n.kind === "fixed") {
    return values.map((v) =>
      v === null
        ? NEUTRAL
        : Math.max(0, Math.min(100, ((v - n.min) / (n.max - n.min)) * 100)),
    );
  }
  const present = values.filter((v): v is number => v !== null);
  if (!present.length) return values.map(() => NEUTRAL);
  const min = Math.min(...present);
  const max = Math.max(...present);
  return values.map((v) => {
    if (v === null) return NEUTRAL;
    if (max === min) return NEUTRAL;
    return ((v - min) / (max - min)) * 100;
  });
}

function softmax(xs: number[], temperature: number): number[] {
  const m = Math.max(...xs);
  const exps = xs.map((x) => Math.exp((x - m) / temperature));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / sum);
}

export function scoreRace(
  race: RaceInput,
  cfg: ScoringConfig = DEFAULT_CONFIG,
): RankedRace {
  const active: Runner[] = race.runners.filter((r) => !r.scratched);
  const activeFactors = FACTORS.filter((f) => (cfg.weights[f.key] ?? 0) > 0);
  const totalWeight =
    activeFactors.reduce((s, f) => s + cfg.weights[f.key], 0) || 1;

  // 1. Råvärden + normalisering per faktor (inom loppet). Alla faktorer räknas,
  //    även de med vikt 0: de påverkar inte poängen, men backtest och --fit kan
  //    då pröva om de borde få vikt.
  const perFactor = new Map<
    FactorKey,
    { raw: (number | null)[]; score: number[] }
  >();
  for (const f of FACTORS) {
    const raw = active.map((r) => {
      const v = f.compute(r, race, cfg);
      return v !== null && Number.isFinite(v) ? v : null;
    });
    perFactor.set(f.key, { raw, score: normalize(raw, f.normalize) });
  }

  // 2. Viktad summa
  const scored = active.map((runner, i) => {
    const factors = {} as Record<FactorKey, FactorResult>;
    let points = 0;
    let presentWeight = 0;
    for (const f of FACTORS) {
      const weight = (cfg.weights[f.key] ?? 0) / totalWeight;
      const pf = perFactor.get(f.key);
      const raw = pf?.raw[i] ?? null;
      const score = pf?.score[i] ?? NEUTRAL;
      const contribution = weight * score;
      factors[f.key] = {
        raw,
        score: round(score),
        weight: round(weight, 3),
        contribution: round(contribution, 2),
      };
      points += contribution;
      if (raw !== null) presentWeight += weight;
    }
    const notes = activeFactors.flatMap(
      (f) => f.notes?.(runner, race, cfg) ?? [],
    );
    return { runner, factors, points, confidence: presentWeight, notes };
  });

  // 3. Sannolikheter
  const probs = softmax(
    scored.map((s) => s.points),
    cfg.probability.temperature,
  );
  const implied = scored.map((s) => (s.runner.odds ? 1 / s.runner.odds : null));
  const overround = implied.reduce<number>((a, b) => a + (b ?? 0), 0);
  const allPriced = implied.every((p) => p !== null) && overround > 0;

  const runners: RankedRunner[] = scored
    .map((s, i) => {
      const market = allPriced ? (implied[i] as number) / overround : null;
      const winProbability = probs[i] ?? 0;
      return {
        rank: 0,
        number: s.runner.number,
        horseName: s.runner.horseName,
        driverName: s.runner.driver.name,
        trainerName: s.runner.trainer.name,
        points: round(s.points, 1),
        confidence: round(s.confidence, 2),
        winProbability: round(winProbability, 4),
        marketProbability: market !== null ? round(market, 4) : null,
        value: market ? round(winProbability / market, 2) : null,
        odds: s.runner.odds,
        factors: s.factors,
        notes: s.notes,
      };
    })
    .sort((a, b) => b.points - a.points || a.number - b.number)
    .map((r, i) => ({ ...r, rank: i + 1 }));

  return {
    raceId: race.raceId,
    number: race.number,
    name: race.name,
    trackName: race.trackName,
    distance: race.distance,
    startMethod: race.startMethod,
    sport: race.sport,
    startTime: race.startTime,
    runners,
    scratched: race.runners.filter((r) => r.scratched).map((r) => r.number),
  };
}

function round(n: number, d = 1): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}
