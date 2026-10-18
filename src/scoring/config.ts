/**
 * All "kunskap" i poängsystemet bor här, så den kan kalibreras utan att röra
 * motorn. Värdena är rimliga startheuristiker – inte sanningar. Fas 3 i
 * roadmapen backtestar och justerar dem mot faktiska resultat.
 */

export type FactorKey =
  | "form"
  | "speed"
  | "class"
  | "winRate"
  | "driver"
  | "trainer"
  | "position"
  | "gearForm"
  | "gearChange"
  | "freshness"
  | "driverForm"
  | "trainerForm"
  | "driverTrack"
  | "market";

export interface ScoringConfig {
  /** Vikter, normaliseras till summa 1 av motorn. 0 = faktorn av. */
  weights: Record<FactorKey, number>;

  form: {
    /** Poäng för placering 1..n i en tidigare start. */
    placementPoints: number[];
    /** Vikt per start bakåt i tiden (senaste först). */
    recencyWeights: number[];
    gallopPenalty: number;
    disqPenalty: number;
    /** Vikt (0..1) för en start i den andra disciplinen (trav ↔ monté). */
    crossSportWeight: number;
  };

  speed: {
    /** Hur mycket långsammare en voltstart typiskt är per km än autostart (sek). */
    volteSecPerKm: number;
    /** Hur mycket långsammare en montéstart typiskt är per km än en sulkystart (sek). */
    monteSecPerKm: number;
    /** Hur mycket km-tiden typiskt ökar per 100 m längre distans (sek). */
    secPerKmPer100m: number;
    referenceDistance: number;
    lookback: number;
    /** Andel av fartbetyget från senaste starter vs rekord. */
    recentWeight: number;
  };

  /** Bayesiansk krympning så att 1 seger på 1 start inte blir 100 %. */
  shrinkage: {
    horseK: number;
    personK: number;
    priorWin: number;
    priorTop3: number;
  };

  position: {
    auto: Record<number, number>;
    volte: Record<number, number>;
    fallback: number;
    /** Avdrag per 20 m tillägg. */
    handicapPer20m: number;
  };

  /** Utrustning: hur hästen gått med dagens skor/vagn, och ny utrustning för första gången. */
  gear: {
    /** Hur många tidigare starter som gås igenom. */
    lookback: number;
    /** Max antal starter med samma utrustning som räknas (de senaste). */
    maxMatches: number;
    /** Krympning mot hästens snitt: så många "snittstarter" läggs till. */
    shrinkK: number;
    /** Minst så många starter med känd utrustning för att säga "första gången". */
    minHistory: number;
    firstBarefootAround: number;
    firstBarefootOneEnd: number;
    firstAmerican: number;
    /** Andel av bonusen när historiken är för kort och bara ATG:s "ändrat"-flagga finns. */
    changedOnlyShare: number;
  };

  freshness: {
    idealMinDays: number;
    idealMaxDays: number;
    longLayoffDays: number;
  };

  /** Bonus (0..maxBonus) för placering på Travsports topplista. */
  chart: { maxBonus: number };

  /**
   * Kusk- och tränarform ur resultatsamlingen. k = antal "snittstarter" som
   * läggs till, så att få starter inte ger extrema värden.
   */
  recentForm: { days: number; k: number };
  /** Kusken på dagens bana. */
  trackForm: { days: number; k: number };

  /** Temperatur för softmax poäng -> vinstsannolikhet. Lägre = skarpare. */
  probability: { temperature: number };
}

export const DEFAULT_CONFIG: ScoringConfig = {
  // Anpassade med --fit på V85, V86 och V64 sedan 2025-09-01 (2400 lopp, okt
  // 2026). Marknaden är på log-skala och bär nästan allt; övriga faktorer
  // tillför i dag inget mätbart utöver oddsen.
  weights: {
    form: 0.0,
    speed: 0.01,
    class: 0.01,
    winRate: 0.0,
    driver: 0.0,
    trainer: 0.03,
    position: 0.03,
    gearForm: 0.0,
    gearChange: 0.08,
    freshness: 0.0,
    // Nya, ännu inte backtestade: vikt 0 tills --fit visar att de hjälper.
    driverForm: 0.0,
    trainerForm: 0.0,
    driverTrack: 0.0,
    market: 0.85,
  },
  form: {
    placementPoints: [10, 7, 5, 3, 2, 1],
    recencyWeights: [1, 0.8, 0.6, 0.45, 0.3],
    gallopPenalty: -2,
    disqPenalty: -3,
    crossSportWeight: 0.7,
  },
  speed: {
    volteSecPerKm: 1.0,
    // Median av samma hästs montétider mot sulkytider i ATG-cachen (164 hästar,
    // okt 2026). Spridningen är stor (kvartiler −0,2–1,4 s).
    monteSecPerKm: 0.6,
    secPerKmPer100m: 0.15,
    referenceDistance: 2140,
    lookback: 5,
    recentWeight: 0.7,
  },
  shrinkage: { horseK: 6, personK: 40, priorWin: 0.11, priorTop3: 0.33 },
  position: {
    // Autostart: spår 1–8 bakom bilen, 9+ andra ledet.
    auto: {
      1: 8,
      2: 8.5,
      3: 8.5,
      4: 9,
      5: 8.5,
      6: 7,
      7: 6.5,
      8: 5.5,
      9: 6,
      10: 5.5,
      11: 5,
      12: 4.5,
    },
    // Voltstart: inner-spår bra, ytterspår och andra volten sämre.
    volte: {
      1: 8,
      2: 8.5,
      3: 8,
      4: 7.5,
      5: 7,
      6: 6,
      7: 6.5,
      8: 6,
      9: 5.5,
      10: 5,
      11: 4.5,
      12: 4,
    },
    fallback: 4,
    handicapPer20m: 1.5,
  },
  gear: {
    lookback: 30,
    maxMatches: 10,
    shrinkK: 2,
    minHistory: 3,
    firstBarefootAround: 4,
    firstBarefootOneEnd: 2,
    firstAmerican: 2,
    changedOnlyShare: 0.5,
  },
  freshness: { idealMinDays: 10, idealMaxDays: 35, longLayoffDays: 90 },
  chart: { maxBonus: 10 },
  recentForm: { days: 21, k: 15 },
  trackForm: { days: 180, k: 20 },
  probability: { temperature: 12.6 },
};

export const FACTOR_LABELS: Record<FactorKey, string> = {
  form: "Form",
  speed: "Fart",
  class: "Klass",
  winRate: "Segerprocent",
  driver: "Kusk",
  trainer: "Tränare",
  position: "Spår/distans",
  gearForm: "Rustningsform",
  gearChange: "Ny utrustning",
  freshness: "Vila",
  driverForm: "Kuskform",
  trainerForm: "Stallform",
  driverTrack: "Kusk på banan",
  market: "Marknad",
};

/** Faktornamn som skiljer sig i montélopp. */
export const MONTE_FACTOR_LABELS: Partial<Record<FactorKey, string>> = {
  driver: "Ryttare",
  driverForm: "Ryttarform",
  driverTrack: "Ryttare på banan",
};

export type ConfigOverrides = Partial<Omit<ScoringConfig, "weights">> & {
  weights?: Partial<ScoringConfig["weights"]>;
};

export function withConfig(overrides: ConfigOverrides = {}): ScoringConfig {
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
    weights: { ...DEFAULT_CONFIG.weights, ...overrides.weights },
  };
}
