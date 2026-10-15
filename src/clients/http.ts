/**
 * Liten HTTP-wrapper: timeout, retry med backoff (429/5xx/nätverk) som
 * respekterar Retry-After, throttling per host, in-memory TTL-cache och
 * dedupe av samtidiga anrop mot samma URL.
 */

export interface GetJsonOptions {
  timeoutMs?: number;
  retries?: number;
  ttlMs?: number;
  /** Extra/överskrivande headers för just denna källa. */
  headers?: Record<string, string>;
  /** Minsta tid mellan två anrop mot samma host (ms). */
  minIntervalMs?: number;
  /** Bas för exponentiell backoff när servern inte skickar Retry-After (ms). */
  backoffMs?: number;
  /** Kräver servern längre väntan än så här ger vi upp direkt i stället för att vänta. */
  maxRetryAfterMs?: number;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly bodySnippet: string,
    readonly retryAfterMs?: number,
  ) {
    super(`HTTP ${status} ${url}${bodySnippet ? ` – ${bodySnippet}` : ""}`);
  }
}

const clean = (text: string) =>
  text
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);

function parseRetryAfter(v: string | null): number | undefined {
  if (!v) return undefined;
  const sec = Number(v);
  if (Number.isFinite(sec)) return sec * 1000;
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

const cache = new Map<string, { expires: number; value: unknown }>();
const inflight = new Map<string, Promise<unknown>>();
const nextSlot = new Map<string, number>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Reserverar nästa lediga tidslucka för hosten och väntar in den. */
async function throttle(url: string, minIntervalMs: number): Promise<void> {
  if (minIntervalMs <= 0) return;
  const host = new URL(url).host;
  const now = Date.now();
  const at = Math.max(now, nextSlot.get(host) ?? 0);
  nextSlot.set(host, at + minIntervalMs);
  if (at > now) await sleep(at - now);
}

export async function getJson<T>(
  url: string,
  opts: GetJsonOptions = {},
): Promise<T> {
  const {
    timeoutMs = 10_000,
    retries = 3,
    ttlMs = 60_000,
    headers = {},
    minIntervalMs = 0,
    backoffMs = 300,
    maxRetryAfterMs = 30_000,
  } = opts;

  const hit = cache.get(url);
  if (hit && hit.expires > Date.now()) return hit.value as T;

  const pending = inflight.get(url);
  if (pending) return pending as Promise<T>;

  const request = (async (): Promise<T> => {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      await throttle(url, minIntervalMs);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          signal: ctrl.signal,
          headers: {
            accept: "application/json",
            "user-agent": "trav-ranker/0.1",
            ...headers,
          },
        });
        const text = await res.text();
        if (!res.ok) {
          throw new HttpError(
            res.status,
            url,
            clean(text),
            parseRetryAfter(res.headers.get("retry-after")),
          );
        }
        let value: T;
        try {
          value = JSON.parse(text) as T;
        } catch {
          // T.ex. en brandväggs- eller rate limit-sida som skickas med status 200
          throw new HttpError(
            res.status,
            url,
            `svaret är inte JSON: ${clean(text)}`,
          );
        }
        cache.set(url, { value, expires: Date.now() + ttlMs });
        return value;
      } catch (err) {
        lastErr = err;
        const isHttpRetryable =
          err instanceof HttpError &&
          (err.status === 429 || err.status >= 500) &&
          (err.retryAfterMs ?? 0) <= maxRetryAfterMs;
        const isNetwork =
          (err as Error)?.name === "AbortError" || err instanceof TypeError;
        if (!(isHttpRetryable || isNetwork) || attempt === retries) break;
        const wait =
          err instanceof HttpError && err.retryAfterMs !== undefined
            ? err.retryAfterMs
            : backoffMs * 2 ** attempt + Math.random() * backoffMs;
        await sleep(wait);
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr;
  })();

  inflight.set(url, request);
  try {
    return await request;
  } finally {
    inflight.delete(url);
  }
}

/** Kör fn över items med max `concurrency` samtidiga anrop, bevarar ordning. */
export async function mapLimit<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T, i);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.max(1, Math.min(concurrency, items.length)) },
      worker,
    ),
  );
  return out;
}

export function clearHttpCache(): void {
  cache.clear();
  nextSlot.clear();
}
