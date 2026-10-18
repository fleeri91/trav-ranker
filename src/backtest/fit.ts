/**
 * --fit: anpassar vikter och temperatur efter avgjorda lopp, och mäter
 * resultatet på senare omgångar som anpassningen inte har sett.
 *
 * Modellen är en "conditional logit": vinstchans = softmax(Σ βₖ · faktorpoängₖ/100).
 * Vikterna och temperaturen är samma sak uttryckt annorlunda:
 *   temperatur = 100 / Σβ,  vikt k = βₖ / Σβ.
 * Målet (log loss för vinnaren) är konvext, så anpassningen hittar ett entydigt
 * bästa värde. β hålls ≥ 0 (en faktor kan inte straffa det den mäter), och dras
 * mot de nuvarande vikterna så att få lopp inte ger extrema vikter.
 */
import type { RankedRunner } from "../scoring/engine.ts";
import {
  FACTOR_LABELS,
  type FactorKey,
  type ScoringConfig,
} from "../scoring/config.ts";
import {
  BUCKETS,
  bets,
  hitStats,
  pointsWith,
  softmax,
  VALUE_THRESHOLD,
  type Bets,
  type EvalRace,
  type HitStats,
} from "./evaluate.ts";

/**
 * Hur hårt vikterna dras mot utgångsläget. Högre = försiktigare anpassning.
 * Hålls lågt: marknaden på log-skala behöver stora vikter för att kunna
 * återskapa oddsen, och en hög regularisering hindrade det.
 */
export const FIT_REGULARIZATION = 0.002;

type Weights = Partial<Record<FactorKey, number>>;

type Variant = "current" | "recalibrated" | "marketOnly" | "fitted";

/** Skillnad i log loss lopp för lopp (a − b), med medelfel. */
export interface Paired {
  diff: number;
  se: number;
  races: number;
}

export function paired(a: (number | null)[], b: (number | null)[]): Paired | null {
  const d: number[] = [];
  a.forEach((x, i) => {
    const y = b[i];
    if (x !== null && y !== null && y !== undefined) d.push(x - y);
  });
  const n = d.length;
  if (n < 2) return null;
  const mean = d.reduce((s, v) => s + v, 0) / n;
  const variance = d.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1);
  return { diff: mean, se: Math.sqrt(variance / n), races: n };
}

export interface ModelEval extends HitStats {
  logLoss: number;
}

export interface FitResult {
  train: { races: number; rounds: number; until: string };
  test: { races: number; rounds: number; from: string };
  keys: FactorKey[];
  current: { weights: Weights; temperature: number };
  /** Nuvarande vikter, bara temperaturen anpassad. */
  recalibrated: { weights: Weights; temperature: number };
  /** Bara marknaden, kalibrerad. null om marknaden inte ingår (--no-market). */
  marketOnly: { weights: Weights; temperature: number } | null;
  fitted: { weights: Weights; temperature: number };
  /** Allt nedan gäller testomgångarna. */
  results: {
    current: ModelEval;
    recalibrated: ModelEval;
    marketOnly: ModelEval | null;
    fitted: ModelEval;
    favorite: HitStats;
    marketLogLoss: number | null;
  };
  /**
   * Log loss mot oddsen, lopp för lopp på samma testlopp. Negativt = bättre än
   * oddsen. null om inga testlopp har odds för alla hästar.
   */
  vsMarket: Record<Variant, Paired | null> | null;
  /**
   * Bäst på testomgångarna (lägst log loss). "current" om inget av alternativen
   * är tydligt bättre: minst 0,01 lägre log loss och mer än två medelfel,
   * lopp för lopp mot de nuvarande värdena.
   */
  recommended: Variant;
  /** Kalibrering och spel gäller det rekommenderade alternativet. */
  calibration: {
    label: string;
    runners: number;
    expected: number;
    observed: number;
  }[];
  topPickBets: Bets;
  valueBets: Bets & { threshold: number };
}

interface Features {
  x: number[][]; // hästar × faktorer, 0–1
  winner: number;
}

function features(race: EvalRace, keys: FactorKey[]): Features | null {
  const winner = race.runners.findIndex((r) => r.number === race.winners[0]);
  if (winner < 0) return null;
  return {
    x: race.runners.map((r) =>
      keys.map((k) => (r.factors[k]?.score ?? 50) / 100),
    ),
    winner,
  };
}

