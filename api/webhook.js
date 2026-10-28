import { getFixtures, filterByDay, createBooking } from "../lib/sportybet.js";
import { makePdf, makeXlsx } from "../lib/reports.js";
import { impliedProbability } from "../lib/football.js";
import { getTeamFormAnalysis, blendFormAndMarket } from "../lib/team-history.js";
import { marketCandidates, marketCandidatesFromOdds, marketCandidatesFromAllOdds, rankWithAI, combinedOdds } from "../lib/ai.js";
import { SPORTS, SPORT_ORDER, sportLabel, getSport } from "../lib/sports.js";
import { extractSelectionsFromDocument } from "../lib/document-picks.js";
import { storeEnabled, kvGet, kvSet, kvSetNx, kvDel } from "../lib/store.js";
import { getFixturesCached } from "../lib/fixture-cache.js";
import { waitUntil } from "@vercel/functions";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SECRET = process.env.BOT_SECRET;
const TZ = process.env.REPORT_TIMEZONE || "Africa/Lagos";

const cache = new Map();
const bookingSessions = new Map();
const documentSessions = new Map();
const cacheKey = (sport, day) => `${sport}:${day}`;

async function tg(method, body) {
  return fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body)
  });
}
async function sendText(chatId,text,replyMarkup){
  const body={chat_id:chatId,text}; if(replyMarkup) body.reply_markup=replyMarkup; return tg("sendMessage",body);
}
async function answerCallback(id){ return tg("answerCallbackQuery",{callback_query_id:id}); }
async function sendDocument(chatId,buffer,filename,caption){
  const form=new FormData(); form.append("chat_id",String(chatId)); form.append("caption",caption);
  form.append("document",new Blob([buffer]),filename);
  return fetch(`https://api.telegram.org/bot${TOKEN}/sendDocument`,{method:"POST",body:form});
}

const MAIN_MENU={inline_keyboard:[
  [{text:"⚽ Football — Today",callback_data:"sport_football_today"},{text:"⚽ Football — Tomorrow",callback_data:"sport_football_tomorrow"}],
  [{text:"🏀 Basketball — Today",callback_data:"sport_basketball_today"},{text:"🏀 Basketball — Tomorrow",callback_data:"sport_basketball_tomorrow"}],
  [{text:"📄 PDF — Today",callback_data:"pdf_today"},{text:"📄 PDF — Tomorrow",callback_data:"pdf_tomorrow"}],
  [{text:"📊 Excel — Today",callback_data:"excel_today"},{text:"📊 Excel — Tomorrow",callback_data:"excel_tomorrow"}],
  [{text:"🏆 Leagues",callback_data:"leagues"},{text:"📈 Markets",callback_data:"markets"}],
  [{text:"🔎 Search",callback_data:"search_help"},{text:"ℹ️ Help",callback_data:"help"}],
  [{text:"⛔ Force stop",callback_data:"force_stop"}]
]};

const SPORT_MENU=()=>({inline_keyboard:[
  ...SPORT_ORDER.map(k=>[
    {text:`${SPORTS[k].label} — Today`,callback_data:`sport_${k}_today`},
    {text:`${SPORTS[k].label} — Tomorrow`,callback_data:`sport_${k}_tomorrow`}
  ]),
  [{text:"⬅️ Main menu",callback_data:"menu"}]
]});

