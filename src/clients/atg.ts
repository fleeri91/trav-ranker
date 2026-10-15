import { getJson, type GetJsonOptions } from "./http.ts";
import { cached } from "./diskCache.ts";
import type {
  AtgCalendarDay,
  AtgExtendedStart,
  AtgGame,
} from "../types/atg.ts";

const BASE = "https://www.atg.se/services/racinginfo/v1/api";

export interface AtgFetchOptions {
  /**
   * Spara svaret på disk (.cache/) i 30 dagar. För avgjorda dagar, t.ex. vid
   * backtest: datan ändras inte, och omkörningar blir snabba och skonsamma.
   */
  persist?: boolean;
}

const PERSIST_TTL_MS = 30 * 24 * 60 * 60_000;
/** Paus mellan anrop när många avgjorda dagar hämtas i följd. */
const PERSIST_HTTP: GetJsonOptions = { minIntervalMs: 250 };

function fetchJson<T>(
  url: string,
  ttlMs: number,
  opts: AtgFetchOptions = {},
): Promise<T> {
  if (!opts.persist) return getJson<T>(url, { ttlMs });
  return cached(`atg:${url}`, PERSIST_TTL_MS, () =>
    getJson<T>(url, { ...PERSIST_HTTP, ttlMs }),
  );
}

export const atg = {
  /** Dagens spel. date = yyyy-mm-dd */
  calendarDay(date: string, opts?: AtgFetchOptions) {
    return fetchJson<AtgCalendarDay>(
      `${BASE}/calendar/day/${date}`,
      5 * 60_000,
      opts,
    );
  },

  /** Ett spel (t.ex. V85_2026-10-10_5_5) med alla lopp och starter. */
  game(gameId: string, opts?: AtgFetchOptions) {
    return fetchJson<AtgGame>(
      `${BASE}/games/${encodeURIComponent(gameId)}`,
      60_000,
      opts,
    );
  },

  /**
   * Utökad info för alla starter i ett lopp, i ett anrop: varje post har
   * `startNumber` och hästens tidigare resultat i `horse.results.records`.
   */
  raceStarts(raceId: string, opts?: AtgFetchOptions) {
    return fetchJson<AtgExtendedStart[]>(
      `${BASE}/races/${encodeURIComponent(raceId)}/start/`,
      10 * 60_000,
      opts,
    );
  },
};
