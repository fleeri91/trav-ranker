/** Domänmodell – oberoende av hur ATG/Travsport råkar forma sina svar. */

export type StartMethod = "auto" | "volte" | "unknown";

/** Trav med sulky eller monté (riden). Galopp rankas inte. */
export type Sport = "trot" | "monte";

export interface PastStart {
  date: string | null; // ISO yyyy-mm-dd
  place: number | null; // 1..n, null = oplacerad/okänd
  kmTimeSec: number | null; // km-tid i sekunder (1.12,5 => 72.5)
  startMethod: StartMethod;
  sport: Sport;
  distance: number | null;
  galloped: boolean;
  disqualified: boolean;
  odds: number | null; // decimalodds
  /** Utrustningen i den starten. null = uppgift saknas. */
  gear: GearSnapshot | null;
}

/** Skor och vagn i en start. */
export interface GearSnapshot {
  frontShod: boolean;
  backShod: boolean;
  american: boolean;
}

export interface StatLine {
  starts: number;
  wins: number;
  seconds: number;
  thirds: number;
  earnings: number;
}

export interface Person {
  id: number | null;
  name: string;
  year: StatLine;
  /** Placering på Svensk Travsports topplista (1 = bäst), null om ej med. */
  chartRank: number | null;
  /** Antal personer i topplistan (för att skala bonusen). */
  chartSize: number;
}

export interface Runner {
  startId: string;
  number: number;
  postPosition: number;
  /** Startdistans för just denna häst (inkl. ev. tillägg). */
  distance: number;
  scratched: boolean;

  horseId: number | null;
  horseName: string;
  age: number | null;
  sex: string | null;

  /** Senaste 12 månaderna: i år + viktad del av förra året. */
  horseYear: StatLine;
  horseLife: StatLine;
  /** Bästa rekordtid (sek/km) för dagens startmetod, annars bästa totalt. */
  recordKmSec: number | null;
  recordStartMethod: StartMethod;
  past: PastStart[]; // senaste först

  /** Kusken, eller ryttaren i montélopp. */
  driver: Person;
  trainer: Person;

  shoes: {
    frontOff: boolean;
    backOff: boolean;
    frontChanged: boolean;
    backChanged: boolean;
    reported: boolean;
  };
  sulky: { american: boolean; changed: boolean };

  odds: number | null; // vinnarodds, decimal
  betDistribution: number | null; // % i spelformen (t.ex. V75)

  /**
   * Från resultatsamlingen (alla svenska lopp), före loppets datum. Saknas
   * när samlingen inte täcker perioden.
   */
  recent?: {
    driver: RecentTally | null;
    trainer: RecentTally | null;
    /** Kusken på just den här banan. */
    driverTrack: RecentTally | null;
  };
}

export interface RecentTally {
  starts: number;
  wins: number;
  top3: number;
}

export interface RaceInput {
  raceId: string;
  gameId?: string;
  number: number;
  name: string;
  date: string;
  trackName: string;
  distance: number;
  startMethod: StartMethod;
  sport: Sport;
  startTime: string | null;
  runners: Runner[];
}
