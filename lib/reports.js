import PDFDocument from "pdfkit";
import * as XLSX from "xlsx";

const popular = ["1X2", "Double Chance", "Draw No Bet", "Over/Under", "GG/NG", "Corners - Over/Under", "1st Half - 1X2", "1st Half - Over/Under"];

function localTime(ms, timezone) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: timezone, dateStyle: "short", timeStyle: "short", hour12: false }).format(new Date(ms));
}

function flatten(fixtures, timezone) {
  const rows = [];
  for (const f of fixtures) for (const m of f.markets) for (const o of m.outcomes) rows.push({
    Time: localTime(f.startMs, timezone), League: f.league, Home: f.homeTeam, Away: f.awayTeam,
    EventID: f.eventId, MarketID: m.id, Market: m.name, Specifier: m.specifier || "",
    Selection: o.name, OutcomeID: o.id, Odds: Number.isFinite(o.odds) ? o.odds : "", Active: o.active ? "Yes" : "No"
  });
  return rows;
}

function autoWidth(rows) {
  if (!rows.length) return [];
  const keys = Object.keys(rows[0]);
  return keys.map(k => ({ wch: Math.min(38, Math.max(10, Math.max(k.length, ...rows.slice(0, 400).map(r => String(r[k] ?? "").length)) + 2)) }));
}

export function makeXlsx(fixtures, timezone) {
  const wb = XLSX.utils.book_new();
  const all = flatten(fixtures, timezone);
  const games = fixtures.map(f => ({ Time: localTime(f.startMs, timezone), League: f.league, Home: f.homeTeam, Away: f.awayTeam, EventID: f.eventId, Markets: f.markets.length }));
  const counts = new Map();
  for (const f of fixtures) for (const m of f.markets) counts.set(m.name, (counts.get(m.name) || 0) + 1);
  const marketSummary = [...counts.entries()].sort((a,b) => b[1]-a[1]).map(([Market, Games]) => ({Market, Games}));

  const wsGames = XLSX.utils.json_to_sheet(games); wsGames["!cols"] = autoWidth(games); XLSX.utils.book_append_sheet(wb, wsGames, "Games");
  const wsAll = XLSX.utils.json_to_sheet(all); wsAll["!cols"] = autoWidth(all); XLSX.utils.book_append_sheet(wb, wsAll, "All Markets");
  const wsSummary = XLSX.utils.json_to_sheet(marketSummary); wsSummary["!cols"] = autoWidth(marketSummary); XLSX.utils.book_append_sheet(wb, wsSummary, "Market Summary");

  for (const name of popular) {
    const rows = all.filter(r => r.Market === name);
    if (!rows.length) continue;
    const safe = name.replace(/[\\/?*\[\]:]/g, "").slice(0, 31);
    const ws = XLSX.utils.json_to_sheet(rows); ws["!cols"] = autoWidth(rows); XLSX.utils.book_append_sheet(wb, ws, safe);
  }
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

export function makePdf(fixtures, timezone, title, filters = {}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 38, bufferPages: true });
    const chunks = [];
    doc.on("data", c => chunks.push(c));
    doc.on("end", () => {
      const range = doc.bufferedPageRange();
      for (let i = 0; i < range.count; i++) {
        doc.switchToPage(i);
        doc.fontSize(7).fillOpacity(0.55).text(`SportyBet Markets • Page ${i + 1} of ${range.count}`, 38, 800, { width: 519, align: "center" }).fillOpacity(1);
      }
      resolve(Buffer.concat(chunks));
    });
    doc.on("error", reject);

    doc.font("Helvetica-Bold").fontSize(19).text(title, { align: "center" });
    doc.moveDown(0.25);
    doc.font("Helvetica").fontSize(8).text(`Generated ${new Intl.DateTimeFormat("en-GB", { timeZone: timezone, dateStyle: "medium", timeStyle: "short" }).format(new Date())} • ${fixtures.length} games`, { align: "center" });
    if (filters.market || filters.league || filters.search) {
      doc.moveDown(0.2); doc.fontSize(8).text(`Filter: ${[filters.market, filters.league, filters.search].filter(Boolean).join(" • ")}`, { align: "center" });
    }
    doc.moveDown(0.8);

    let index = 0;
    for (const f of fixtures) {
      index++;
      if (doc.y > 700) doc.addPage();
      doc.font("Helvetica-Bold").fontSize(10).text(`${index}. ${f.homeTeam}  vs  ${f.awayTeam}`);
      doc.font("Helvetica").fontSize(8).fillOpacity(0.7).text(`${localTime(f.startMs, timezone)}  •  ${f.league}  •  Event ${f.eventId}`).fillOpacity(1);
      doc.moveDown(0.25);
      for (const m of f.markets) {
        if (doc.y > 745) doc.addPage();
        doc.font("Helvetica-Bold").fontSize(7.5).text(`${m.name}${m.specifier ? `  [${m.specifier}]` : ""}`);
        const outcomes = m.outcomes.map(o => `${o.name}: ${Number.isFinite(o.odds) ? o.odds.toFixed(2) : "—"}`).join("   •   ");
        doc.font("Helvetica").fontSize(7).text(outcomes || "No outcomes");
      }
      doc.moveDown(0.45); doc.moveTo(38, doc.y).lineTo(557, doc.y).stroke(); doc.moveDown(0.45);
    }
    if (!fixtures.length) doc.fontSize(11).text("No fixtures found for the selected filters/date.");
    doc.fontSize(7).fillOpacity(0.55).text("Odds are live data and can change. This bot retrieves data and generates reports; it does not place wagers.", 38, 785, { width: 519, align: "center" }).fillOpacity(1);
    doc.end();
  });
}
