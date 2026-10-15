import { getJson, HttpError, type GetJsonOptions } from "./http.ts";
import { cached } from "./diskCache.ts";
import type {
  TravsportChartQuery,
  TravsportChartType,
  TravsportStats,
} from "../types/travsport.ts";

const BASE =
  "https://sportapp.travsport.se/webapi/charts/listpersonchart/organisation/TROT";

/**
 * Travsports webapi ligger bakom ett bot-skydd (Baffin Bay Networks):
 * 403 utan dessa headers, 429 vid för många anrop och därefter en
 * JS-verifieringssida ("Verifying..."). Live-hämtning är därför opt-in
 * (--charts travsport). Standard är topplistor beräknade från ATG, eller
 * en lista du själv sparat från webbläsaren (se src/clients/charts.ts).
 */
export const TRAVSPORT_HEADERS: Record<string, string> = {
  accept: "application/json, text/plain, */*",
  "accept-language": "sv-SE,sv;q=0.9,en;q=0.8",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36",
  origin: "https://sportapp.travsport.se",
  referer: "https://sportapp.travsport.se/",
};

/**
 * Travsport har rate limit (429 "abnormal amount of requests"). Topplistan
 * ändras långsamt, så vi hämtar sällan, glest och aldrig parallellt.
 */
export const TRAVSPORT_HTTP: GetJsonOptions = {
  headers: TRAVSPORT_HEADERS,
  minIntervalMs: 3_000,
  retries: 1,
  backoffMs: 10_000,
  maxRetryAfterMs: 60_000,
  ttlMs: 60 * 60_000,
};

/** Hur länge en sparad topplista räknas som färsk. */
export const CHART_DISK_TTL_MS = 12 * 60 * 60_000;

/** Samma parameterordning som sportapp-webben använder. */
const PARAM_ORDER: (keyof TravsportChartQuery)[] = [
  "breed",
  "category",
  "chartTypeSearchParam",
  "gender",
  "homeTrack",
  "licenseType",
  "list",
  "onlyYouth",
  "raceOnTrack",
  "returnNumberOfEntries",
  "sulkyOrMonte",
  "typeOfRace",
  "year",
];

export function buildChartUrl(q: TravsportChartQuery): string {
  const params = new URLSearchParams(PARAM_ORDER.map((k) => [k, String(q[k])]));
  return `${BASE}?${params}`;
}

/** Verifierat i sportapp-webben: category=1 för båda, chartTypeSearchParam väljer lista. */
export const CHART_PRESETS = {
  drivers: { category: 1, chartTypeSearchParam: 1 },
  trainers: { category: 1, chartTypeSearchParam: 2 },
} as const satisfies Record<
  string,
  { category: number; chartTypeSearchParam: TravsportChartType }
>;

const DEFAULT_QUERY: Omit<
  TravsportChartQuery,
  "category" | "chartTypeSearchParam" | "year"
> = {
  breed: "B",
  gender: "B",
  homeTrack: "S",
  raceOnTrack: "A",
  licenseType: "S",
  list: "S",
  onlyYouth: false,
  returnNumberOfEntries: 100,
  sulkyOrMonte: "B",
  typeOfRace: "B",
};

/** Domänens bild av en person på en topplista (Travsport eller beräknad från ATG). */
export interface ChartEntry {
  rank: number;
  id: number | null;
  name: string;
  starts: number | null;
  wins: number | null;
  seconds: number | null;
  thirds: number | null;
  earnings: number | null;
}

type ChartQueryInput = Pick<
  TravsportChartQuery,
  "category" | "chartTypeSearchParam"
> &
  Partial<TravsportChartQuery>;

export function chartQuery(query: ChartQueryInput): TravsportChartQuery {
  return { ...DEFAULT_QUERY, year: new Date().getFullYear(), ...query };
}

export async function fetchPersonChart(
  query: ChartQueryInput,
  opts: { onStale?: (ageMs: number, err: unknown) => void } = {},
): Promise<ChartEntry[]> {
  const url = buildChartUrl(chartQuery(query));
  const raw = await cached(
    `travsport:${url}`,
    CHART_DISK_TTL_MS,
    async () => {
      try {
        return await getJson<unknown>(url, TRAVSPORT_HTTP);
      } catch (err) {
        if (err instanceof HttpError && /verifying/i.test(err.bodySnippet)) {
          throw new Error(
            "Travsport visar en bot-verifiering – ingen automatisk hämtning",
          );
        }
        throw err;
      }
    },
    opts.onStale,
  );
  return parseChart(raw);
}