function logLossAndGrad(data: Features[], beta: number[], withGrad: boolean) {
  const grad = new Array<number>(beta.length).fill(0);
  let loss = 0;
  for (const { x, winner } of data) {
    const z = x.map((row) => row.reduce((s, v, k) => s + v * beta[k]!, 0));
    const m = Math.max(...z);
    const e = z.map((v) => Math.exp(v - m));
    const sum = e.reduce((a, b) => a + b, 0);
    loss += -(z[winner]! - m - Math.log(sum));
    if (withGrad) {
      for (let i = 0; i < x.length; i++) {
        const p = e[i]! / sum;
        for (let k = 0; k < beta.length; k++) grad[k]! += p * x[i]![k]!;
      }
      for (let k = 0; k < beta.length; k++) grad[k]! -= x[winner]![k]!;
    }
  }
  const n = data.length || 1;
  return { loss: loss / n, grad: grad.map((g) => g / n) };
}

/** β ≥ 0 som minimerar log loss + regularisering mot β0 (projicerad gradientmetod). */
export function fitBeta(
  data: Features[],
  beta0: number[],
  lambda = FIT_REGULARIZATION,
): number[] {
  const objective = (b: number[]) => {
    const { loss, grad } = logLossAndGrad(data, b, true);
    const reg =
      b.reduce((s, v, k) => s + (v - beta0[k]!) ** 2, 0) * (lambda / 2);
    return {
      value: loss + reg,
      grad: grad.map((g, k) => g + lambda * (b[k]! - beta0[k]!)),
    };
  };
  let beta = beta0.slice();
  let current = objective(beta);
  let step = 1;
  for (let iter = 0; iter < 3000 && step > 1e-6; iter++) {
    const candidate = beta.map((b, k) =>
      Math.max(0, b - step * current.grad[k]!),
    );
    const next = objective(candidate);
    if (next.value <= current.value) {
      const improved = current.value - next.value;
      beta = candidate;
      current = next;
      step *= 1.2;
      if (improved < 1e-10) break;
    } else {
      step /= 2;
    }
  }
  return beta;
}

/** Bästa skalfaktor c för fasta vikter (bara temperaturen), med gyllene snittet. */
function fitScale(data: Features[], direction: number[]): number {
  const f = (c: number) =>
    logLossAndGrad(
      data,
      direction.map((d) => d * c),
      false,
    ).loss;
  let lo = 0.01;
  let hi = 30;
  const g = (Math.sqrt(5) - 1) / 2;
  for (let i = 0; i < 80; i++) {
    const a = hi - g * (hi - lo);
    const b = lo + g * (hi - lo);
    if (f(a) < f(b)) hi = b;
    else lo = a;
  }
  return (lo + hi) / 2;
}

const toBeta = (keys: FactorKey[], weights: Weights, temperature: number) => {
  const total = keys.reduce((s, k) => s + (weights[k] ?? 0), 0) || 1;
  return keys.map((k) => ((weights[k] ?? 0) / total) * (100 / temperature));
};

const fromBeta = (keys: FactorKey[], beta: number[]) => {
  const sum = beta.reduce((a, b) => a + b, 0);
  const weights: Weights = {};
  keys.forEach((k, i) => (weights[k] = sum ? beta[i]! / sum : 0));
  return { weights, temperature: sum ? 100 / sum : Infinity };
};

/** Log loss för vinnaren per lopp, null om vinnaren saknas. */
function raceLosses(
  races: EvalRace[],
  weights: Weights,
  temperature: number,
): (number | null)[] {
  return races.map((race) => {
    const idx = race.runners.findIndex((r) => r.number === race.winners[0]);
    if (idx < 0) return null;
    const points = race.runners.map((r) => pointsWith(r, weights));
    const p = softmax(points, temperature);
    return -Math.log(Math.max(p[idx]!, 1e-6));
  });
}

/** Oddsens log loss per lopp, null om något pris saknas. */
function marketLosses(races: EvalRace[]): (number | null)[] {
  return races.map((race) => {
    if (!race.runners.every((h) => h.marketProbability !== null)) return null;
    const w = race.runners.find((h) => h.number === race.winners[0]);
    if (!w) return null;
    return -Math.log(Math.max(w.marketProbability ?? 0, 1e-6));
  });
}

