/**
 * Topplistor för kuskar och tränare, från tre möjliga källor:
 *
 *   atg       – beräknas från ATG-data för dagens startfält (default, inga extra anrop)
 *   file      – Travsports topplista sparad manuellt från webbläsaren till data/
 *   travsport – live-hämtning från Travsport (opt-in; blockeras ofta av deras bot-skydd)
 *
 * Varje lista finns i varianterna "all" (alla lopp), "stl" (bara STL-lopp,
 * typeOfRace=R hos Travsport) och "monte" (bara montélopp, sulkyOrMonte=M).
 * STL-varianten används för lopp i STL-spel (V85), montévarianten för
 * ryttarna i montélopp. Montévarianten finns bara för kuskar (ryttare).
 *
 * Årets och förra årets listor vägs ihop till "senaste 12 månaderna", så att
 * listorna inte är tomma i januari (se scoring/season.ts).
 */
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { AtgGame, AtgPerson } from "../types/atg.ts";
import type {
  TravsportRaceType,
  TravsportSulkyOrMonte,
} from "../types/travsport.ts";
import { season } from "../scoring/season.ts";
import {
  ChartIndex,
  nameKey,
  parseChart,
  type ChartEntry,
} from "./travsport.ts";

export type ChartSource = "auto" | "atg" | "file" | "travsport" | "none";
export type ChartKind = "drivers" | "trainers";
export type ChartVariant = "all" | "stl" | "monte";

export const CHART_SOURCES: readonly ChartSource[] = [
  "auto",
  "atg",
  "file",
  "travsport",
  "none",
];
export const CHART_VARIANTS: readonly ChartVariant[] = ["all", "stl", "monte"];

/** Vilka listor som finns per variant – tränare har ingen montélista. */
export const VARIANT_KINDS: Record<ChartVariant, readonly ChartKind[]> = {
  all: ["drivers", "trainers"],
  stl: ["drivers", "trainers"],
  monte: ["drivers"],
};

/** Läggs efter listans namn i loggar: "kuskar (STL)". */
export const VARIANT_TAG: Record<ChartVariant, string> = {
  all: "",
  stl: " (STL)",
  monte: " (monté)",
};

/** Travsports typeOfRace för respektive variant: B = alla lopp, R = STL. */
export const RACE_TYPE_OF: Record<ChartVariant, TravsportRaceType> = {
  all: "B",
  stl: "R",
  monte: "B",
};

/** Travsports sulkyOrMonte för respektive variant: B = båda, M = monté. */
export const SULKY_OR_MONTE_OF: Record<ChartVariant, TravsportSulkyOrMonte> = {
  all: "B",
  stl: "B",
  monte: "M",
};

/** Varnar om årets fil är äldre än så här (förra årets lista ändras inte). */
const FILE_MAX_AGE_DAYS = 14;

/**
 * data/travsport-drivers-2026.json, data/travsport-drivers-stl-2025.json osv.
 * Utan år: det gamla filnamnet (data/travsport-drivers.json), som läses som årets lista.
 */
export function chartFile(
  kind: ChartKind,
  variant: ChartVariant = "all",
  year?: number,
): string {
  const dir = process.env.TRAV_DATA_DIR ?? path.join(process.cwd(), "data");
  const suffix = variant === "all" ? "" : `-${variant}`;
  const yearPart = year === undefined ? "" : `-${year}`;
  return path.join(dir, `travsport-${kind}${suffix}${yearPart}.json`);
}

/**
 * Filnamn som provas i tur och ordning: det kanoniska (chartFile) och för
 * monté även med året före varianten, så som Travsport-filen ofta sparas:
 * data/travsport-drivers-2026-monté.json (eller -monte).
 */
export function chartFileCandidates(
  kind: ChartKind,
  variant: ChartVariant = "all",
  year?: number,
): string[] {
  const files = [chartFile(kind, variant, year)];
  if (variant === "monte" && year !== undefined) {
    const dir = path.dirname(files[0]!);
    for (const tag of ["monté", "monte"])
      files.push(path.join(dir, `travsport-${kind}-${year}-${tag}.json`));
  }
  return files;
}

/** Första filen bland kandidaterna som finns. undefined om ingen finns. */
export function findChartFile(
  kind: ChartKind,
  variant: ChartVariant = "all",
  year?: number,
): string | undefined {
  return chartFileCandidates(kind, variant, year).find((f) => existsSync(f));
}

