/**
 * Rankingen för ett spel som PDF (A4, stående) i dashboardens mörka design:
 * samma färger, typsnitt (Barlow och Barlow Condensed) och uppställning som
 * loppvyn – placering, startnummer, häst och kusk, poäng, vinstchans, odds
 * och spelvärde.
 *
 * Typsnitten ligger i assets/fonts (SIL Open Font License, se OFL.txt).
 */
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";
import type { GameRanking } from "../pipeline.ts";
import type { RankedRace, RankedRunner } from "../scoring/engine.ts";

export interface PdfMeta {
  date: string;
  /** När rankingen räknades fram (ms sedan epoch). */
  computedAt: number;
}

/** Samma tokens som :root i dashboard/index.html. */
const C = {
  bg: "#0b0f14",
  surface: "#131a22",
  raised: "#1a232d",
  line: "#26313d",
  lineSoft: "#1f2832",
  ink: "#e8edf2",
  ink2: "#c9d3de",
  muted: "#93a0ad",
  faint: "#6b7784",
  accent: "#7fa6ff",
  link: "#9db9ff",
  onLight: "#0b0f14",
  valSoft: "#1b2a4d",
  valStrong: "#3d6bff",
  rowStrong: "#162038",
};
/** Fylld etikett från detta spelvärde (se val). */
const GOOD_VALUE = 1.25;
/** I V-spel: vinstchans ÷ andel av insatserna i spelformen, annars mot vinnaroddsen. */
const val = (r: RankedRunner) => r.poolValue ?? r.value;
/** Under så här låg vinstchans är värdet för osäkert att lyfta fram. */
const MIN_CHANCE = 0.05;
const LOW_CONFIDENCE = 0.6;

const FONT_DIR = fileURLToPath(new URL("../../assets/fonts/", import.meta.url));
const FONTS = {
  regular: "Barlow-Regular",
  medium: "Barlow-Medium",
  semibold: "Barlow-SemiBold",
  bold: "Barlow-Bold",
  condSemibold: "BarlowCondensed-SemiBold",
  condBold: "BarlowCondensed-Bold",
} as const;
type Font = keyof typeof FONTS;

const PAGE = { margin: 32, top: 64, bottom: 48 };
const PAD = 14;
const RADIUS = 10;
/** Kolumner inne i kortet; hästkolumnen tar resten av bredden. */
const COLS = [
  { key: "rank", label: "Rank", width: 30, align: "center" },
  { key: "nr", label: "Nr", width: 30, align: "center" },
  { key: "horse", label: "Häst · kusk", width: 0, align: "left" },
  { key: "points", label: "Poäng", width: 100, align: "left" },
  { key: "win", label: "Vinst %", width: 50, align: "right" },
  // Egen rankning utan odds och spelprocent (ändras inte under dagen).
  { key: "own", label: "Egen", width: 36, align: "center" },
  { key: "odds", label: "Odds", width: 46, align: "right" },
  { key: "value", label: "Värde", width: 56, align: "right" },
] as const;
type ColKey = (typeof COLS)[number]["key"];
const GAP = 6;

const HEAD_H = 74;
const CONT_HEAD_H = 34;
const TABLE_HEAD_H = 22;
const SCRATCHED_H = 24;
const RACE_GAP = 14;

const nf = (n: number, d: number) =>
  n.toLocaleString("sv-SE", {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });
const hhmm = (iso: string | null) =>
  iso && iso.length >= 16 ? iso.slice(11, 16) : "";
const startMethod = (m: string) =>
  m === "auto" ? "Autostart" : m === "volte" ? "Voltstart" : "";
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const longDate = (date: string) =>
  cap(
    new Date(`${date}T12:00:00Z`).toLocaleDateString("sv-SE", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    }),
  );
const winPct = (p: number) => {
  const x = p * 100;
  if (x < 0.5) return "<1%";
  return `${x < 10 ? nf(x, 1) : Math.round(x)}%`;
};
const valuePct = (v: number) => Math.round((v - 1) * 100);
const valueText = (v: number) => {
  const p = valuePct(v);
  return `${p > 0 ? "+" : p < 0 ? "−" : ""}${Math.abs(p)}%`;
};

type Doc = PDFKit.PDFDocument;

