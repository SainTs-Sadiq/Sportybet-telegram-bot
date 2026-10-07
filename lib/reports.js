import PDFDocument from "pdfkit";
import * as XLSX from "xlsx";

const popular = ["1X2", "Double Chance", "Draw No Bet", "Over/Under", "GG/NG", "Corners - Over/Under", "1st Half - 1X2", "1st Half - Over/Under"];
function localTime(ms, timezone) { return new Intl.DateTimeFormat("en-GB", { timeZone: timezone, dateStyle: "short", timeStyle: "short", hour12: false }).format(new Date(ms)); }
function flatten(fixtures, timezone) {
  const rows = [];
  for (const f of fixtures) for (const m of f.markets) for (const o of m.outcomes) rows.push({Time:localTime(f.startMs,timezone),Sport:f.sport || "Football",League:f.league,Home:f.homeTeam,Away:f.awayTeam,Sport:f.sport || "Football",EventID:f.eventId,MarketID:m.id,Market:m.name,Specifier:m.specifier||"",Selection:o.name,OutcomeID:o.id,Odds:Number.isFinite(o.odds)?o.odds:"",Active:o.active?"Yes":"No"});
  return rows;
}
function autoWidth(rows) {
  if (!rows.length) return [];
  const keys=Object.keys(rows[0]);
  return keys.map(k=>({wch:Math.min(38,Math.max(10,Math.max(k.length,...rows.slice(0,400).map(r=>String(r[k]??"").length))+2))}));
}
export function makeXlsx(fixtures,timezone) {
  const wb=XLSX.utils.book_new(), all=flatten(fixtures,timezone);
  const games=fixtures.map(f=>({Time:localTime(f.startMs,timezone),League:f.league,Home:f.homeTeam,Away:f.awayTeam,EventID:f.eventId,Markets:f.markets.length}));
  const counts=new Map(); for(const f of fixtures) for(const m of f.markets) counts.set(m.name,(counts.get(m.name)||0)+1);
  const marketSummary=[...counts.entries()].sort((a,b)=>b[1]-a[1]).map(([Market,Games])=>({Market,Games}));
  const add=(rows,name)=>{const ws=XLSX.utils.json_to_sheet(rows);ws["!cols"]=autoWidth(rows);XLSX.utils.book_append_sheet(wb,ws,name);};
  add(games,"Games"); add(all,"All Markets"); add(marketSummary,"Market Summary");
  for(const name of popular){const rows=all.filter(r=>r.Market===name);if(rows.length)add(rows,name.replace(/[\\/?*\[\]:]/g,"").slice(0,31));}
  return XLSX.write(wb,{type:"buffer",bookType:"xlsx"});
}
export function makePdf(fixtures,timezone,title,filters={}) {
  return new Promise((resolve,reject)=>{
    const doc=new PDFDocument({size:"A4",margin:38,bufferPages:true}),chunks=[];
    doc.on("data",c=>chunks.push(c)); doc.on("error",reject);
    doc.on("end",()=>resolve(Buffer.concat(chunks)));
    doc.font("Helvetica-Bold").fontSize(19).text(title,{align:"center"}); doc.moveDown(.25);
    doc.font("Helvetica").fontSize(8).text(`Generated ${new Intl.DateTimeFormat("en-GB",{timeZone:timezone,dateStyle:"medium",timeStyle:"short"}).format(new Date())} • ${fixtures.length} games`,{align:"center"});
    if(filters.market||filters.league||filters.search){doc.moveDown(.2);doc.fontSize(8).text(`Filter: ${[filters.market,filters.league,filters.search].filter(Boolean).join(" • ")}`,{align:"center"});}
    doc.moveDown(.8);
    let index=0;
    for(const f of fixtures){index++;if(doc.y>700)doc.addPage();doc.font("Helvetica-Bold").fontSize(10).text(`${index}. ${f.homeTeam}  vs  ${f.awayTeam}`);doc.font("Helvetica").fontSize(8).fillOpacity(.7).text(`${f.sport || "Football"}  •  ${localTime(f.startMs,timezone)}  •  ${f.league}  •  Event ${f.eventId}`).fillOpacity(1);doc.moveDown(.25);
      for(const m of f.markets){if(doc.y>745)doc.addPage();doc.font("Helvetica-Bold").fontSize(7.5).text(`${m.name}${m.specifier?`  [${m.specifier}]`:""}`);doc.font("Helvetica").fontSize(7).text(m.outcomes.map(o=>`${o.name}: ${Number.isFinite(o.odds)?o.odds.toFixed(2):"—"}`).join("   •   ")||"No outcomes");}
      doc.moveDown(.45);doc.moveTo(38,doc.y).lineTo(557,doc.y).stroke();doc.moveDown(.45);
    }
    if(!fixtures.length)doc.fontSize(11).text("No fixtures found for the selected filters/date.");
    const pages=doc.bufferedPageRange();
    for(let i=0;i<pages.count;i++){doc.switchToPage(i);doc.fontSize(7).fillOpacity(.55).text(`SportyBet Markets • Page ${i+1} of ${pages.count}`,38,800,{width:519,align:"center"}).fillOpacity(1);}
    doc.fontSize(7).fillOpacity(.55).text("Odds are live data and can change. This bot retrieves data and generates reports; it does not place wagers.",38,785,{width:519,align:"center"}).fillOpacity(1);
    doc.end();
  });
}
