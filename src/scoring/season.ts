import type { StatLine } from "../types/domain.ts";

/**
 * Statistik "senaste 12 månaderna" byggd av årssiffror:
 *
 *   i år + förra året × (andel av förra året som ligger inom de senaste 12 mån)
 *
 * 10 januari: förra året väger ~0,97 – i stort sett hela förra säsongen räknas.
 * 1 juli:     ~0,50
 * 20 december: ~0,03 – nästan bara i år.
 *
 * Det antar att starterna är jämnt fördelade över året, vilket räcker gott
 * för att slippa tomma siffror i januari.
 */
export interface Season {
  year: number;
  prevYear: number;
  /** 0–1: hur mycket förra årets siffror väger in. */
  prevWeight: number;
}

export function season(date: string): Season {
  const d = new Date(`${date.slice(0, 10)}T12:00:00Z`);
  const year = Number.isNaN(d.getTime())
    ? new Date().getUTCFullYear()
    : d.getUTCFullYear();
  const start = Date.UTC(year, 0, 1);
  const end = Date.UTC(year + 1, 0, 1);
  const elapsed = Number.isNaN(d.getTime())
    ? 1
    : (d.getTime() - start) / (end - start);
  return {
    year,
    prevYear: year - 1,
    prevWeight: Math.min(1, Math.max(0, 1 - elapsed)),
  };
}

/** i år + förra året × vikt. Ger decimaltal, vilket är ok för andelar och snitt. */
export function blendStats(
  current: StatLine,
  previous: StatLine,
  prevWeight: number,
): StatLine {
  const w = prevWeight;
  return {
    starts: current.starts + previous.starts * w,
    wins: current.wins + previous.wins * w,
    seconds: current.seconds + previous.seconds * w,
    thirds: current.thirds + previous.thirds * w,
    earnings: current.earnings + previous.earnings * w,
  };
}
