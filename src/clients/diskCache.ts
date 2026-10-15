/**
 * Enkel diskcache med "stale-if-error": är kopian för gammal hämtas en ny,
 * men misslyckas hämtningen används den gamla kopian hellre än ingenting.
 * Vi sparar råsvaret, så ändringar i parsern slår igenom utan ny hämtning.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

export const CACHE_DIR =
  process.env.TRAV_CACHE_DIR ?? path.join(process.cwd(), ".cache");

interface Entry<T> {
  savedAt: number;
  key: string;
  value: T;
}

const fileFor = (key: string) =>
  path.join(
    CACHE_DIR,
    `${createHash("sha1").update(key).digest("hex").slice(0, 16)}.json`,
  );

async function read<T>(file: string): Promise<Entry<T> | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as Entry<T>;
  } catch {
    return null;
  }
}

export async function cached<T>(
  key: string,
  ttlMs: number,
  fetcher: () => Promise<T>,
  onStale?: (ageMs: number, err: unknown) => void,
): Promise<T> {
  const file = fileFor(key);
  const existing = await read<T>(file);
  if (existing && Date.now() - existing.savedAt < ttlMs) return existing.value;

  try {
    const value = await fetcher();
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(
      file,
      JSON.stringify({ savedAt: Date.now(), key, value } satisfies Entry<T>),
    );
    return value;
  } catch (err) {
    if (existing) {
      onStale?.(Date.now() - existing.savedAt, err);
      return existing.value;
    }
    throw err;
  }
}
