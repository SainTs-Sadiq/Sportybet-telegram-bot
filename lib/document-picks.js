import { extractText as extractPdfText } from "unpdf";
import { createWorker } from "tesseract.js";

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";

const EXTRACTION_PROMPT = `Read the attached betting tips document/image and extract ONLY the selections explicitly shown.
Return valid JSON only, with this shape:
{"selections":[{"sport":"football|basketball|tennis|other","homeTeam":"exact team/player 1 name","awayTeam":"exact team/player 2 name","match":"displayed fixture text","market":"market name exactly or as close as shown","selection":"chosen outcome exactly as shown","date":"date if visible, otherwise null","odds":number or null,"notes":"short ambiguity note or empty string"}],"documentNotes":"brief note"}
Rules:
- Do not invent missing selections or infer a tip from odds alone.
- For tennis, homeTeam/awayTeam mean the two player names.
- Preserve the intended market and line/specifier (e.g. Over 2.5, Asian Handicap -1.0, 1st Half).
- If a row is unclear, include it with a note; do not silently guess.
- Ignore commentary, suggested stakes, and accumulator total odds.
- Return an empty selections array if no actual picks are present.`;


function parseRowsFromText(text) {
  const lines=String(text||"").replace(/\r/g,"\n").split(/\n+/).map(s=>s.trim()).filter(Boolean);
  const rows=[];
  const marketPattern=/(1x2|\b12\b|double chance|draw no bet|over\s*[/ ]?under|total goals|both teams to score|gg\s*[/ ]?ng|btts|handicap|correct score|odd\s*[/ ]?even|first half|1st half|corners)/i;
  for(const line of lines) {
    if(/^(match|fixture|event|game)\s*(?:[|;\t,]|$)/i.test(line)) continue;
    const cells=(line.includes("|")?line.split("|"):line.includes("\t")?line.split("\t"):line.split(/\s{2,}/)).map(x=>x.trim()).filter(Boolean);
    if(cells.length<3) continue;
    const match=cells[0];
    let oddsIndex=-1;
    for(let i=cells.length-1;i>0;i--){if(/^\d+(?:\.\d+)?$/.test(cells[i])){oddsIndex=i;break;}}
    const odds=oddsIndex>0?Number(cells[oddsIndex]):null;
    const usable=cells.slice(1,oddsIndex>0?oddsIndex:undefined);
    const marketIndex=usable.findIndex(x=>marketPattern.test(x));
    let market="",selection="";
    if(marketIndex>=0) { market=usable[marketIndex]; selection=usable.find((x,i)=>i!==marketIndex && !marketPattern.test(x))||""; }
    else if(usable.length>=2) { market=usable[0]; selection=usable[1]; }
    if(!match||!market||!selection||/^(market|selection|odds|pick|outcome)$/i.test(market)) continue;
    const teams=match.split(/\s+(?:v\.?s?\.?|versus|@)\s+|\s+-\s+/i);
    const teamsUnclear=teams.length<2||!teams[0].trim()||!teams.slice(1).join("").trim();
    const marketUnclear=marketIndex<0;
    rows.push({index:rows.length+1,sport:"football",homeTeam:teams.length>1?teams[0].trim():"",awayTeam:teams.length>1?teams.slice(1).join(" vs ").trim():"",match,market,selection,date:null,odds,confidence:teamsUnclear||marketUnclear?"low":"ok",notes:teamsUnclear?"Fixture separator unclear; verify before booking.":"Extracted locally; verify fixture and market before booking."});
  }
  return rows.slice(0,100);
}
async function localExtract(buffer,mimeType) {
  let text="";
  if(mimeType==="application/pdf") {
    try {
      const result=await extractPdfText(new Uint8Array(buffer));
      const raw=Array.isArray(result?.text)?result.text.join("\n"):result?.text;
      text=String(raw||"");
    } catch(e) { console.warn("[pdf-text-extraction]",e.message); }
  } else {
    let worker;
    try { worker=await createWorker("eng"); const result=await worker.recognize(buffer); text=String(result.data?.text||""); }
    catch(e) { console.warn("[image-ocr]",e.message); }
    finally { if(worker) await worker.terminate().catch(()=>{}); }
  }
  return {text,selections:parseRowsFromText(text)};
}

const REPAIR_PROMPT = `You are helping repair a partially-parsed betting tips document.
The local parser already extracted most rows, but the rows listed below were flagged uncertain (unclear fixture separator or market). Re-read ONLY those rows from the attached document and return corrected versions.
Return valid JSON only: {"selections":[{"index":<the same index as the flagged row>,"sport":"football|basketball|tennis|other","homeTeam":"exact team/player 1 name","awayTeam":"exact team/player 2 name","match":"displayed fixture text","market":"market name exactly or as close as shown","selection":"chosen outcome exactly as shown","date":"date if visible, otherwise null","odds":number or null,"notes":"short ambiguity note or empty string"}]}
Rules:
- Keep the index of each flagged row. Do not invent rows with new indexes.
- Do not invent missing selections or infer a tip from odds alone.
- If a flagged row cannot be read confidently, return it with notes explaining why; do not guess.
- Ignore rows that were not flagged.`;