export function renderRankingPdf(
  game: GameRanking,
  meta: PdfMeta,
): Promise<Buffer> {
  // Marginalerna är noll: all placering sker här, så pdfkit ska aldrig själv
  // bryta sida mitt i en text.
  const doc = new PDFDocument({
    size: "A4",
    bufferPages: true,
    margin: 0,
    info: {
      Title: `Travindex ${game.gameType} ${meta.date}`,
      Subject: tracksOf(game),
      Creator: "trav-ranker",
    },
  });
  for (const [name, file] of Object.entries(FONTS))
    doc.registerFont(name, `${FONT_DIR}${file}.ttf`);

  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const paint = () => {
    doc.rect(0, 0, doc.page.width, doc.page.height).fill(C.bg);
    doc.y = PAGE.top;
  };
  paint();
  doc.on("pageAdded", paint);

  const x0 = PAGE.margin;
  const width = doc.page.width - 2 * PAGE.margin;
  const bottom = () => doc.page.height - PAGE.bottom;

  drawSummary(doc, game, meta, x0, width);

  if (!game.races.length) {
    text(doc, "Spelet innehåller inga travlopp.", x0, doc.y, {
      font: "regular",
      size: 11,
      color: C.muted,
    });
  }

  game.races.forEach((race, i) => {
    const rows = race.runners.map((r) => ({
      runner: r,
      height: rowHeight(r),
    }));
    const tail = race.scratched.length ? SCRATCHED_H : 0;
    const full =
      HEAD_H + TABLE_HEAD_H + rows.reduce((s, r) => s + r.height, 0) + tail;
    if (i > 0) doc.y += RACE_GAP;
    const fitsHere = doc.y + full <= bottom();
    const fitsFresh = PAGE.top + full <= bottom();
    // Hela loppet på en sida om det går; annars minst rubrik + tre hästar.
    const firstRows = rows.slice(0, 3).reduce((s, r) => s + r.height, 0);
    if (
      !fitsHere &&
      (fitsFresh || doc.y + HEAD_H + TABLE_HEAD_H + firstRows > bottom())
    )
      doc.addPage();

    let from = 0;
    while (from < rows.length || from === 0) {
      const first = from === 0;
      const head = first ? HEAD_H : CONT_HEAD_H;
      let to = from;
      let h = head + TABLE_HEAD_H;
      for (let row = rows[to]; row && doc.y + h + row.height <= bottom(); ) {
        h += row.height;
        row = rows[++to];
      }
      if (to === from && to < rows.length) {
        // Ryms inte en enda häst: ny sida och försök igen.
        doc.addPage();
        continue;
      }
      const last = to === rows.length;
      if (last) h += tail;

      const top = doc.y;
      doc.roundedRect(x0, top, width, h, RADIUS).fill(C.surface);
      if (first) drawRaceHeader(doc, game, race, i, x0, top, width);
      else
        text(doc, `Lopp ${race.number}, forts.`, x0 + PAD, top + 10, {
          font: "condBold",
          size: 15,
          color: C.ink,
        });
      drawTableHeader(doc, race, x0, top + head, width);
      let y = top + head + TABLE_HEAD_H;
      for (const { runner, height } of rows.slice(from, to)) {
        drawRow(doc, runner, x0, y, width, height);
        y += height;
      }
      if (last && tail) {
        hline(doc, x0, x0 + width, y, C.lineSoft);
        text(doc, `Strukna: ${race.scratched.join(", ")}`, x0 + PAD, y + 7, {
          font: "regular",
          size: 8.5,
          color: C.muted,
        });
      }
      // Kantlinjen sist så att radernas bakgrund inte täcker den.
      doc
        .roundedRect(x0 + 0.5, top + 0.5, width - 1, h - 1, RADIUS)
        .lineWidth(1)
        .strokeColor(C.line)
        .stroke();

      doc.y = top + h;
      from = to;
      if (last) break;
      doc.addPage();
    }
  });

  drawPageChrome(doc, game, meta, x0, width);
  doc.end();
  return done;
}

/* ---------- Hjälpare ---------- */

interface TextOpts {
  font: Font;
  size: number;
  color: string;
  width?: number;
  align?: "left" | "right" | "center";
  spacing?: number;
}

function text(doc: Doc, s: string, x: number, y: number, o: TextOpts) {
  doc
    .font(o.font)
    .fontSize(o.size)
    .fillColor(o.color)
    .text(s, x, y, {
      width: o.width,
      align: o.align,
      lineBreak: false,
      characterSpacing: o.spacing,
    });
}

/** Text centrerad vertikalt kring y (ungefär som CSS line-height: 1). */
function textMid(doc: Doc, s: string, x: number, y: number, o: TextOpts) {
  text(doc, s, x, y - o.size * 0.62, o);
}

function widthOf(doc: Doc, s: string, font: Font, size: number, spacing = 0) {
  return (
    doc.font(font).fontSize(size).widthOfString(s) + spacing * s.length
  );
}

