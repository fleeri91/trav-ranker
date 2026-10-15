import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.TRAV_CACHE_DIR = await mkdtemp(path.join(tmpdir(), "trav-cache-"));
const { getJson, HttpError, clearHttpCache } =
  await import("../src/clients/http.ts");
const { cached } = await import("../src/clients/diskCache.ts");

let hits: Record<string, number> = {};
const server = createServer((req, res) => {
  const p = req.url ?? "";
  hits[p] = (hits[p] ?? 0) + 1;
  if (p === "/html")
    return res
      .writeHead(200, { "content-type": "text/html" })
      .end("<!DOCTYPE html><p>Blocked</p>");
  if (p === "/limited" && hits[p] === 1)
    return res.writeHead(429, { "retry-after": "0" }).end("slow down");
  if (p === "/long-wait")
    return res.writeHead(429, { "retry-after": "3600" }).end("slow down");
  res
    .writeHead(200, { "content-type": "application/json" })
    .end(JSON.stringify({ ok: p }));
});
await new Promise<void>((r) => server.listen(0, r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => server.close());

test("200 med HTML ger HttpError i stället för krasch", async () => {
  await assert.rejects(
    getJson(`${base}/html`, { retries: 0 }),
    (e) => e instanceof HttpError && /inte JSON/.test(e.message),
  );
});

test("429 respekterar Retry-After och lyckas sedan", async () => {
  assert.deepEqual(await getJson(`${base}/limited`, { retries: 1 }), {
    ok: "/limited",
  });
  assert.equal(hits["/limited"], 2);
});

test("för lång Retry-After ger upp direkt", async () => {
  await assert.rejects(
    getJson(`${base}/long-wait`, { retries: 3, maxRetryAfterMs: 1000 }),
  );
  assert.equal(hits["/long-wait"], 1);
});

test("throttling håller avstånd mellan anrop mot samma host", async () => {
  clearHttpCache();
  const t0 = Date.now();
  await Promise.all([
    getJson(`${base}/a`, { minIntervalMs: 150 }),
    getJson(`${base}/b`, { minIntervalMs: 150 }),
  ]);
  assert.ok(Date.now() - t0 >= 140);
});

test("diskcache faller tillbaka på gammal kopia vid fel", async () => {
  assert.equal(await cached("k", 0, async () => "första"), "första");
  let staleCalled = false;
  const v = await cached(
    "k",
    0,
    async () => {
      throw new Error("429");
    },
    () => {
      staleCalled = true;
    },
  );
  assert.equal(v, "första");
  assert.ok(staleCalled);
});
