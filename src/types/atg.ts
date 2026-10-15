/**
 * Råa typer för ATG:s (inofficiella) racinginfo-API.
 *
 * Allt är medvetet "lenient" (optional) eftersom API:t är odokumenterat och
 * fält kan saknas/ändras. Domänlogiken läser ALDRIG dessa typer direkt –
 * allt går via src/mappers/atgMapper.ts. Ändras API:t är det bara mappern
 * som behöver uppdateras.
 */

export interface AtgTime {
  minutes?: number;
  seconds?: number;
  tenths?: number;
  code?: string;
}

export interface AtgStatBlock {
  starts?: number;
  earnings?: number;
  placement?: Partial<Record<"1" | "2" | "3", number>>;
  winPercentage?: number;
  records?: AtgRecord[];
}

export interface AtgRecord {
  code?: string;
  startMethod?: string; // "auto" | "volte"
  distance?: string; // "short" | "medium" | "long"
  time?: AtgTime;
  place?: number;
}

export interface AtgPerson {
  id?: number;
  firstName?: string;
  lastName?: string;
  shortName?: string;
  license?: string;
  statistics?: { years?: Record<string, AtgStatBlock>; life?: AtgStatBlock };
}

export interface AtgShoe {
  hasShoe?: boolean;
  changed?: boolean;
}

export interface AtgPastResult {
  date?: string;
  place?: number | string;
  /** Km-tid. Har den `code` är tiden inte "ren" (galopp, utgått m.m.). */
  kmTime?: AtgTime;
  startMethod?: string;
  distance?: number;
  galloped?: boolean;
  disqualified?: boolean;
  scratched?: boolean;
  odds?: number;
  race?: {
    id?: string;
    sport?: string;
    type?: string;
    number?: number;
    startMethod?: string;
    distance?: number;
    date?: string;
    /** Förstapris (i öre, 5000000 = 50 000 kr). */
    firstPrize?: number;
  };
  track?: {
    id?: number;
    name?: string;
    condition?: string;
    countryCode?: string;
  };
  /** Hästens start i det loppet – här ligger distansen (inkl. tillägg) och spåret. */
  start?: {
    distance?: number;
    postPosition?: number;
    driver?: AtgPerson;
    horse?: {
      /** true = skodd */
      shoes?: { front?: boolean; back?: boolean };
      sulky?: { type?: { code?: string; text?: string } };
    };
  };
}

export interface AtgHorse {
  id?: number;
  name?: string;
  age?: number;
  sex?: string;
  money?: number;
  record?: AtgRecord;
  trainer?: AtgPerson;
  shoes?: { reported?: boolean; front?: AtgShoe; back?: AtgShoe };
  sulky?: {
    reported?: boolean;
    type?: { code?: string; text?: string; changed?: boolean };
  };
  statistics?: {
    years?: Record<string, AtgStatBlock>;
    life?: AtgStatBlock;
    lastFiveStarts?: { averageOdds?: number };
  };
  /** /races/:id/start/ ger `records`; äldre format kan ha `collection`. */
  results?:
    | { records?: AtgPastResult[]; collection?: AtgPastResult[] }
    | AtgPastResult[];
}

export interface AtgPool {
  odds?: number; // hundradelar, 450 = 4.50
  betDistribution?: number; // hundradels-procent, 1534 = 15.34 %
}

export interface AtgStart {
  id?: string;
  number: number;
  postPosition?: number;
  distance?: number;
  scratched?: boolean;
  horse?: AtgHorse;
  driver?: AtgPerson;
  pools?: Record<string, AtgPool | undefined>;
  /** Finns när loppet är avgjort (formatet är inte verifierat). */
  result?: { place?: number | string; finishOrder?: number | string };
}

export interface AtgRace {
  id: string;
  number: number;
  name?: string;
  date?: string;
  distance?: number;
  startMethod?: string;
  startTime?: string;
  sport?: string; // "trot" | "monté" | "gallop"
  track?: { id?: number; name?: string; condition?: string };
  starts?: AtgStart[];
}

export interface AtgGame {
  id: string;
  type?: string;
  status?: string;
  races?: AtgRace[];
}

export interface AtgCalendarGame {
  id: string;
  status?: string;
  startTime?: string;
  tracks?: number[];
}

export interface AtgCalendarDay {
  date?: string;
  tracks?: Array<{ id: number; name?: string; sport?: string }>;
  games?: Record<string, AtgCalendarGame[] | undefined>;
}

/**
 * En post i svaret från /races/:raceId/start/ – en lista med alla starter i
 * loppet, med hästarnas tidigare resultat (`horse.results.records`).
 */
export interface AtgExtendedStart extends Partial<AtgStart> {
  /** Startnumret (motsvarar `number` i spelets starter). */
  startNumber?: number;
  horse?: AtgHorse;
}