function hline(doc: Doc, x1: number, x2: number, y: number, color: string) {
  doc.moveTo(x1, y).lineTo(x2, y).lineWidth(1).strokeColor(color).stroke();
}

function truncate(doc: Doc, s: string, width: number): string {
  if (doc.widthOfString(s) <= width) return s;
  let t = s;
  while (t.length > 1 && doc.widthOfString(`${t}…`) > width) t = t.slice(0, -1);
  return `${t.trimEnd()}…`;
}

function tracksOf(game: GameRanking): string {
  return [...new Set(game.races.map((r) => r.trackName))].join(" och ");
}

function colLayout(x0: number, width: number) {
  const inner = width - 2 * PAD;
  const fixed = COLS.reduce((s, c) => s + c.width, 0) + GAP * (COLS.length - 1);
  const cols = {} as Record<ColKey, { x: number; w: number }>;
  let x = x0 + PAD;
  for (const c of COLS) {
    const w = c.width || inner - fixed;
    cols[c.key] = { x, w };
    x += w + GAP;
  }
  return cols;
}

const ROW_H = 36;
/** "Lite data" som grå etikett under kusken; noteringarna visas inte i PDF:en. */
const LITE = { label: "Lite data", size: 7.5, h: 12 };
const isLow = (r: RankedRunner) => r.confidence < LOW_CONFIDENCE;

function rowHeight(r: RankedRunner): number {
  return isLow(r) ? ROW_H + LITE.h + 3 : ROW_H;
}

/* ---------- Delar ---------- */

/** Spelets sammanfattning överst på första sidan (som kortet i "Dagens spel"). */
function drawSummary(
  doc: Doc,
  game: GameRanking,
  meta: PdfMeta,
  x0: number,
  width: number,
) {
  const top = doc.y;
  const h = 76;
  doc.roundedRect(x0, top, width, h, RADIUS).fill(C.surface);
  doc
    .roundedRect(x0 + 0.5, top + 0.5, width - 1, h - 1, RADIUS)
    .lineWidth(1)
    .strokeColor(C.line)
    .stroke();

  const mid = top + h / 2;
  text(doc, game.gameType, x0 + 20, mid - 22, {
    font: "condBold",
    size: 44,
    color: C.accent,
  });
  const idW = widthOf(doc, game.gameType, "condBold", 44);
  const tx = x0 + 20 + idW + 16;
  text(doc, tracksOf(game) || "–", tx, mid - 15, {
    font: "semibold",
    size: 13,
    color: C.ink,
  });
  text(doc, longDate(meta.date), tx, mid + 3, {
    font: "regular",
    size: 10,
    color: C.muted,
  });

  const first = game.races.map((r) => hhmm(r.startTime)).find(Boolean) ?? "–";
  const values = game.races.filter((race) =>
    race.runners.some(
      (r) => r.winProbability >= MIN_CHANCE && (val(r) ?? 0) >= GOOD_VALUE,
    ),
  ).length;
  const stats: [string, string, string][] = [
    ["Lopp", String(game.races.length), C.ink],
    ["Första start", first, C.ink],
    ["Värdelägen", String(values), C.link],
  ];
  let sx = x0 + width - 20;
  for (const [label, v, color] of stats.reverse()) {
    const w = Math.max(
      widthOf(doc, label.toUpperCase(), "semibold", 7.5, 0.5),
      widthOf(doc, v, "condBold", 22),
    );
    sx -= w;
    text(doc, label.toUpperCase(), sx, mid - 15, {
      font: "semibold",
      size: 7.5,
      color: C.muted,
      spacing: 0.5,
    });
    text(doc, v, sx, mid - 3, { font: "condBold", size: 22, color });
    sx -= 24;
  }
  doc.y = top + h + RACE_GAP + 4;
}

function chip(doc: Doc, s: string, x: number, y: number): number {
  const w = widthOf(doc, s, "regular", 8.5) + 14;
  doc
    .roundedRect(x + 0.5, y + 0.5, w - 1, 17, 5)
    .lineWidth(1)
    .strokeColor(C.line)
    .stroke();
  textMid(doc, s, x + 7, y + 9, { font: "regular", size: 8.5, color: C.ink2 });
  return w;
}