const mean = (xs: (number | null)[]) => {
  const v = xs.filter((x): x is number => x !== null);
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0;
};

function evalModel(
  races: EvalRace[],
  weights: Weights,
  temperature: number,
): ModelEval & { losses: (number | null)[] } {
  const losses = raceLosses(races, weights, temperature);
  const score = (r: RankedRunner) => pointsWith(r, weights);
  return { ...hitStats(races, score), logLoss: mean(losses), losses };
}

/** Utan per-lopp-listan, så att --json inte blir enormt. */
const summary = ({ losses: _, ...e }: ModelEval & { losses: unknown }) => e;

/** Delar upp per tävlingsdag: de tidiga omgångarna tränar, de senaste testar. */
export function splitByDate(races: EvalRace[], holdout: number) {
  const dates = [...new Set(races.map((r) => r.date ?? ""))].sort();
  const trainCount = Math.max(
    1,
    Math.min(dates.length - 1, Math.round(dates.length * (1 - holdout))),
  );
  const trainDates = new Set(dates.slice(0, trainCount));
  return {
    train: races.filter((r) => trainDates.has(r.date ?? "")),
    test: races.filter((r) => !trainDates.has(r.date ?? "")),
    trainDates: dates.slice(0, trainCount),
    testDates: dates.slice(trainCount),
  };
}

export interface Ablation {
  without: FactorKey[];
  /**
   * Log loss med alla faktorer minus utan `without`, lopp för lopp på
   * testloppen (båda anpassade). Negativt = faktorerna hjälper.
   */
  diff: Paired | null;
}

/**
 * Hjälper `without`? Anpassar en gång till utan dem och jämför med `full`
 * (resultatet av fitBacktest med samma lopp och inställningar).
 */
export function compareWithout(
  races: EvalRace[],
  config: ScoringConfig,
  holdout: number,
  excluded: FactorKey[],
  without: FactorKey[],
  full: FitResult,
): Ablation {
  const { test } = splitByDate(races, holdout);
  const reduced = fitBacktest(races, config, holdout, [
    ...excluded,
    ...without,
  ]).fitted;
  return {
    without,
    diff: paired(
      raceLosses(test, full.fitted.weights, full.fitted.temperature),
      raceLosses(test, reduced.weights, reduced.temperature),
    ),
  };
}

/**
 * @param excluded Faktorer som inte ska få vikt (t.ex. Marknad med --no-market).
 *   Alla andra prövas, även de som har vikt 0 i dag.
 */
