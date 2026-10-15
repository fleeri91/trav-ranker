/**
 * Rankingen för ett spel som PDF (A4, stående) – samma innehåll som dashboarden:
 * varje lopp med placering, startnummer, häst och kusk, poäng, vinstchans,
 * odds och spelvärde.
 *
 * Använder PDF:ens inbyggda Helvetica (å, ä, ö och – fungerar). Undvik tecken
 * utanför Latin-1, t.ex. "−" eller "↳" – de saknas i den inbyggda fonten.
 */
import PDFDocument from "pdfkit";
import type { GameRanking } from "../pipeline.ts";
import type { RankedRace, RankedRunner } from "../scoring/engine.ts";

export interface PdfMeta {
  date: string;
  /** När rankingen räknades fram (ms sedan epoch). */
  computedAt: number;
}

const C = {
  ink: "#18222e",
  muted: "#5e6b78",
  line: "#d9dfda",
  accent: "#1e6b4f",
  accentSoft: "#dcebe3",
  amber: "#9a6410",
};
const GOOD_VALUE = 1.15;
const LOW_CONFIDENCE = 0.6;

const PAGE = { margin: 40, top: 72, bottom: 54 };
/** Kolumner: x-position räknas fram från bredderna. */
const COLS = [
  { key: "rank", label: "", width: 20, align: "left" },
  { key: "nr", label: "Nr", width: 28, align: "left" },
  { key: "horse", label: "Häst och kusk", width: 213, align: "left" },
  { key: "points", label: "Poäng", width: 104, align: "right" },
  { key: "win", label: "Vinstchans", width: 52, align: "right" },
  { key: "odds", label: "Odds", width: 46, align: "right" },
  { key: "value", label: "Spelvärde", width: 52, align: "right" },
] as const;
type ColKey = (typeof COLS)[number]["key"];

const nf = (n: number, d: number) =>
  n.toLocaleString("sv-SE", {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });
const hhmm = (iso: string | null) =>
  iso && iso.length >= 16 ? iso.slice(11, 16) : "";
const startMethod = (m: string) =>
  m === "auto" ? "autostart" : m === "volte" ? "voltstart" : "";
