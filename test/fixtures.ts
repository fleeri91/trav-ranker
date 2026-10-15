import type { TravsportStats } from "../src/types/travsport.ts";

let nextId = 1000;

/** En TravsportStats-post i samma format som Travsports API. */
export function travsportStats(
  name: string,
  overrides: Partial<TravsportStats> = {},
): TravsportStats {
  return {
    name,
    id: { id: nextId++, sourceOfData: "T", organisation: "TROT" },
    typeOfLicense: "A",
    numberOfStarts: 100,
    winningPercent: 10,
    prizeMoney: 1_000_000,
    numberOfFirstPlaces: 10,
    numberOfSecondPlaces: 10,
    numberOfThirdPlaces: 10,
    numberOfFourthPlaces: 10,
    numberOfFifthPlaces: 10,
    homeTrackCode: "S",
    ...overrides,
  };
}
