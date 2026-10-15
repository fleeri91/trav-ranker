/**
 * Lokal dashboard:  npm run dashboard  →  http://localhost:5173
 *
 * Visa en sparad ranking utan att anropa ATG:
 *   npm run rank -- --game V85 --json > ranking.json
 *   TRAV_FIXTURE=ranking.json npm run dashboard
 */
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  listGames,
  rankDay,
  type GameRanking,
  type GameSummary,
} from "./pipeline.ts";
import { renderRankingPdf } from "./export/pdf.ts";

const PORT = Number(process.env.PORT ?? 5173);
const HOST = "127.0.0.1";
const PAGE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "dashboard",
  "index.html",
);
/** Odds och strykningar ändras – räkna om efter så här lång tid. */
const RESULT_TTL_MS = 2 * 60_000;
const FIXTURE = process.env.TRAV_FIXTURE;

const results = new Map<string, { at: number; data: GameRanking }>();
const running = new Map<string, Promise<GameRanking>>();

const isDate = (s: string | null): s is string =>
  !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
const isGameId = (s: string | null): s is string =>
  !!s && /^[\w.:-]{1,80}$/.test(s);

async function loadFixture(): Promise<GameRanking[]> {
  return JSON.parse(
    await readFile(path.resolve(FIXTURE as string), "utf8"),
  ) as GameRanking[];
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

async function games(date: string): Promise<GameSummary[]> {
  if (!FIXTURE) return listGames(date);
  return (await loadFixture()).map((g) => ({
    id: g.gameId,
    type: g.gameType,
    startTime: g.races[0]?.startTime ?? null,
    tracks: [...new Set(g.races.map((r) => r.trackName))],
  }));
}

function compute(
  date: string,
  gameId: string,
  log: (m: string) => void,
): Promise<GameRanking> {
  const key = `${date}|${gameId}`;
  const existing = running.get(key);
  if (existing) {
    log("Beräkningen pågår redan – väntar på den");
    return existing;
  }
  const job = (async () => {
    if (FIXTURE) {
      const hit = (await loadFixture()).find((g) => g.gameId === gameId);
      if (!hit) throw new Error(`Spelet ${gameId} finns inte i ${FIXTURE}`);
      return hit;
    }
    const [game] = await rankDay({ date, gameIds: [gameId], log });
    if (!game) throw new Error(`Spelet ${gameId} finns inte ${date}`);
    results.set(key, { at: Date.now(), data: game });
    return game;
  })();
  running.set(key, job);
  job.finally(() => running.delete(key)).catch(() => {});
  return job;
}

/** Server-sent events: förlopp som 'log', sedan 'result' eller 'error'. */
async function streamRanking(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
) {
  const date = url.searchParams.get("date");
  const gameId = url.searchParams.get("game");
  if (!isDate(date) || !isGameId(gameId))
    return sendJson(res, 400, {
      error: "Ange date=ÅÅÅÅ-MM-DD och game=<spel-id>",
    });

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  let open = true;
  req.on("close", () => (open = false));
  const send = (event: string, data: unknown) => {
    if (open) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const cached = results.get(`${date}|${gameId}`);
  if (
    cached &&
    url.searchParams.get("fresh") !== "1" &&
    Date.now() - cached.at < RESULT_TTL_MS
  ) {
    send("result", { ...cached.data, computedAt: cached.at });
    return res.end();
  }

  try {
    const data = await compute(date, gameId, (m) => send("log", m.trim()));
    send("result", { ...data, computedAt: Date.now() });
  } catch (err) {
    send("error", { message: (err as Error).message });
  }
  res.end();
}

/**
 * PDF av rankingen. Exporterar det som visas i dashboarden: senast beräknade
 * resultat för spelet, oavsett ålder. Räknas bara fram om det inte finns.
 */
async function exportPdf(res: ServerResponse, url: URL) {
  const date = url.searchParams.get("date");
  const gameId = url.searchParams.get("game");
  if (!isDate(date) || !isGameId(gameId))
    return sendJson(res, 400, {
      error: "Ange date=ÅÅÅÅ-MM-DD och game=<spel-id>",
    });

  const key = `${date}|${gameId}`;
  let entry = results.get(key);
  if (!entry) {
    const data = await compute(date, gameId, () => {});
    entry = results.get(key) ?? { at: Date.now(), data };
  }
  const pdf = await renderRankingPdf(entry.data, {
    date,
    computedAt: entry.at,
  });
  const name = `travranking-${entry.data.gameType}-${date}.pdf`.replace(
    /[^\w.-]/g,
    "_",
  );
  res.writeHead(200, {
    "content-type": "application/pdf",
    "content-disposition": `attachment; filename="${name}"`,
    "content-length": pdf.length,
    "cache-control": "no-store",
  });
  res.end(pdf);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${HOST}`);
  try {
    if (req.method !== "GET")
      return sendJson(res, 405, { error: "Endast GET" });
    if (url.pathname === "/") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      return res.end(await readFile(PAGE));
    }
    if (url.pathname === "/api/games") {
      const date = url.searchParams.get("date");
      if (!isDate(date))
        return sendJson(res, 400, { error: "Ange date=ÅÅÅÅ-MM-DD" });
      return sendJson(res, 200, await games(date));
    }
    if (url.pathname === "/api/rankings")
      return await streamRanking(req, res, url);
    if (url.pathname === "/api/export.pdf") return await exportPdf(res, url);
    sendJson(res, 404, { error: "Finns inte" });
  } catch (err) {
    if (!res.headersSent) sendJson(res, 502, { error: (err as Error).message });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(
    `Dashboard: http://localhost:${PORT}${FIXTURE ? `  (sparad data från ${FIXTURE})` : ""}`,
  );
});