const longDate = (date: string) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString("sv-SE", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

export function renderRankingPdf(
  game: GameRanking,
  meta: PdfMeta,
): Promise<Buffer> {
  const doc = new PDFDocument({
    size: "A4",
    bufferPages: true,
    margins: {
      top: PAGE.top,
      bottom: PAGE.bottom,
      left: PAGE.margin,
      right: PAGE.margin,
    },
    info: {
      Title: `Travranking ${game.gameType} ${meta.date}`,
      Subject: tracksOf(game),
      Creator: "trav-ranker",
    },
  });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const x0 = PAGE.margin;
  const colX = {} as Record<ColKey, number>;
  COLS.reduce((x, c) => ((colX[c.key] = x), x + c.width), x0);
  const contentWidth = COLS.reduce((s, c) => s + c.width, 0);
  const bottomLimit = () => doc.page.height - PAGE.bottom;

  if (!game.races.length) {
    doc
      .font("Helvetica")
      .fontSize(11)
      .fillColor(C.muted)
      .text("Spelet innehåller inga travlopp.", x0, PAGE.top);
  }

  game.races.forEach((race, i) => {
    const rows = race.runners.map((r) => ({
      runner: r,
      height: rowHeight(doc, r),
    }));
    const headH = 40;
    const raceH =
      headH +
      rows.reduce((s, r) => s + r.height, 0) +
      (race.scratched.length ? 14 : 0);
    const firstRows = rows.slice(0, 3).reduce((s, r) => s + r.height, 0);
    const fullPage = bottomLimit() - PAGE.top;
    if (i > 0) {
      const gap = 18;
      const fitsHere = doc.y + gap + raceH <= bottomLimit();
      const fitsOnFreshPage = raceH <= fullPage;
      const headFits = doc.y + gap + headH + firstRows <= bottomLimit();
      // Hela loppet på en sida om det går; annars minst rubrik + tre hästar.
      if (fitsHere || (!fitsOnFreshPage && headFits)) doc.y += gap;
      else doc.addPage();
    }

    drawRaceHeader(doc, race, x0, contentWidth);
    drawTableHeader(doc, colX, x0, contentWidth, race.sport === "monte");

    const max = Math.max(...race.runners.map((r) => r.points), 1);
    for (const { runner, height } of rows) {
      if (doc.y + height > bottomLimit()) {
        doc.addPage();
        doc
          .font("Helvetica-Bold")
          .fontSize(10)
          .fillColor(C.muted)
          .text(`Lopp ${race.number}, forts.`, x0, doc.y);
        doc.y += 4;
        drawTableHeader(doc, colX, x0, contentWidth, race.sport === "monte");
      }
      drawRow(doc, runner, colX, x0, contentWidth, height, max);
    }

    if (race.scratched.length) {
      doc
        .font("Helvetica")
        .fontSize(8)
        .fillColor(C.muted)
        .text(`Strukna: ${race.scratched.join(", ")}`, x0, doc.y + 4);
    }
  });

  drawPageChrome(doc, game, meta, x0, contentWidth);
  doc.end();
  return done;
}

function tracksOf(game: GameRanking): string {
  return [...new Set(game.races.map((r) => r.trackName))].join(" och ");
}

function notesOf(r: RankedRunner): string {
  const notes = [...r.notes];
  if (r.confidence < LOW_CONFIDENCE) notes.push("Lite data");
  return notes.join("  |  ");
}

const HORSE_TEXT_W = 213 - 6;

function rowHeight(doc: PDFKit.PDFDocument, r: RankedRunner): number {
  const notes = notesOf(r);
  const notesH = notes
    ? doc
        .font("Helvetica")
        .fontSize(7.5)
        .heightOfString(notes, { width: HORSE_TEXT_W }) + 2
    : 0;
  return 6 + 12 + 10 + notesH + 4;
}

function drawRaceHeader(
  doc: PDFKit.PDFDocument,
  race: RankedRace,
  x0: number,
  width: number,
) {
  const y = doc.y;
  doc
    .font("Helvetica-Bold")
    .fontSize(16)
    .fillColor(C.ink)
    .text(`Lopp ${race.number}`, x0, y, { lineBreak: false });
  const titleW = doc.widthOfString(`Lopp ${race.number}`);
  const meta = [
    race.trackName,
    [race.distance ? `${race.distance} m` : "", startMethod(race.startMethod)]
      .filter(Boolean)
      .join(" "),
    race.sport === "monte" ? "monté" : "",
    hhmm(race.startTime),
  ]
    .filter(Boolean)
    .join(", ");
  doc
    .font("Helvetica")
    .fontSize(10)
    .fillColor(C.muted)
    .text(meta, x0 + titleW + 10, y + 5, { lineBreak: false });

  if (race.topList === "stl") {
    const label = "STL-topplista";
    doc.fontSize(7.5);
    const w = doc.widthOfString(label) + 10;
    const x = x0 + width - w;
    doc
      .roundedRect(x, y + 3, w, 13, 6.5)
      .lineWidth(0.75)
      .strokeColor(C.line)
      .stroke();
    doc.fillColor(C.muted).text(label, x + 5, y + 6.5, { lineBreak: false });
  }
  doc.y = y + 26;
}

function drawTableHeader(
  doc: PDFKit.PDFDocument,
  colX: Record<ColKey, number>,
  x0: number,
  width: number,
  monte = false,
) {
  const y = doc.y;
  doc.font("Helvetica").fontSize(7.5).fillColor(C.muted);
  for (const c of COLS) {
    if (!c.label) continue;
    const label = monte && c.key === "horse" ? "Häst och ryttare" : c.label;
    doc.text(label, colX[c.key], y, {
      width: c.width,
      align: c.align,
      lineBreak: false,
    });
  }
  doc
    .moveTo(x0, y + 12)
    .lineTo(x0 + width, y + 12)
    .lineWidth(0.5)
    .strokeColor(C.line)
    .stroke();
  doc.y = y + 14;
}

function drawRow(
  doc: PDFKit.PDFDocument,
  r: RankedRunner,
  colX: Record<ColKey, number>,
  x0: number,
  width: number,
  height: number,
  max: number,
) {
  const y = doc.y;
  const top = y + 6;
  const lead = r.rank === 1;
  const midY = top + 6;

  // Placering
  doc
    .font("Helvetica-Bold")
    .fontSize(10)
    .fillColor(lead ? C.accent : C.muted)
    .text(String(r.rank), colX.rank, midY - 3, { lineBreak: false });

  // Startnummer
  const bx = colX.nr;
  const by = midY - 8;
  if (lead) doc.roundedRect(bx, by, 20, 18, 3).fill(C.accent);
  else
    doc.roundedRect(bx, by, 20, 18, 3).lineWidth(1).strokeColor(C.ink).stroke();
  doc
    .font("Helvetica-Bold")
    .fontSize(10)
    .fillColor(lead ? "#ffffff" : C.ink)
    .text(String(r.number), bx, by + 4.5, {
      width: 20,
      align: "center",
      lineBreak: false,
    });

  // Häst, kusk, noteringar
  const hx = colX.horse;
  const low = r.confidence < LOW_CONFIDENCE;
  doc
    .font("Helvetica-Bold")
    .fontSize(10)
    .fillColor(low ? C.muted : C.ink)
    .text(truncate(doc, r.horseName, HORSE_TEXT_W), hx, top, {
      lineBreak: false,
    });
  doc
    .font("Helvetica")
    .fontSize(8)
    .fillColor(C.muted)
    .text(truncate(doc, r.driverName, HORSE_TEXT_W), hx, top + 12.5, {
      lineBreak: false,
    });
  const notes = notesOf(r);
  if (notes) {
    doc
      .font("Helvetica")
      .fontSize(7.5)
      .fillColor(C.amber)
      .text(notes, hx, top + 23, { width: HORSE_TEXT_W });
  }

  // Poäng: stapel + siffra
  const px = colX.points;
  const barW = 60;
  doc.roundedRect(px + 4, midY - 1.5, barW, 4, 2).fill(C.line);
  doc
    .roundedRect(px + 4, midY - 1.5, Math.max(2, (r.points / max) * barW), 4, 2)
    .fill(lead ? C.accent : C.ink);
  doc
    .font("Helvetica-Bold")
    .fontSize(10)
    .fillColor(low ? C.muted : C.ink)
    .text(nf(r.points, 1), px, midY - 4, {
      width: 104,
      align: "right",
      lineBreak: false,
    });

  // Vinstchans, odds
  doc
    .font("Helvetica")
    .fontSize(9.5)
    .fillColor(C.ink)
    .text(
      r.winProbability < 0.005
        ? "<1 %"
        : `${Math.round(r.winProbability * 100)} %`,
      colX.win,
      midY - 4,
      {
        width: 52,
        align: "right",
        lineBreak: false,
      },
    )
    .text(r.odds ? nf(r.odds, 2) : "–", colX.odds, midY - 4, {
      width: 46,
      align: "right",
      lineBreak: false,
    });

  // Spelvärde
  if (r.value == null) {
    doc
      .fillColor(C.muted)
      .text("–", colX.value, midY - 4, {
        width: 52,
        align: "right",
        lineBreak: false,
      });
  } else {
    const text = nf(r.value, 2);
    if (r.value >= GOOD_VALUE) {
      doc.font("Helvetica-Bold").fontSize(9.5);
      const w = doc.widthOfString(text) + 10;
      doc
        .roundedRect(colX.value + 52 - w, midY - 7, w, 15, 3)
        .fill(C.accentSoft);
      doc
        .fillColor(C.accent)
        .text(text, colX.value, midY - 4, {
          width: 47,
          align: "right",
          lineBreak: false,
        });
    } else {
      doc
        .font("Helvetica")
        .fontSize(9.5)
        .fillColor(r.value < 0.85 ? C.muted : C.ink)
        .text(text, colX.value, midY - 4, {
          width: 52,
          align: "right",
          lineBreak: false,
        });
    }
  }

  doc
    .moveTo(x0, y + height)
    .lineTo(x0 + width, y + height)
    .lineWidth(0.5)
    .strokeColor(C.line)
    .stroke();
  doc.y = y + height;
}

function truncate(
  doc: PDFKit.PDFDocument,
  text: string,
  width: number,
): string {
  if (doc.widthOfString(text) <= width) return text;
  let t = text;
  while (t.length > 1 && doc.widthOfString(`${t}…`) > width) t = t.slice(0, -1);
  return `${t.trimEnd()}…`;
}

/** Sidhuvud och sidfot på alla sidor, när antalet sidor är känt. */
function drawPageChrome(
  doc: PDFKit.PDFDocument,
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
    // Tillfälligt utan nedre marginal, annars skapar texten i sidfoten en ny sida.
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;

    doc
      .font("Helvetica-Bold")
      .fontSize(13)
      .fillColor(C.ink)
      .text(`Travranking ${game.gameType}`, x0, 30, { lineBreak: false });
    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor(C.muted)
      .text(
        [tracksOf(game), longDate(meta.date)].filter(Boolean).join(", "),
        x0,
        46,
        { lineBreak: false },
      )
      .text(`Beräknad ${computed}`, x0, 30, {
        width,
        align: "right",
        lineBreak: false,
      });
    doc
      .moveTo(x0, 60)
      .lineTo(x0 + width, 60)
      .lineWidth(0.5)
      .strokeColor(C.line)
      .stroke();

    const fy = doc.page.height - 34;
    doc
      .font("Helvetica")
      .fontSize(7.5)
      .fillColor(C.muted)
      .text(
        "Spelvärde = modellens vinstchans delat med spelarnas. Över 1 betyder att modellen tror mer på hästen än oddset gör.",
        x0,
        fy,
        { width: width - 60, lineBreak: false },
      )
      .text(`Sida ${i - range.start + 1} av ${range.count}`, x0, fy, {
        width,
        align: "right",
        lineBreak: false,
      });

    doc.page.margins.bottom = bottom;
  }
}