export function fitBacktest(
  races: EvalRace[],
  config: ScoringConfig,
  holdout = 0.3,
  excluded: FactorKey[] = [],
): FitResult {
  const { train, test, trainDates, testDates } = splitByDate(races, holdout);
  if (train.length < 20 || test.length < 10) {
    throw new Error(
      `För få lopp för --fit (${train.length} att träna på, ${test.length} att testa på). Välj ett tidigare --from.`,
    );
  }

  // Alla faktorer utom de uttryckligen uteslutna. En faktor med vikt 0 i dag
  // börjar på 0 men kan få vikt om datan visar att den hjälper.
  const keys = (Object.keys(FACTOR_LABELS) as FactorKey[]).filter(
    (k) => !excluded.includes(k),
  );
  const data = train
    .map((r) => features(r, keys))
    .filter((f): f is Features => f !== null);

  const current = {
    weights: Object.fromEntries(
      keys.map((k) => [k, config.weights[k] ?? 0]),
    ) as Weights,
    temperature: config.probability.temperature,
  };
  const currentBeta = toBeta(keys, current.weights, current.temperature);

  const trainLoss = (beta: number[]) =>
    logLossAndGrad(data, beta, false).loss;

  // 1. Bara temperaturen.
  const recalibratedBeta = currentBeta.map(
    (b) => b * fitScale(data, currentBeta),
  );
  const recalibrated = fromBeta(keys, recalibratedBeta);

  // 2. Bara marknaden, kalibrerad (om den ingår).
  const marketIdx = keys.indexOf("market");
  const marketDirection = keys.map((_, i) => (i === marketIdx ? 1 : 0));
  const marketBeta =
    marketIdx >= 0
      ? marketDirection.map((b) => b * fitScale(data, marketDirection))
      : null;
  const marketOnly = marketBeta ? fromBeta(keys, marketBeta) : null;

  // 3. Alla vikter. Startar i det bästa av 1 och 2 på träningsloppen: oftast
  //    marknaden, så att övriga faktorer bara får vikt om de förbättrar oddsen.
  const start =
    marketBeta && trainLoss(marketBeta) < trainLoss(recalibratedBeta)
      ? marketBeta
      : recalibratedBeta;
  const fitted = fromBeta(keys, fitBeta(data, start));

  const variants = { current, recalibrated, marketOnly, fitted };
  const evals = {
    current: evalModel(test, current.weights, current.temperature),
    recalibrated: evalModel(
      test,
      recalibrated.weights,
      recalibrated.temperature,
    ),
    marketOnly: marketOnly
      ? evalModel(test, marketOnly.weights, marketOnly.temperature)
      : null,
    fitted: evalModel(test, fitted.weights, fitted.temperature),
  };

  // Lopp för lopp mot de nuvarande värdena: ett alternativ rekommenderas bara
  // om förbättringen är större än slumpen på så här många testlopp.
  const candidates = (["recalibrated", "marketOnly", "fitted"] as const).filter(
    (k) => evals[k] !== null,
  );
  const best = candidates.reduce((a, b) =>
    evals[b]!.logLoss < evals[a]!.logLoss ? b : a,
  );
  const gain = paired(evals[best]!.losses, evals.current.losses);
  const recommended: Variant =
    gain && gain.diff < -0.01 && gain.diff + 2 * gain.se < 0 ? best : "current";
  const chosen = variants[recommended] ?? current;

  // Marknaden och favoriten på testomgångarna.
  const priced = test.filter((r) => r.runners.every((h) => h.odds));
  const market = marketLosses(test);
  const hasMarket = market.some((x) => x !== null);
  const vsMarket = hasMarket
    ? (Object.fromEntries(
        (Object.keys(evals) as Variant[]).map((k) => [
          k,
          evals[k] ? paired(evals[k]!.losses, market) : null,
        ]),
      ) as Record<Variant, Paired | null>)
    : null;

  // Vinstchans och spelvärde med det rekommenderade alternativet.
  const rescored = test.map((race) => {
    const points = race.runners.map((r) => pointsWith(r, chosen.weights));
    const p = softmax(points, chosen.temperature);
    return {
      ...race,
      runners: race.runners.map((r, i) => ({
        ...r,
        points: points[i]!,
        winProbability: p[i]!,
        value: r.marketProbability ? p[i]! / r.marketProbability : null,
      })),
    };
  });

  const calibration = BUCKETS.map(({ label, lo, hi }) => {
    const items = rescored.flatMap((race) =>
      race.runners
        .filter((h) => h.winProbability >= lo && h.winProbability < hi)
        .map((h) => ({
          p: h.winProbability,
          won: race.winners.includes(h.number),
        })),
    );
    const n = items.length;
    return {
      label,
      runners: n,
      expected: n ? items.reduce((s, x) => s + x.p, 0) / n : 0,
      observed: n ? items.filter((x) => x.won).length / n : 0,
    };
  });

  return {
    train: {
      races: train.length,
      rounds: trainDates.length,
      until: trainDates.at(-1) ?? "",
    },
    test: {
      races: test.length,
      rounds: testDates.length,
      from: testDates[0] ?? "",
    },
    keys,
    current,
    recalibrated,
    marketOnly,
    fitted,
    results: {
      current: summary(evals.current),
      recalibrated: summary(evals.recalibrated),
      marketOnly: evals.marketOnly ? summary(evals.marketOnly) : null,
      fitted: summary(evals.fitted),
      favorite: hitStats(priced, (h) => -(h.odds ?? Infinity)),
      marketLogLoss: hasMarket ? mean(market) : null,
    },
    vsMarket,
    recommended,
    calibration,
    topPickBets: bets(rescored, (race) =>
      [...race.runners]
        .sort((a, b) => b.points - a.points || a.number - b.number)
        .slice(0, 1),
    ),
    valueBets: {
      threshold: VALUE_THRESHOLD,
      ...bets(rescored, (race) =>
        race.runners.filter((h) => (h.value ?? 0) >= VALUE_THRESHOLD),
      ),
    },
  };
}