function dateForOffset(offset){
  const now=new Date();
  const parts=new Intl.DateTimeFormat("en-CA",{timeZone:TZ,year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(now);
  const y=parts.find(x=>x.type==="year").value,m=parts.find(x=>x.type==="month").value,d=parts.find(x=>x.type==="day").value;
  const dt=new Date(`${y}-${m}-${d}T12:00:00Z`); dt.setUTCDate(dt.getUTCDate()+offset); return dt.toISOString().slice(0,10);
}

async function loadSportDay(sport,offset){
  const key=cacheKey(sport,offset);
  const hit=cache.get(key);
  if(hit && Date.now()-hit.at<45000) return hit.fixtures;
  const cfg=getSport(sport); if(!cfg) throw new Error(`Unsupported sport: ${sport}`);
  const raw=await getFixtures({hours:offset?72:48,pageSize:100,maxPages:10,sportId:cfg.sportId});
  const expectedSportId=cfg.sportId;
  // If SportyBet supplies sport metadata, reject events that contradict the requested sport.
  const verified=raw.filter(f=>!f.sourceSportId || String(f.sourceSportId)===expectedSportId);
  const fixtures=filterByDay(verified,offset,TZ).map(f=>({...f,sport:sportLabel(sport)}));
  console.log("[fixtures-day-debug]", JSON.stringify({ sport, offset, requestedSportId:expectedSportId, rawCount:raw.length, verifiedCount:verified.length, dayCount:fixtures.length, timezone:TZ }));
  cache.set(key,{at:Date.now(),fixtures}); return fixtures;
}

const formRequestCache = new Map();
async function enrichCandidatesWithForm(fixtures,candidates,maxLeagues=30) {
  const byEvent = new Map(fixtures.map(f=>[String(f.eventId),f]));
  const leagueNames = [...new Set(fixtures.map(f=>f.league).filter(Boolean))].slice(0,maxLeagues);
  const analyses = new Map();
  // Kick form requests off concurrently (capped) instead of awaiting each one;
  // serial awaits dominated AI-pick generation time.
  const CONCURRENCY = 8;
  const pending = [];
  for (const fixture of fixtures) {
    if (!leagueNames.includes(fixture.league) || analyses.has(String(fixture.eventId))) continue;
    const key = [fixture.league,fixture.homeTeam,fixture.awayTeam].join("|");
    let promise=formRequestCache.get(key);
    if(!promise){promise=getTeamFormAnalysis(fixture).catch(e=>{console.warn("[team-form-analysis]",fixture.league,e.message);return null;});formRequestCache.set(key,promise);}
    pending.push({fixture,promise});
  }
  for (let i=0;i<pending.length;i+=CONCURRENCY) {
    const batch=pending.slice(i,i+CONCURRENCY);
    const forms=await Promise.all(batch.map(x=>x.promise));
    batch.forEach((x,i2)=>{ if(forms[i2]) analyses.set(String(x.fixture.eventId),forms[i2]); });
  }
  const enriched=candidates.map(p=>{
    const fixture=byEvent.get(String(p.eventId)), form=analyses.get(String(p.eventId));
    if(!fixture||!form) return {...p,formDataAvailable:false,analysisSource:"market-only"};
    const result=blendFormAndMarket(form,[{...p,homeTeam:fixture.homeTeam,awayTeam:fixture.awayTeam}])[0];
    return {...result,formDataAvailable:Boolean(result.formDataAvailable),recentForm:form};
  });
  console.log("[team-form-summary]",JSON.stringify({fixtures:fixtures.length,candidates:candidates.length,withForm:enriched.filter(p=>p.formDataAvailable).length}));
  return enriched;
}

// Force stop: when set, every incoming update is ignored until it expires or
// the user taps Resume. Guards against loop actions or repeated responses.
const SESSION_TTL = 6 * 60 * 60;
const STOP_KEY = "sb:force_stop";
const STOP_TTL_SECONDS = 30 * 60;
async function isForceStopped() {
  try { return (await kvGet(STOP_KEY)) === true; } catch { return false; }
}

// Minimal in-memory slip store used by the document flow only
// (upload -> match -> confirm -> code).
function getBookingSession(chatId) {
  if (!bookingSessions.has(String(chatId))) bookingSessions.set(String(chatId), { fixtures: [], selections: [], pendingEvent: null });
  return bookingSessions.get(String(chatId));
}

async function persistSessions(chatId) {
  if (!storeEnabled) return;
  const key = String(chatId);
  const doc = documentSessions.get(key);
  if (doc) await kvSet(`sb:document:${key}`, doc, SESSION_TTL);
}

async function hydrateSessions(chatId) {
  if (!storeEnabled) return;
  const key = String(chatId);
  try {
    if (!documentSessions.has(key)) {
      const saved = await kvGet(`sb:document:${key}`);
      if (saved && typeof saved === "object") documentSessions.set(key, saved);
    }
  } catch (e) { console.warn("[session-hydrate]", e?.message || String(e)); }
}

async function loadDay(sport,offset){
  if(sport!=="all") return loadSportDay(sport,offset);
  const all=[];
  for(const key of SPORT_ORDER) all.push(...await loadSportDay(key,offset));
  // Some provider endpoints can overlap; don't count the same event more than once.
  const unique=new Map();
  for(const fixture of all) {
    const key=fixture.eventId || `${fixture.sportId}:${fixture.startMs}:${fixture.homeTeam}:${fixture.awayTeam}`;
    if(!unique.has(key)) unique.set(key,fixture);
  }
  return [...unique.values()].sort((a,b)=>a.startMs-b.startMs);
}

function reportSummary(fixtures,label){
  const markets=fixtures.reduce((n,f)=>n+(f.markets||[]).length,0);
  const outcomes=fixtures.reduce((n,f)=>n+(f.markets||[]).reduce((a,m)=>a+(m.outcomes||[]).length,0),0);
  const bySport={};
  for(const f of fixtures) bySport[f.sport]=(bySport[f.sport]||0)+1;
  const sportLines=Object.entries(bySport).map(([s,n])=>`${s}: ${n}`).join("\n");
  return `📋 ${label}\n\n${sportLines||"No fixtures found."}\n\nTotal games: ${fixtures.length}\nMarket groups: ${markets}\nSelections/outcomes: ${outcomes}`;
}

function menuTitle(sport,offset){
  return sport==="all" ? `🌎 ALL SPORTS — ${offset?"TOMORROW":"TODAY"}` : `${sportLabel(sport)} — ${offset?"TOMORROW":"TODAY"}`;
}

async function runReport(chatId,action,sport="all"){
  const offset=action.includes("tomorrow")?1:0;
  const isPdf=action.startsWith("pdf"), isExcel=action.startsWith("excel");
  await sendText(chatId,`⏳ Fetching ${menuTitle(sport,offset)}...`);
  const fixtures=await loadDay(sport,offset);
  if(!isPdf&&!isExcel){
    return sendText(chatId,`${reportSummary(fixtures,menuTitle(sport,offset))}\n\nChoose another option:`,SPORT_MENU());
  }
  await sendText(chatId,`⏳ Building ${isPdf?"PDF":"Excel"} for ${fixtures.length} games...`);
  if(isPdf){
    const b=await makePdf(fixtures,TZ,`SportyBet ${sport==="all"?"All Sports":sportLabel(sport)} Markets — ${offset?"Tomorrow":"Today"}`);
    return sendDocument(chatId,b,`sportybet-${sport}-${offset?"tomorrow":"today"}.pdf`,`📄 ${menuTitle(sport,offset)} • ${fixtures.length} games`);
  }
  const b=makeXlsx(fixtures,TZ);
  return sendDocument(chatId,b,`sportybet-${sport}-${offset?"tomorrow":"today"}.xlsx`,`📊 ${menuTitle(sport,offset)} • ${fixtures.length} games`);
}

function normText(value) {
  return String(value || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g," ").trim();
}

function parsePastedPicks(raw) {
  const rows=[];
  const lines=String(raw||"").replace(/\r\n/g,"\n").split(/\n/).map(x=>x.trim()).filter(Boolean);
  for (const line of lines) {
    if (/^(match|fixture|game|event)\s*(?:\||;|\t|$)/i.test(line) || /^[-|+\s:]+$/.test(line)) continue;
    const cells=(line.includes("|")?line.split("|"):line.includes("\t")?line.split("\t"):line.split(";")).map(x=>x.trim()).filter(Boolean);
    if(cells.length<3) continue;
    const match=cells[0], market=cells[1], selection=cells[2];
    if (/^(match|fixture|game|event)$/i.test(match) || /^(market)$/i.test(market) || /^(selection|pick|outcome)$/i.test(selection)) continue;
    const oddsCell=cells.slice(3).find(x=>/^\d+(?:\.\d+)?$/.test(x));
    const odds=oddsCell?Number(oddsCell):null;
    const teams=match.split(/\s+(?:v\.?s?\.?|versus|@)\s+|\s+-\s+/i);
    if(!market||!selection||!match) continue;
    const homeTeam=teams.length>1?teams[0].trim():"";
    const awayTeam=teams.length>1?teams.slice(1).join(" vs ").trim():"";
    rows.push({index:rows.length+1,sport:"football",homeTeam,awayTeam,match,market,selection,date:null,odds,notes:teams.length>1?"Parsed from pasted text; confirm market matching.":"Fixture separator unclear; verify before booking."});
  }
  return rows.slice(0,100);
}
async function receivePastedPicks(chatId, raw) {
  const selections=parsePastedPicks(raw);
  if(!selections.length) return false;
  documentSessions.set(String(chatId),{selections,documentNotes:"Parsed directly from pasted text without Gemini.",createdAt:Date.now(),filename:"pasted-picks"});
  const lines=selections.slice(0,35).map(p=>`${p.index}. ${p.match}\n   🎯 ${p.market}: ${p.selection}${p.odds ? ` @ ${p.odds}` : ""}`);
  const more=selections.length>35?`\n…and ${selections.length-35} more selections.`:"";
  await sendText(chatId,`🧾 PASTED PICKS — REVIEW\n\nParsed ${selections.length} selection(s) directly from your message.\n\n${lines.join("\n\n")}${more}\n\nReview these rows before matching against live SportyBet markets.`,{inline_keyboard:[[{text:"🔎 Match picks & prepare slip",callback_data:"doc_prepare"}],[{text:"🗑 Discard picks",callback_data:"doc_cancel"}],[{text:"⬅️ Main menu",callback_data:"menu"}]]});
  return true;
}
function teamTokens(value) {
  return new Set(normText(value).split(" ").filter(x=>x.length>1));
}
function teamSim(a,b) {
  const A=teamTokens(a),B=teamTokens(b);
  if(!A.size||!B.size) return 0;
  let hit=0; for(const x of A) if(B.has(x)) hit++;
  return hit/Math.max(A.size,B.size);
}
function teamMatch(a,b) {
  const x=normText(a), y=normText(b);
  return Boolean(x&&y&&(x===y||x.includes(y)||y.includes(x)));
}
async function downloadTelegramFile(fileId) {
  const metaRes=await fetch(`https://api.telegram.org/bot${TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`);
  const meta=await metaRes.json();
  if(!metaRes.ok||!meta.ok||!meta.result?.file_path) throw new Error("Telegram could not retrieve that upload. Please send it again.");
  const fileRes=await fetch(`https://api.telegram.org/file/bot${TOKEN}/${meta.result.file_path}`,{signal:AbortSignal.timeout(25000)});
  if(!fileRes.ok) throw new Error("Unable to download the uploaded file from Telegram.");
  const arr=await fileRes.arrayBuffer();
  if(arr.byteLength>18*1024*1024) throw new Error("File is too large. Please send a file under 18 MB.");
  return Buffer.from(arr);
}
async function receiveDocument(chatId,msg) {
  let fileId, mimeType, name;
  if(msg.photo?.length) {
    fileId=msg.photo[msg.photo.length-1].file_id; mimeType="image/jpeg"; name="telegram-photo.jpg";
  } else if(msg.document) {
    fileId=msg.document.file_id; mimeType=String(msg.document.mime_type||"").toLowerCase(); name=msg.document.file_name||"upload";
    if(mimeType==="application/octet-stream"||!mimeType) {
      const ext=name.toLowerCase().split(".").pop();
      mimeType=ext==="pdf"?"application/pdf":(["jpg","jpeg"].includes(ext)?"image/jpeg":ext==="png"?"image/png":ext==="webp"?"image/webp":"");
    }
  } else return false;
  if(!["image/jpeg","image/png","image/webp","application/pdf"].includes(mimeType)) {
    await sendText(chatId,"Please upload a screenshot (JPG, PNG or WEBP) or a PDF containing your picks.");
    return true;
  }
  await sendText(chatId,`📥 Received ${name}. Reading the fixtures, markets and selected outcomes now...`);
  const buffer=await downloadTelegramFile(fileId);
  const extracted=await extractSelectionsFromDocument(buffer,mimeType);
  if(!extracted.selections.length) {
    await sendText(chatId,"I couldn't identify any clear selections in that file. Try a sharper screenshot or a PDF with the picks and markets visible.");
    return true;
  }
  const session={...extracted,createdAt:Date.now(),filename:name};
  documentSessions.set(String(chatId),session);
  const lines=extracted.selections.slice(0,35).map(p=>`${p.index}. ${p.match||`${p.homeTeam} vs ${p.awayTeam}`}
   🎯 ${p.market||"Market unclear"}: ${p.selection||"Selection unclear"}${p.odds?` @ ${p.odds}`:""}${p.confidence==="low"?`\n   ⚠️ Low confidence — will be double-checked by AI before matching`:p.confidence==="ai"?`\n   ✅ Re-read by AI — verify before booking`:p.notes?`\n   ⚠️ ${p.notes}`:""}`);
  const more=extracted.selections.length>35?`\n...and ${extracted.selections.length-35} more selections.`:"";
  await sendText(chatId,`🧾 EXTRACTED PICKS — REVIEW BEFORE BOOKING

Found ${extracted.selections.length} selection(s) in ${name}.

${lines.join("\n\n")}${more}

Please review the extracted text. When you continue, I will match each pick against live SportyBet fixtures and markets. Anything uncertain or unavailable will be flagged; it won't be silently substituted.`,{inline_keyboard:[
    [{text:"🔎 Match picks & prepare slip",callback_data:"doc_prepare"}],
    [{text:"🗑 Discard upload",callback_data:"doc_cancel"}],
    [{text:"⬅️ Main menu",callback_data:"menu"}]
  ]});
  return true;
}
async function prepareDocumentSlip(chatId) {
  const doc=documentSessions.get(String(chatId));
  if(!doc) return sendText(chatId,"No uploaded document is waiting. Send a screenshot or PDF first.",MAIN_MENU);
  await sendText(chatId,"🔎 Matching the extracted picks against live SportyBet fixtures and markets. This can take a little while...");
  // Search the full upcoming SportyBet feed, not a hard-coded calendar date.
  // Load only sports represented by the uploaded/pasted picks, and search a broad
  // 30-day horizon with pagination. Keep all future fixtures returned by the feed.
  // Pick documents mislabel sports (the local parser tags rows "football" by
  // default), so always load every enabled sport and try each.
  const sportKeys=[...SPORT_ORDER];
  const bySport=new Map();
  const fixtureLoads=await Promise.allSettled(sportKeys.map(async key=>{
    const cfg=SPORTS[key];
    const fixtures=await getFixturesCached(getFixtures,{hours:720,pageSize:100,maxPages:20,sportId:cfg.sportId});
    return [key,fixtures.filter(f=>Number(f.startMs)>Date.now())];
  }));
  fixtureLoads.forEach((result,i)=>{
    const key=sportKeys[i];
    if(result.status==="fulfilled") bySport.set(result.value[0],result.value[1]);
    else { console.warn("[document-picks-fixtures]",key,result.reason?.message||String(result.reason)); bySport.set(key,[]); }
  });
  console.log("[document-picks-load-summary]",JSON.stringify({horizonHours:720,pagesPerSport:20,counts:Object.fromEntries([...bySport].map(([k,v])=>[k,v.length]))}));
  const matched=[], issues=[];
  for(const originalPick of doc.selections) {
    // Preserve the source accumulator's explicit "12 / Either Team to Win" intent
    // without hardcoding any specific fixtures.
    const pick={...originalPick};
    const explicit12=normText(pick.market)==="12" ||
      normText(pick.selection)==="either team to win" ||
      normText(pick.selection)==="home or away" ||
      normText(pick.selection)==="no draw";
    if(explicit12) {
      pick.market="Double Chance";
      pick.selection="12";
    }
    const likelySport=SPORTS[pick.sport]?pick.sport:"football";
    const candidateSports=likelySport==="other"?sportKeys:[likelySport,...sportKeys.filter(s=>s!==likelySport)];
    const parts=String(pick.match||"").split(/\s+vs\s+/i);
    const home=pick.homeTeam || (parts.length>1?parts[0]:"");
    const away=pick.awayTeam || (parts.length>1?parts.slice(1).join(" vs "):"");
    let fixture=null;
    for(const sport of candidateSports) {
      fixture=(bySport.get(sport)||[]).find(f=>teamMatch(f.homeTeam,home)&&teamMatch(f.awayTeam,away));
      if(!fixture && home && away) fixture=(bySport.get(sport)||[]).find(f=>teamMatch(f.homeTeam,away)&&teamMatch(f.awayTeam,home));
      if(fixture) break;
    }
    if(!fixture && home && away) {
      // Fuzzy fallback: tip documents rename teams ("Rionegro Aguilas" vs
      // "Aguilas Doradas Rionegro"), append Reserve/Fc suffixes, etc. Score
      // token overlap for both home/away orders and accept a confident best.
      let best=null,bestScore=0;
      for(const sport of candidateSports) {
        for(const f of (bySport.get(sport)||[])) {
          const direct=(teamSim(home,f.homeTeam)+teamSim(away,f.awayTeam))/2;
          const swapped=(teamSim(home,f.awayTeam)+teamSim(away,f.homeTeam))/2;
          const sc=Math.max(direct,swapped);
          if(sc>bestScore){bestScore=sc;best=f;}
        }
      }
      if(best && bestScore>=0.6) fixture=best;
    }
    if(!fixture) { issues.push({pick,reason:"Fixture not found in upcoming SportyBet events (or team names did not match)."}); continue; }
    const marketNeed=normText(pick.market), selectionNeed=normText(pick.selection);
    // Keep markets unless SportyBet explicitly marks them suspended/closed.
    // Some feed variants use 0 for open and 1 for suspended, so only reject known closed states.
    const markets=(fixture.markets||[]).filter(m=>!["suspended","closed","settled","inactive","2","3"].includes(String(m.status??"").toLowerCase()));
    const marketAliases = ({
      "1x2":["1x2","match result","full time result","1x2 full time"],
      "12":["double chance","1x2","match result"],
      "either team to win":["double chance","1x2"],
      "over under":["over under","over under goals","total goals"],
      "both teams to score":["gg ng","both teams to score","btts"],
      "double chance":["double chance"]
    })[marketNeed] || [marketNeed];
    const marketIdAliases = ({
      "1x2":["1"], "match result":["1"], "full time result":["1"],
      "double chance":["10"], "12":["10"],
      "draw no bet":["11"], "over under":["18"], "over under goals":["18"],
      "both teams to score":["29"], "gg ng":["29"],
      "odd even":["26"], "handicap":["14"]
    })[marketNeed] || [];
    // Prefer an exact market-id match: fuzzy name matching can land on a
    // combined market ("Over/Under and GG/NG") whose outcomes never match.
    let market=marketIdAliases.length?markets.find(m=>marketIdAliases.includes(String(m.id))):null;
    if(!market) {
      market=markets.find(m=>{
        const names=[normText(m.name),normText(m.desc)].filter(Boolean);
        return marketAliases.some(alias=>names.some(n=>n===alias||n.includes(alias)||alias.includes(n)));
      });
    }
    if(!market) {
      console.warn("[document-market-debug]",JSON.stringify({pickMarket:pick.market,normalized:marketNeed,fixture:fixture.homeTeam+" vs "+fixture.awayTeam,marketCount:markets.length,available:markets.slice(0,35).map(m=>({id:m.id,name:m.name,desc:m.desc,status:m.status,outcomes:(m.outcomes||[]).slice(0,4).map(o=>({id:o.id,name:o.name,active:o.active,odds:o.odds}))}))}));
      issues.push({pick,reason:`Fixture found, but market "${pick.market||"unclear"}" was not matched confidently. SportyBet returned ${markets.length} candidate markets.`}); continue;
    }
    const outcomeAliases = selectionNeed==="home"||selectionNeed==="home win" ? ["1","home","home win"] :
      selectionNeed==="away"||selectionNeed==="away win" ? ["2","away","away win"] :
      selectionNeed==="draw" ? ["x","draw"] :
      selectionNeed==="yes" ? ["yes","gg","both teams to score yes"] :
      selectionNeed==="no" ? ["no","ng","both teams to score no"] :
      selectionNeed==="either team to win" || selectionNeed==="12" ? ["12","1 or 2","home or away","home away","no draw"] :
      selectionNeed==="over 1 5 goals" ? ["over 1.5","over 1 5","over 1 5 goals"] :
      selectionNeed==="over 2 5 goals" ? ["over 2.5","over 2 5","over 2 5 goals"] :
      selectionNeed==="under 3 5 goals" ? ["under 3.5","under 3 5","under 3 5 goals"] : [selectionNeed];
    const normalizedOutcomeAliases=outcomeAliases.map(normText);
    const selectionIsHome = normText(pick.selection)===normText(fixture.homeTeam) || normText(pick.selection).includes(normText(fixture.homeTeam)) || normText(fixture.homeTeam).includes(normText(pick.selection));
    const selectionIsAway = normText(pick.selection)===normText(fixture.awayTeam) || normText(pick.selection).includes(normText(fixture.awayTeam)) || normText(fixture.awayTeam).includes(normText(pick.selection));
    const expandedOutcomeAliases = [...outcomeAliases];
    if(selectionIsHome) expandedOutcomeAliases.push("1","home","home win");
    if(selectionIsAway) expandedOutcomeAliases.push("2","away","away win");
    const outcome=(market.outcomes||[]).find(o=>{
      const n=normText(o.name);
      const id=String(o.id).toLowerCase();
      return (o.active===true || o.active===undefined || o.active===null) && Number(o.odds)>1&&(
        [...expandedOutcomeAliases.map(normText),...normalizedOutcomeAliases].some(alias=>alias && (n===alias||n.includes(alias)||alias.includes(n))) ||
        (selectionIsHome && ["1","home","home win"].includes(id)) ||
        (selectionIsAway && ["2","away","away win"].includes(id))
      );
    });
    if(!outcome) {
      if(explicit12 || marketIdAliases.includes(String(market.id)) && String(market.id)==="10") {
        console.warn("[document-dc-outcome-debug]",JSON.stringify({fixture:fixture.homeTeam+" vs "+fixture.awayTeam,marketId:market.id,marketName:market.name,wanted:pick.selection,outcomes:(market.outcomes||[]).map(o=>({id:o.id,name:o.name,active:o.active,odds:o.odds}))}));
      }
      issues.push({pick,reason:`Market found, but outcome "${pick.selection||"unclear"}" is unavailable or did not match.`}); continue; }
    if(matched.some(x=>x.eventId===fixture.eventId)) { issues.push({pick,reason:"SportyBet booking builder currently allows one selection per event; duplicate fixture selection was skipped."}); continue; }
    if(matched.length>=50) { issues.push({pick,reason:"50-selection limit reached; remaining picks were not included."}); continue; }
    matched.push({eventId:fixture.eventId,marketId:String(market.id),specifier:String(market.specifier||""),outcomeId:String(outcome.id),odds:Number(outcome.odds),startMs:Number(fixture.startMs),label:`${fixture.homeTeam} vs ${fixture.awayTeam} — ${market.name}: ${outcome.name} @ ${Number(outcome.odds).toFixed(2)}`,key:[fixture.eventId,market.id,market.specifier||"",outcome.id].join(":")});
  }
  if(!matched.length) {
    const details=issues.slice(0,12).map((x,i)=>`${i+1}. ${x.pick.match||x.pick.selection}: ${x.reason}`).join("\n");
    return sendText(chatId,`⚠️ I couldn't confidently match any selections to active SportyBet markets, so no booking code was requested.\n\n${details||"Please upload a clearer document."}`,MAIN_MENU);
  }
  const s=getBookingSession(chatId); s.selections=matched; s.fixtures=[];
  const totalOdds=matched.reduce((n,x)=>n*x.odds,1);
  const good=matched.map((x,i)=>`${i+1}. ${x.label}`).join("\n");
  const bad=issues.length?`\n\n⚠️ Not included (${issues.length}):\n${issues.slice(0,12).map((x,i)=>`${i+1}. ${x.pick.match||x.pick.selection}: ${x.reason}`).join("\n")}${issues.length>12?"\nMore unmatched selections omitted from this message.":""}`:"";
  await sendText(chatId,`🎟️ SPORTYBET SLIP READY FOR CONFIRMATION

Matched: ${matched.length}
Unmatched/ambiguous: ${issues.length}
Indicative combined odds: ${Number.isFinite(totalOdds)?totalOdds.toFixed(2):"too large to display"}

${good}${bad}

Only the matched selections above will be submitted to SportyBet for a shareable booking code. Review before confirming.`,{inline_keyboard:[
    [{text:`✅ Generate code for ${matched.length} picks`,callback_data:"doc_create"}],
    [{text:"🗑 Cancel",callback_data:"doc_cancel"},{text:"⬅️ Main menu",callback_data:"menu"}]
  ]});
}
async function createDocumentBooking(chatId) {
  const s=getBookingSession(chatId);
  if(!s.selections.length) return sendText(chatId,"No matched selections are ready to book.",MAIN_MENU);
  if(s.selections.some(x=>Number(x.startMs)<=Date.now())) return sendText(chatId,"At least one selected event has started. Upload again or remove the expired selection before generating a code.",MAIN_MENU);
  await sendText(chatId,"⏳ Requesting a real SportyBet share code. This does not place a bet and will not be automatically retried.");
  const result=await createBooking(s.selections);
  const expiry=result.deadline?new Date(result.deadline).toLocaleString("en-GB",{timeZone:TZ}):"Not provided";
  const code=result.shareCode?`\n\nBooking code: ${result.shareCode}`:"";
  const url=result.shareURL?`\nOpen slip: ${result.shareURL}`:"";
  const unavailable=result.unavailableOutcomes?.length?`\n\n⚠️ SportyBet could not include ${result.unavailableOutcomes.length} selection(s). Check the final slip before using it.`:"";
  await sendText(chatId,`✅ SPORTYBET BOOKING CODE CREATED${code}${url}\n\nSelections requested: ${s.selections.length}\nExpiry: ${expiry}${unavailable}\n\nThis creates a shareable slip only; no wager has been placed and no money has been staked.`,MAIN_MENU);
}

async function handleAction(chatId,action){
  if(action==="doc_prepare") return prepareDocumentSlip(chatId);
  if(action==="doc_create") return createDocumentBooking(chatId);
  if(action==="force_stop"){await kvSet(STOP_KEY,true,STOP_TTL_SECONDS);return sendText(chatId,"⛔ Bot paused for 30 minutes. No commands or buttons will be answered. Tap Resume or send /start to unpause early.",null);}
  if(action==="force_resume"){await kvDel(STOP_KEY);return sendText(chatId,"▶️ Bot resumed.",MAIN_MENU);}
  if(action==="doc_cancel"){documentSessions.delete(String(chatId));await kvDel(`sb:document:${String(chatId)}`);return sendText(chatId,"Uploaded picks discarded. No booking code was created.",MAIN_MENU);}
  if(action==="menu") return sendText(chatId,"⚽🏀🎾 SportyBet Markets Bot\n\nChoose a sport or request all sports:",MAIN_MENU);
  if(action==="help"||action==="search_help"){
    return sendText(chatId,action==="search_help"
      ?"🔎 Search\n\nUse /search Arsenal or /search NBA. Search is currently against tomorrow's all-sport fixture list."
      :"⚽🏀🎾 SportyBet Markets Bot\n\n/fixtures — choose Football, Basketball, Tennis or All Sports\n/today — all sports today\n/tomorrow — all sports tomorrow\n/pdf — all sports today\n/pdf_tomorrow — all sports tomorrow\n/excel — all sports today\n/excel_tomorrow — all sports tomorrow\n/football, /basketball, /tennis — sport menus\n/search TEAM — search tomorrow's all-sport fixtures\n\n🤖 /analyze tomorrow 10 — football AI analysis for now.\n🎟️ /book — build a SportyBet booking code from available upcoming football markets.\n📎 Send a screenshot or PDF of picks to extract, match and prepare a booking code.",MAIN_MENU);
  }
  if(action==="leagues"||action==="markets"){
    const fixtures=await loadDay("all",1), counts=new Map();
    for(const f of fixtures){if(action==="leagues"){const n=f.league||"Unknown";counts.set(n,(counts.get(n)||0)+1)}else for(const m of f.markets||[]){const n=m.name||"Other";counts.set(n,(counts.get(n)||0)+1)}}
    const body=[...counts.entries()].sort((a,b)=>b[1]-a[1]).slice(0,50).map(([n,c],i)=>`${i+1}. ${n} — ${c}`).join("\n")||"No data found.";
    return sendText(chatId,`${action==="leagues"?"🏆":"📈"} Tomorrow's ${action}\n\n${body}`,MAIN_MENU);
  }
  if(action.startsWith("sport_")){
    const [,sport,day]=action.split("_"); return runReport(chatId,day==="tomorrow"?"summary_tomorrow":"summary_today",sport);
  }
  if(action.startsWith("all_")){
    const day=action.endsWith("tomorrow")?"tomorrow":"today"; return runReport(chatId,`summary_${day}`,"all");
  }
  if(action.startsWith("pdf_")||action.startsWith("excel_")){
    return runReport(chatId,action,"all");
  }
  return sendText(chatId,"Unknown menu action. Tap /start.",MAIN_MENU);
}

async function setBotCommands(){
  const commands=[
    {command:"start",description:"Open the multi-sport menu"},
    {command:"fixtures",description:"Choose sport and date"},
    {command:"today",description:"Football today"},
    {command:"tomorrow",description:"Football tomorrow"},
    {command:"football",description:"Football fixtures menu"},
    {command:"basketball",description:"Basketball fixtures menu"},
    {command:"pdf",description:"PDF report today"},
    {command:"pdf_tomorrow",description:"PDF report tomorrow"},
    {command:"excel",description:"Excel report today"},
    {command:"excel_tomorrow",description:"Excel report tomorrow"},
    {command:"leagues",description:"List tomorrow's leagues"},
    {command:"markets",description:"List tomorrow's markets"},
    {command:"search",description:"Search fixtures"},
    {command:"help",description:"Help"}
  ];
  try{await tg("setMyCommands",{commands})}catch(e){console.error(e)}
}

async function handleWebhook(req,res){
  if(req.method!=="POST") return res.status(200).json({ok:true});
  if(SECRET&&req.headers["x-telegram-bot-api-secret-token"]!==SECRET) return res.status(401).end();
  const update=req.body||{}, msg=update.message, callback=update.callback_query, chatId=msg?.chat?.id||callback?.message?.chat?.id;
  if(!chatId) return res.status(200).json({ok:true});
  try{
    if(await isForceStopped()) {
      if(callback&&callback.data==="force_resume"){await answerCallback(callback.id);await kvDel(STOP_KEY);await sendText(chatId,"▶️ Bot resumed.",MAIN_MENU);return res.status(200).json({ok:true});}
      return res.status(200).json({ok:true});
    }
    await hydrateSessions(chatId);
    if(callback){await answerCallback(callback.id);await handleAction(chatId,callback.data);await persistSessions(chatId);return res.status(200).json({ok:true});}
    if(msg.photo?.length||msg.document){await receiveDocument(chatId,msg);await persistSessions(chatId);return res.status(200).json({ok:true});}
    const raw=(msg.text||"").trim(), text=raw.toLowerCase(), command=text.split(/\s+/)[0];
    if(raw && !raw.startsWith("/")) { const parsed=await receivePastedPicks(chatId,raw); if(parsed){await persistSessions(chatId);return res.status(200).json({ok:true});} }

    if(command==="/start"||command==="/help"){await setBotCommands();await kvDel(STOP_KEY);await sendText(chatId,"⚽🏀🎾 SportyBet Markets Bot\n\nChoose a sport or request all sports:",MAIN_MENU);return res.status(200).json({ok:true});}
    if(command==="/fixtures"||command==="/football"||command==="/basketball"){
      const sport=command==="/fixtures"?"all":command.slice(1);
      await sendText(chatId,sport==="all"?"📋 Choose sport and date:":`${sportLabel(sport)}\n\nChoose date:`,SPORT_MENU());return res.status(200).json({ok:true});
    }
    if(command==="/today"||command==="/tomorrow"){await runReport(chatId,command,"all");return res.status(200).json({ok:true});}
    if(command==="/pdf"||command==="/pdf_tomorrow"||command==="/excel"||command==="/excel_tomorrow"){await runReport(chatId,command.slice(1),"all");return res.status(200).json({ok:true});}
    if(command==="/leagues"||command==="/markets"){await handleAction(chatId,command.slice(1));return res.status(200).json({ok:true});}
    if(command==="/search"){
      const q=raw.slice(command.length).trim().toLowerCase(); if(!q){await sendText(chatId,"Usage: /search Arsenal",MAIN_MENU);return res.status(200).json({ok:true});}
      const fixtures=await loadDay("all",1), matches=fixtures.filter(f=>`${f.homeTeam} ${f.awayTeam} ${f.league}`.toLowerCase().includes(q));
      const body=matches.slice(0,40).map(f=>`${f.sport} — ${f.homeTeam} vs ${f.awayTeam}\n   ${f.league}`).join("\n")||"No matching fixtures found.";
      await sendText(chatId,`🔎 Search: ${q}\n\n${body}\n\nFound ${matches.length} fixture(s).`,MAIN_MENU);return res.status(200).json({ok:true});
    }
    await sendText(chatId,"Unknown command. Send /start.",MAIN_MENU);return res.status(200).json({ok:true});
  }catch(e){console.error(e);try{await sendText(chatId,`❌ Error: ${e.message||"Unable to retrieve data."}`,MAIN_MENU)}catch{}return res.status(200).json({ok:false});}
}

export async function handler(req,res){
  if(req.method!=="POST") return res.status(200).json({ok:true,service:"sportybet-telegram-bot"});
  const updateId=String(req.body?.update_id||"");
  if(updateId) {
    const fresh=await kvSetNx(`sb:upd:${updateId}`,true,600);
    if(fresh===false) return res.status(200).json({ok:true,duplicate:true});
  }
  // Acknowledge instantly so Telegram never retries, then keep processing in
  // the background within the same function invocation.
  res.status(200).json({ok:true});
  return waitUntil(handleWebhook(req,res));
}

export default handler;