// ---------------------------------------------------------------------------
// Parsning av TravsportStats
// ---------------------------------------------------------------------------

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Typvakt: räcker att de fält vi använder finns och har rätt typ. */
export function isTravsportStats(v: unknown): v is TravsportStats {
  return (
    isObject(v) &&
    typeof v.name === "string" &&
    typeof v.numberOfStarts === "number" &&
    typeof v.numberOfFirstPlaces === "number" &&
    (v.id === undefined || v.id === null || isObject(v.id))
  );
}

/** Svaret är en lista; tål även att den ligger inslagen i ett objekt. */
function unwrapList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (isObject(raw)) {
    const list = Object.values(raw).find(Array.isArray);
    if (list) return list;
  }
  return [];
}

export function toChartEntry(s: TravsportStats, index: number): ChartEntry {
  return {
    rank: index + 1, // listan levereras sorterad, bäst först
    id: typeof s.id?.id === "number" ? s.id.id : null,
    name: s.name.trim(),
    starts: s.numberOfStarts,
    wins: s.numberOfFirstPlaces,
    seconds: s.numberOfSecondPlaces ?? null,
    thirds: s.numberOfThirdPlaces ?? null,
    earnings: s.prizeMoney ?? null,
  };
}

/** Tolkar ett listpersonchart-svar. Poster som inte är TravsportStats hoppas över. */
export function parseChart(raw: unknown): ChartEntry[] {
  return unwrapList(raw).filter(isTravsportStats).map(toChartEntry);
}

/** Tolkar tal som kan komma som sträng ("1 234,5 kr"). Används även av ATG-mappern. */
export function toNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const cleaned = v.replace(/\s|kr|%/gi, "").replace(",", ".");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Uppslag
// ---------------------------------------------------------------------------

/** Namn-nyckel som tål ordning ("Goop Björn" == "Björn Goop") och diakriter. */
export function nameKey(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z\s-]/g, " ")
    .split(/[\s-]+/)
    .filter(Boolean)
    .sort()
    .join(" ");
}

/** Som nameKey men utan enbokstavsinitialer: "Magnus A. Djuse" -> "djuse magnus". */
export function looseNameKey(name: string): string {
  return nameKey(name)
    .split(" ")
    .filter((t) => t.length > 1)
    .join(" ");
}

/**
 * Sant om namnen kan avse samma person: alla ord i det kortare namnet
 * (utan initialer) finns i det längre. "Magnus Djuse" ~ "Magnus A Djuse".
 */
export function namesCompatible(a: string, b: string): boolean {
  const [short, long] = [looseNameKey(a), looseNameKey(b)]
    .map((k) => k.split(" ").filter(Boolean))
    .sort((x, y) => x.length - y.length) as [string[], string[]];
  return short.length > 0 && short.every((t) => long.includes(t));
}

export class ChartIndex {
  private byId = new Map<number, ChartEntry>();
  private byName = new Map<string, ChartEntry>();
  /** null = flera personer delar nyckeln (t.ex. två "Mats Djuse") – matcha inte. */
  private byLooseName = new Map<string, ChartEntry | null>();

  constructor(readonly entries: ChartEntry[] = []) {
    for (const e of entries) {
      if (e.id !== null) this.byId.set(e.id, e);
      if (!e.name) continue;
      this.byName.set(nameKey(e.name), e);
      const loose = looseNameKey(e.name);
      this.byLooseName.set(loose, this.byLooseName.has(loose) ? null : e);
    }
  }

  get size(): number {
    return this.entries.length;
  }

  /**
   * Matchar i ordning: id, exakt namn, namn utan initialer (bara om entydigt).
   * Travsport skriver "Magnus A Djuse"; ATG kan skriva "Magnus A." eller "Magnus".
   * En id-träff godtas bara om namnet stämmer – ATG och Travsport kan ha
   * olika id-serier, och då vore en ren id-träff fel person.
   */
  find(
    id: number | null | undefined,
    name: string | null | undefined,
  ): ChartEntry | undefined {
    if (id != null) {
      const hit = this.byId.get(id);
      if (hit && (!name || namesCompatible(hit.name, name))) return hit;
    }
    if (!name) return undefined;
    return (
      this.byName.get(nameKey(name)) ??
      this.byLooseName.get(looseNameKey(name)) ??
      undefined
    );
  }

  /** Sant om listorna innehåller samma personer i samma ordning (topp 10). */
  sameAs(other: ChartIndex): boolean {
    const top = (c: ChartIndex) =>
      c.entries
        .slice(0, 10)
        .map((e) => nameKey(e.name))
        .join("|");
    return this.size > 0 && top(this) === top(other);
  }
}