async function readEntries(
  file: string,
): Promise<{ entries: ChartEntry[]; mtimeMs: number } | null> {
  let text: string;
  let mtimeMs: number;
  try {
    [text, { mtimeMs }] = await Promise.all([
      readFile(file, "utf8"),
      stat(file),
    ]);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const entries = parseChart(JSON.parse(text));
  if (!entries.length) throw new Error(`${file} innehåller inga poster`);
  return { entries, mtimeMs };
}

const ageDays = (mtimeMs: number) => (Date.now() - mtimeMs) / 86_400_000;

/** Läser en enskild sparad lista. null om filen inte finns. */
export async function loadChartFile(
  kind: ChartKind,
  variant: ChartVariant = "all",
  log: (m: string) => void = () => {},
  year?: number,
): Promise<ChartIndex | null> {
  const file = findChartFile(kind, variant, year);
  const read = file ? await readEntries(file) : null;
  if (!file || !read) return null;
  const age = ageDays(read.mtimeMs);
  const isPastYear = year !== undefined && year < new Date().getFullYear();
  if (!isPastYear && age > FILE_MAX_AGE_DAYS) {
    log(
      `Topplista: ${path.basename(file)} är ${Math.round(age)} dagar gammal – spara en ny från webbläsaren`,
    );
  }
  return new ChartIndex(read.entries);
}

/**
 * Väger ihop årets och förra årets lista: siffrorna summeras med förra årets
 * multiplicerade med prevWeight, och listan rankas om på segrar (sedan intjänat).
 * Personer matchas på id, annars på namn.
 */
export function blendCharts(
  current: ChartEntry[],
  previous: ChartEntry[],
  prevWeight: number,
): ChartEntry[] {
  if (!previous.length || prevWeight <= 0) return current;
  const keyOf = (e: ChartEntry) =>
    e.id !== null ? `id:${e.id}` : `name:${nameKey(e.name)}`;
  const n = (v: number | null) => v ?? 0;
  const merged = new Map<string, ChartEntry>();
  for (const e of current) merged.set(keyOf(e), { ...e });
  for (const p of previous) {
    const key = keyOf(p);
    const e = merged.get(key) ?? {
      ...p,
      starts: 0,
      wins: 0,
      seconds: 0,
      thirds: 0,
      earnings: 0,
    };
    merged.set(key, {
      ...e,
      starts: n(e.starts) + n(p.starts) * prevWeight,
      wins: n(e.wins) + n(p.wins) * prevWeight,
      seconds: n(e.seconds) + n(p.seconds) * prevWeight,
      thirds: n(e.thirds) + n(p.thirds) * prevWeight,
      earnings: n(e.earnings) + n(p.earnings) * prevWeight,
    });
  }
  return [...merged.values()]
    .sort((a, b) => n(b.wins) - n(a.wins) || n(b.earnings) - n(a.earnings))
    .map((e, i) => ({ ...e, rank: i + 1 }));
}

/**
 * Laddar en lista för "senaste 12 månaderna" kring `date`: årets fil
 * (eller det gamla filnamnet utan år) plus förra årets fil, ihopvägda.
 * null om ingen av filerna finns.
 */
export async function loadSeasonChart(
  kind: ChartKind,
  variant: ChartVariant,
  date: string,
  log: (m: string) => void = () => {},
): Promise<{ index: ChartIndex; files: string[] } | null> {
  const s = season(date);
  const files: string[] = [];

  const currentFile = findChartFile(kind, variant, s.year);
  let current = currentFile ? await readEntries(currentFile) : null;
  if (current && currentFile) files.push(currentFile);
  else {
    current = await readEntries(chartFile(kind, variant));
    if (current) {
      files.push(chartFile(kind, variant));
      log(
        `Topplista: ${path.basename(chartFile(kind, variant))} saknar år i namnet – byt namn till ${path.basename(chartFile(kind, variant, s.year))}`,
      );
    }
  }
  if (current && ageDays(current.mtimeMs) > FILE_MAX_AGE_DAYS) {
    log(
      `Topplista: ${path.basename(files[0] ?? "")} är ${Math.round(ageDays(current.mtimeMs))} dagar gammal – spara en ny från webbläsaren`,
    );
  }

  const previousFile =
    s.prevWeight > 0 ? findChartFile(kind, variant, s.prevYear) : undefined;
  const previous = previousFile ? await readEntries(previousFile) : null;
  if (previous && previousFile) files.push(previousFile);

  if (!current && !previous) return null;
  const blended = blendCharts(
    current?.entries ?? [],
    previous?.entries ?? [],
    s.prevWeight,
  );
  return { index: new ChartIndex(blended), files };
}

/**
 * Bygger topplistor av alla kuskar/tränare i dagens spel, rankade på
 * segrar senaste 12 månaderna (sedan intjänat). Rank 1 = flest segrar
 * bland dagens personer.
 */
export function buildAtgCharts(
  games: AtgGame[],
  date: string,
): Record<ChartKind, ChartIndex> {
  const s = season(date);
  const tallies: Record<ChartKind, Map<string, ChartEntry>> = {
    drivers: new Map(),
    trainers: new Map(),
  };

  const add = (kind: ChartKind, p: AtgPerson | undefined) => {
    if (!p) return;
    const name =
      [p.firstName, p.lastName].filter(Boolean).join(" ") || p.shortName || "";
    if (!name && p.id == null) return;
    const key = p.id != null ? `id:${p.id}` : `name:${nameKey(name)}`;
    if (tallies[kind].has(key)) return;
    const cur = p.statistics?.years?.[String(s.year)];
    const prev = p.statistics?.years?.[String(s.prevYear)];
    const w = s.prevWeight;
    const sum = (a = 0, b = 0) => a + b * w;
    tallies[kind].set(key, {
      rank: 0,
      id: p.id ?? null,
      name,
      starts: sum(cur?.starts, prev?.starts),
      wins: sum(cur?.placement?.["1"], prev?.placement?.["1"]),
      seconds: sum(cur?.placement?.["2"], prev?.placement?.["2"]),
      thirds: sum(cur?.placement?.["3"], prev?.placement?.["3"]),
      earnings: sum(cur?.earnings, prev?.earnings),
    });
  };

  for (const game of games) {
    for (const race of game.races ?? []) {
      for (const start of race.starts ?? []) {
        add("drivers", start.driver);
        add("trainers", start.horse?.trainer);
      }
    }
  }

  const rank = (m: Map<string, ChartEntry>) =>
    new ChartIndex(
      [...m.values()]
        .sort(
          (a, b) =>
            (b.wins ?? 0) - (a.wins ?? 0) ||
            (b.earnings ?? 0) - (a.earnings ?? 0),
        )
        .map((e, i) => ({ ...e, rank: i + 1 })),
    );

  return { drivers: rank(tallies.drivers), trainers: rank(tallies.trainers) };
}