function drawRaceHeader(
  doc: Doc,
  game: GameRanking,
  race: RankedRace,
  i: number,
  x0: number,
  top: number,
  width: number,
) {
  const x = x0 + PAD;
  // Avdelningsetikett + bana
  const leg = `${game.gameType}-${i + 1}`;
  const legW = widthOf(doc, leg, "condBold", 10.5) + 12;
  doc.roundedRect(x, top + 12, legW, 15, 4).fill(C.accent);
  textMid(doc, leg, x + 6, top + 19.5, {
    font: "condBold",
    size: 10.5,
    color: C.onLight,
  });
  textMid(doc, race.trackName, x + legW + 8, top + 19.5, {
    font: "medium",
    size: 10,
    color: C.muted,
  });

  // Lopp N
  text(doc, `Lopp ${race.number}`, x, top + 31, {
    font: "condBold",
    size: 26,
    color: C.ink,
  });
  const titleW = widthOf(doc, `Lopp ${race.number}`, "condBold", 26);

  // Chips bredvid rubriken
  const chips = [
    race.distance ? `${race.distance} m` : "",
    startMethod(race.startMethod),
    `${race.runners.length} startande`,
    race.sport === "monte" ? "Monté" : "",
    race.topList === "stl" ? "STL-topplista" : "",
    race.monteList ? "Montétopplista" : "",
  ].filter(Boolean);
  let cx = x + titleW + 12;
  for (const c of chips) cx += chip(doc, c, cx, top + 41) + 6;

  // Starttid till höger
  const time = hhmm(race.startTime);
  if (time)
    text(doc, time, x0, top + 30, {
      font: "condBold",
      size: 28,
      color: C.ink,
      width: width - PAD,
      align: "right",
    });
}

function drawTableHeader(
  doc: Doc,
  race: RankedRace,
  x0: number,
  y: number,
  width: number,
) {
  const cols = colLayout(x0, width);
  doc.rect(x0, y, width, TABLE_HEAD_H).fill(C.raised);
  hline(doc, x0, x0 + width, y, C.line);
  for (const c of COLS) {
    const label =
      c.key === "horse"
        ? `Häst · ${race.sport === "monte" ? "ryttare" : "kusk"}`
        : c.label;
    textMid(doc, label.toUpperCase(), cols[c.key].x, y + TABLE_HEAD_H / 2, {
      font: "semibold",
      size: 7,
      color: C.muted,
      width: cols[c.key].w,
      align: c.align,
      spacing: 0.6,
    });
  }
}

function drawRow(
  doc: Doc,
  r: RankedRunner,
  x0: number,
  y: number,
  width: number,
  height: number,
) {
  const cols = colLayout(x0, width);
  const v = val(r);
  const strong = v != null && v >= GOOD_VALUE && r.winProbability >= MIN_CHANCE;
  const low = isLow(r);
  if (strong) doc.rect(x0, y, width, height).fill(C.rowStrong);
  hline(doc, x0, x0 + width, y, C.lineSoft);
  const mid = y + ROW_H / 2;

  // Placering: fylld cirkel för etta, tonad för två och tre
  const rc = cols.rank;
  const cx = rc.x + rc.w / 2;
  if (r.rank === 1) doc.circle(cx, mid, 10).fill(C.ink);
  else if (r.rank <= 3) doc.circle(cx, mid, 10).fill(C.line);
  textMid(doc, String(r.rank), rc.x, mid, {
    font: "condBold",
    size: 12,
    color: r.rank === 1 ? C.onLight : C.ink,
    width: rc.w,
    align: "center",
  });

  // Startnummer i ruta
  const nc = cols.nr;
  const bx = nc.x + (nc.w - 18) / 2;
  doc
    .roundedRect(bx + 0.6, mid - 9 + 0.6, 16.8, 16.8, 4)
    .lineWidth(1.2)
    .strokeColor(C.muted)
    .stroke();
  textMid(doc, String(r.number), bx, mid, {
    font: "condBold",
    size: 11,
    color: C.ink,
    width: 18,
    align: "center",
  });

  // Häst och kusk
  const hc = cols.horse;
  doc.font("condSemibold").fontSize(13);
  const name = truncate(doc, r.horseName, hc.w);
  text(doc, name, hc.x, mid - 13.5, {
    font: "condSemibold",
    size: 13,
    color: low ? C.ink2 : C.ink,
  });
  doc.font("regular").fontSize(8);
  text(doc, truncate(doc, r.driverName, hc.w), hc.x, mid + 2.5, {
    font: "regular",
    size: 8,
    color: C.muted,
  });

  // Lite data som grå etikett under raden
  if (low) {
    const w = widthOf(doc, LITE.label, "medium", LITE.size) + 12;
    const ty = y + ROW_H - 1;
    doc
      .roundedRect(hc.x + 0.5, ty + 0.5, w - 1, LITE.h - 1, LITE.h / 2)
      .lineWidth(1)
      .strokeColor(C.line)
      .stroke();
    textMid(doc, LITE.label, hc.x + 6, ty + LITE.h / 2, {
      font: "medium",
      size: LITE.size,
      color: C.muted,
    });
  }

  // Poäng: siffra + stapel (0–100)
  const pc = cols.points;
  textMid(doc, nf(r.points, 1), pc.x, mid, {
    font: "condBold",
    size: 13,
    color: low ? C.ink2 : C.ink,
  });
  const barX = pc.x + 34;
  const barW = pc.w - 34 - 6;
  doc.roundedRect(barX, mid - 2, barW, 4, 2).fill(C.line);
  const fill = (Math.max(0, Math.min(100, r.points)) / 100) * barW;
  if (fill > 0) doc.roundedRect(barX, mid - 2, Math.max(4, fill), 4, 2).fill(C.ink2);

  // Vinstchans och odds
  textMid(doc, winPct(r.winProbability), cols.win.x, mid, {
    font: "condSemibold",
    size: 13,
    color: C.ink,
    width: cols.win.w,
    align: "right",
  });
  textMid(doc, String(r.own.rank), cols.own.x, mid, {
    font: r.own.rank <= 3 ? "condSemibold" : "regular",
    size: 11,
    color: r.own.rank <= 3 ? C.ink : C.ink2,
    width: cols.own.w,
    align: "center",
  });
  textMid(doc, r.odds ? nf(r.odds, 2) : "–", cols.odds.x, mid, {
    font: "regular",
    size: 10,
    color: C.ink2,
    width: cols.odds.w,
    align: "right",
  });

  // Spelvärde som etikett: fylld från GOOD_VALUE, tonad när positivt
  const vc = cols.value;
  if (v == null) {
    textMid(doc, "–", vc.x, mid, {
      font: "condBold",
      size: 12,
      color: C.muted,
      width: vc.w - 5,
      align: "right",
    });
  } else {
    const s = valueText(v);
    const p = valuePct(v);
    const w = widthOf(doc, s, "condBold", 12) + 10;
    const bx2 = vc.x + vc.w - w;
    if (strong) doc.roundedRect(bx2, mid - 8, w, 16, 4).fill(C.valStrong);
    else if (p > 0) doc.roundedRect(bx2, mid - 8, w, 16, 4).fill(C.valSoft);
    textMid(doc, s, bx2 + 5, mid, {
      font: "condBold",
      size: 12,
      color: strong ? "#ffffff" : p > 0 ? C.link : C.muted,
    });
  }
}