async function callGeminiForRows(buffer, mimeType, flaggedRows) {
  if (!process.env.GEMINI_API_KEY) return null;
  const model = process.env.GEMINI_MODEL || "gemini-3.8-flash";
  const flaggedSummary = flaggedRows.map(r => ({index:r.index, match:r.match, market:r.market, selection:r.selection, odds:r.odds, notes:r.notes}));
  let response = null, lastError = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [
          { text: REPAIR_PROMPT + "\n\nFlagged rows (JSON): " + JSON.stringify(flaggedSummary) },
          { inline_data: { mime_type: mimeType, data: buffer.toString("base64") } }
        ]}],
        generationConfig: { responseMimeType: "application/json", temperature: 0.1 }
      }),
      signal: AbortSignal.timeout(55000)
    });
    if (response.ok) break;
    lastError = await response.text().catch(() => "");
    if (![503, 429, 500].includes(response.status)) break;
    if (attempt < 2) await new Promise(r => setTimeout(r, 1200 * (attempt + 1)));
  }
  if (!response?.ok) {
    console.warn("[gemini-row-repair]", response?.status || "network", lastError.slice(0, 200));
    return null;
  }
  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed.selections) ? parsed.selections : null;
  } catch { return null; }
}

export async function extractSelectionsFromDocument(buffer, mimeType) {
  const allowed = new Set(["image/jpeg","image/png","image/webp","application/pdf"]);
  if (!allowed.has(mimeType)) throw new Error("Please upload a JPG, PNG, WEBP image or PDF.");
  if (!buffer?.length) throw new Error("The uploaded file was empty.");
  if (buffer.length > 18 * 1024 * 1024) throw new Error("File is too large. Please upload a file under 18 MB.");
  const local = await localExtract(buffer,mimeType);
  if(local.selections.length) {
    console.log("[document-local-extraction]",JSON.stringify({mimeType,textChars:local.text.length,selections:local.selections.length}));
    let selections=local.selections;
    const flagged=selections.filter(p=>p.confidence==="low");
    if(flagged.length && process.env.GEMINI_API_KEY) {
      const repaired=await callGeminiForRows(buffer,mimeType,flagged);
      if(Array.isArray(repaired)&&repaired.length) {
        const byIndex=new Map(repaired.filter(r=>Number.isFinite(Number(r.index))).map(r=>[Number(r.index),r]));
        let fixed=0;
        selections=selections.map(row=>{
          const better=byIndex.get(Number(row.index));
          if(!better || row.confidence!=="low") return row;
          const replacement={
            ...row,
            sport:String(better.sport||row.sport||"football").toLowerCase(),
            homeTeam:String(better.homeTeam||"").trim()||row.homeTeam,
            awayTeam:String(better.awayTeam||"").trim()||row.awayTeam,
            match:String(better.match||"").trim()||row.match,
            market:String(better.market||"").trim()||row.market,
            selection:String(better.selection||"").trim()||row.selection,
            odds:Number.isFinite(Number(better.odds))?Number(better.odds):row.odds,
            confidence:"ai",
            notes:("Re-read by AI; verify before booking. "+String(better.notes||"")).trim()
          };
          fixed++;
          return replacement;
        });
        console.log("[document-row-repair]",JSON.stringify({flagged:flagged.length,fixed}));
      }
    }
    return {documentNotes:"Extracted locally from PDF text/OCR. Review each selection before booking.",selections};
  }
  if (!process.env.GEMINI_API_KEY) {
    throw new Error(local.text.trim()
      ? "I extracted text, but could not safely identify pick rows. Paste the table using Match | Market | Selection | Odds."
      : "Local PDF/OCR extraction could not read the picks, and no GEMINI_API_KEY fallback is configured.");
  }
  const configuredModel = process.env.GEMINI_MODEL || "gemini-3.8-flash";
  const fallbackModel = process.env.GEMINI_FALLBACK_MODEL || "";
  const models = [...new Set([configuredModel, fallbackModel].filter(Boolean))];
  let response;
  let lastError = "";
  for (const model of models) {
    for (let attempt = 0; attempt < 3; attempt++) {
      response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [
            { text: EXTRACTION_PROMPT },
            { inline_data: { mime_type: mimeType, data: buffer.toString("base64") } }
          ]}],
          generationConfig: { responseMimeType: "application/json", temperature: 0.1 }
        }),
        signal: AbortSignal.timeout(55000)
      });
      if (response.ok) break;
      lastError = await response.text().catch(() => "");
      if (response.status !== 503 && response.status !== 429 && response.status !== 500) break;
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 1200 * (attempt + 1)));
    }
    if (response?.ok) break;
    if (response && ![503, 429, 500].includes(response.status)) break;
  }
  if (!response?.ok) {
    if (response && [503, 429, 500].includes(response.status)) {
      throw new Error("Gemini is temporarily overloaded or rate-limited. The bot retried automatically; please send the same file again in a minute. You can configure GEMINI_FALLBACK_MODEL in Vercel to enable a second model.");
    }
    throw new Error(`Document extraction failed (${response?.status || "network"}): ${lastError.slice(0,220)}`);
  }
  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw new Error("AI could not read the file as a structured list. Try a clearer image or PDF."); }
  const selections = Array.isArray(parsed.selections) ? parsed.selections : [];
  return {
    documentNotes: String(parsed.documentNotes || ""),
    selections: selections.slice(0, 100).map((p, i) => ({
      index: i + 1,
      sport: String(p.sport || "football").toLowerCase(),
      homeTeam: String(p.homeTeam || "").trim(),
      awayTeam: String(p.awayTeam || "").trim(),
      match: String(p.match || "").trim(),
      market: String(p.market || "").trim(),
      selection: String(p.selection || "").trim(),
      date: p.date ? String(p.date) : null,
      odds: Number.isFinite(Number(p.odds)) ? Number(p.odds) : null,
      notes: String(p.notes || "").trim(),
      confidence: "ai"
    })).filter(p => p.match || (p.homeTeam && p.awayTeam) || p.selection)
  };
}