/** Sidhuvud och sidfot på alla sidor, när antalet sidor är känt. */
function drawPageChrome(
  doc: Doc,
  game: GameRanking,
  meta: PdfMeta,
  x0: number,
  width: number,
) {
  const range = doc.bufferedPageRange();
  const computed = new Date(meta.computedAt).toLocaleString("sv-SE", {
    timeZone: "Europe/Stockholm",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);

    // Logotyp: samma ikon som i dashboardens toppfält
    const iy = 22;
    doc
      .save()
      .translate(x0, iy)
      .scale(0.75)
      .path("M3 18h18 M5 14l4-6 4 4 6-8")
      .lineWidth(2.4)
      .lineCap("round")
      .lineJoin("round")
      .strokeColor(C.accent)
      .stroke()
      .restore();
    text(doc, "TRAVINDEX", x0 + 24, iy + 2, {
      font: "condBold",
      size: 17,
      color: C.ink,
      spacing: 0.3,
    });
    text(
      doc,
      `${game.gameType} · ${longDate(meta.date)} · Beräknad ${computed}`,
      x0,
      iy + 5,
      { font: "regular", size: 8.5, color: C.muted, width, align: "right" },
    );
    hline(doc, 0, doc.page.width, 50, C.lineSoft);

    const fy = doc.page.height - 30;
    hline(doc, x0, x0 + width, fy - 8, C.lineSoft);
    text(
      doc,
      game.races.some((r) => r.pool)
        ? `Värde jämför modellens vinstchans med hur mycket hästen är spelad i ${game.gameType}. Positivt = underspelad: vinner oftare än spelarna tror. Fylld etikett = +${valuePct(GOOD_VALUE)}% eller mer.`
        : `Värde jämför modellens vinstchans med marknadens (vinnaroddsen). Positivt betyder att modellen tror mer på hästen än spelarna gör; fylld etikett = +${valuePct(GOOD_VALUE)}% eller mer.`,
      x0,
      fy,
      { font: "regular", size: 7, color: C.faint, width: width - 70 },
    );
    text(doc, `Sida ${i - range.start + 1} av ${range.count}`, x0, fy, {
      font: "medium",
      size: 7.5,
      color: C.muted,
      width,
      align: "right",
    });
  }
}
