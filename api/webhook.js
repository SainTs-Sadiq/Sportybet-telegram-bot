import { getFixtures, filterByDay, createBooking } from "../lib/sportybet.js";
import { makePdf, makeXlsx } from "../lib/reports.js";
import { impliedProbability } from "../lib/football.js";
import { getTeamFormAnalysis, blendFormAndMarket } from "../lib/team-history.js";
import { marketCandidates, marketCandidatesFromOdds, marketCandidatesFromAllOdds, rankWithAI, combinedOdds } from "../lib/ai.js";
import { SPORTS, SPORT_ORDER, sportLabel, getSport } from "../lib/sports.js";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SECRET = process.env.BOT_SECRET;
const TZ = process.env.REPORT_TIMEZONE || "Africa/Lagos";

const cache = new Map();
const bookingSessions = new Map();
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
  [{text:"📋 All Sports Today",callback_data:"all_today"},{text:"📅 All Sports Tomorrow",callback_data:"all_tomorrow"}],
  [{text:"🌎 All Sports PDF — Today",callback_data:"pdf_today"},{text:"🌎 All Sports PDF — Tomorrow",callback_data:"pdf_tomorrow"}],
  [{text:"📊 All Sports Excel — Today",callback_data:"excel_today"},{text:"📊 All Sports Excel — Tomorrow",callback_data:"excel_tomorrow"}],
  [{text:"🤖 AI 10 Picks",callback_data:"ai_tomorrow_10"},{text:"🤖 AI 20 Picks",callback_data:"ai_tomorrow_20"}],
  [{text:"🎟️ Build Booking Code",callback_data:"book_start"}],
  [{text:"🎯 Target Odds 10/20/50/100/500/1000",callback_data:"book_targets"}],
  [{text:"🏆 Leagues",callback_data:"leagues"},{text:"📈 Markets",callback_data:"markets"}],
  [{text:"🔎 Search",callback_data:"search_help"},{text:"ℹ️ Help",callback_data:"help"}]
]};

const SPORT_MENU=()=>({inline_keyboard:[
  ...SPORT_ORDER.map(k=>[
    {text:`${SPORTS[k].label} — Today`,callback_data:`sport_${k}_today`},
    {text:`${SPORTS[k].label} — Tomorrow`,callback_data:`sport_${k}_tomorrow`}
  ]),
  [{text:"🌎 All Sports — Today",callback_data:"all_today"},{text:"🌎 All Sports — Tomorrow",callback_data:"all_tomorrow"}],
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
  const raw=await getFixtures({hours:offset?72:48,pageSize:100,maxPages:10,sportId:cfg.sportId,marketIds:sport==="football"?undefined:[]});
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
  for (const fixture of fixtures) {
    if (!leagueNames.includes(fixture.league) || analyses.has(String(fixture.eventId))) continue;
    const key = [fixture.league,fixture.homeTeam,fixture.awayTeam].join("|");
    try {
      let promise=formRequestCache.get(key);
      if(!promise){promise=getTeamFormAnalysis(fixture);formRequestCache.set(key,promise);}
      const form=await promise;
      if(form) analyses.set(String(fixture.eventId),form);
    } catch(e) { console.warn("[team-form-analysis]",fixture.league,e.message); }
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

async function analyzeDay(chatId,offset=1,requested=10){
  if(!process.env.GEMINI_API_KEY && !process.env.OPENAI_API_KEY) throw new Error("AI analysis needs GEMINI_API_KEY or OPENAI_API_KEY in Vercel.");
  const fixtures=(await loadSportDay("football",offset)).filter(f=>Number(f.startMs)>Date.now());
  if(!fixtures.length){await sendText(chatId,"No football fixtures found for the selected day.");return;}
  await sendText(chatId,`🤖 Analyzing ${fixtures.length} football games using SportyBet odds and our probability calculations. API-Football is not required.`);
  let candidates=fixtures.flatMap(f=>marketCandidatesFromAllOdds(f)).filter(x=>x.odds>1&&x.modelProbability>=35);
  candidates=await enrichCandidatesWithForm(fixtures,candidates,30);
  candidates.sort((a,b)=>Number(b.formDataAvailable)-Number(a.formDataAvailable)||b.modelProbability-a.modelProbability||a.odds-b.odds);
  if(!candidates.length){await sendText(chatId,"⚠️ No fixtures had usable active SportyBet markets. No picks were generated.");return;}
  let picks;
  try { picks=await rankWithAI(candidates.slice(0,100),Math.min(20,Math.max(1,requested))); }
  catch(e){console.error("AI ranking failed",e);picks=candidates.slice(0,Math.min(20,Math.max(1,requested))).map((p,i)=>({...p,rank:i+1,confidence:"Low",risk:"High",rationale:"Ranked by market-normalized SportyBet probabilities; AI ranking unavailable."}));}
  if(!picks.length){await sendText(chatId,"⚠️ No selections were returned.");return;}
  const seenEvents=new Set();
  picks=picks.filter(p=>{const key=String(p.eventId||p.match);if(seenEvents.has(key))return false;seenEvents.add(key);return true;}).slice(0,Math.min(20,Math.max(1,requested)));
  const lines=picks.map((p,i)=>`${i+1}. ${p.match}\n   🎯 ${p.market}: ${p.selection} @ ${Number(p.odds).toFixed(2)}\n   📊 Blended probability: ${p.modelProbability.toFixed(1)}% | Raw implied: ${(impliedProbability(p.odds)*100).toFixed(1)}%\n   ${p.confidence||"Low"} confidence • ${p.risk||"High"} risk\n   ${p.formDataAvailable ? `Recent form: ${p.recentForm.homeForm.form} vs ${p.recentForm.awayForm.form}; goals for/against ${p.recentForm.homeForm.goalsFor}/${p.recentForm.homeForm.goalsAgainst} vs ${p.recentForm.awayForm.goalsFor}/${p.recentForm.awayForm.goalsAgainst}.` : "Historical form unavailable; market-only estimate."} ${p.rationale||p.reason}`);
  await sendText(chatId,`🤖 AI FOOTBALL ANALYSIS — ${offset?"TOMORROW":"TODAY"}\n\n${lines.join("\n\n")}\n\n📈 Combined odds: ${combinedOdds(picks).toFixed(2)}\n\nℹ️ When historical results match, probabilities blend a goals-based form model with SportyBet market probabilities. Smaller leagues are covered when the historical provider has results; unmatched leagues fall back to market-only. Injuries and head-to-head are not modeled.\n\n⚠️ Statistical ranking, not a guarantee.`);
}


function bookingKeyboard(rows) {
  return { inline_keyboard: [...rows, [{text:"🎟️ View slip",callback_data:"book_view"},{text:"🗑 Clear slip",callback_data:"book_clear"}], [{text:"⬅️ Main menu",callback_data:"menu"}]] };
}
function getBookingSession(chatId) {
  if (!bookingSessions.has(String(chatId))) bookingSessions.set(String(chatId), { fixtures: [], selections: [], pendingEvent: null });
  return bookingSessions.get(String(chatId));
}
async function startBooking(chatId) {
  await sendText(chatId, "⏳ Loading upcoming football fixtures and available markets...");
  const raw = await getFixtures({hours:168,pageSize:100,maxPages:5,sportId:SPORTS.football.sportId});
  const future = raw.filter(f => Number(f.startMs) > Date.now() && f.markets?.some(m => m.outcomes?.some(o => o.active && o.odds > 1)))
    .sort((a,b)=>a.startMs-b.startMs).slice(0,12);
  const session = getBookingSession(chatId);
  session.fixtures = future;
  session.pendingEvent = null;
  if (!future.length) return sendText(chatId, "No upcoming football fixtures with active markets were returned by SportyBet. Try again later; no booking code was created.", MAIN_MENU);
  const rows = future.map((f,i)=>[{text:`${f.homeTeam} vs ${f.awayTeam} • ${new Date(f.startMs).toLocaleString("en-GB",{timeZone:TZ,day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"})}`,callback_data:`book_event_${i}`}]);
  await sendText(chatId, "🎟️ BOOKING CODE BUILDER\n\nChoose a fixture. Then choose a market and outcome. You can add multiple selections before creating the slip.", bookingKeyboard(rows));
}
async function chooseBookingEvent(chatId,index) {
  const s=getBookingSession(chatId), f=s.fixtures[index];
  if(!f) return sendText(chatId,"That fixture list has expired. Start the booking builder again.",MAIN_MENU);
  s.pendingEvent=index;
  const rows=(f.markets||[]).filter(m=>m.status===undefined || String(m.status)==="1" || String(m.status).toLowerCase()==="active")
    .filter(m=>(m.outcomes||[]).some(o=>o.active && o.odds>1)).slice(0,18)
    .map((m)=>[{text:m.name,callback_data:`book_market_${index}_${encodeURIComponent(m.id)}`}]);
  if(!rows.length) return sendText(chatId,"No active markets were available for that fixture.",bookingKeyboard([]));
  await sendText(chatId,`📍 ${f.homeTeam} vs ${f.awayTeam}\nChoose a market:`,bookingKeyboard(rows));
}
async function chooseBookingMarket(chatId,index,marketId) {
  const s=getBookingSession(chatId), f=s.fixtures[index], m=f?.markets?.find(x=>String(x.id)===marketId);
  if(!f||!m) return sendText(chatId,"That market is no longer available. Start the builder again.",MAIN_MENU);
  s.pendingEvent=index;
  const active=(m.outcomes||[]).filter(o=>o.active&&Number(o.odds)>1);
  const rows=active.slice(0,24).map((o)=>[{text:`${o.name} @ ${Number(o.odds).toFixed(2)}`,callback_data:`book_outcome_${index}_${encodeURIComponent(m.id)}_${encodeURIComponent(m.specifier||"")}_${encodeURIComponent(o.id)}`}]);
  if(!rows.length) return sendText(chatId,"No active outcomes are available in this market.",bookingKeyboard([]));
  await sendText(chatId,`🎯 ${f.homeTeam} vs ${f.awayTeam}\nMarket: ${m.name}\nChoose an outcome:`,bookingKeyboard(rows));
}
async function addBookingOutcome(chatId,index,marketId,specifier,outcomeId) {
  const s=getBookingSession(chatId), f=s.fixtures[index], m=f?.markets?.find(x=>String(x.id)===marketId);
  const o=m?.outcomes?.find(x=>String(x.id)===outcomeId && String(x.specifier||m.specifier||"")===String(specifier||""));
  if(!f||!m||!o||!o.active||!(Number(o.odds)>1)||Number(f.startMs)<=Date.now()) {
    return sendText(chatId,"That selection is no longer valid or the event has started. Refresh the builder and choose an active outcome.",MAIN_MENU);
  }
  const key=[f.eventId,m.id,m.specifier||"",o.id].join(":");
  if(s.selections.some(x=>x.key===key)) return sendText(chatId,"That selection is already in your slip.",bookingKeyboard([]));
  if(s.selections.some(x=>x.eventId===f.eventId)) return sendText(chatId,"Only one selection per event is supported in this builder. Choose a different fixture.",bookingKeyboard([]));
  if(s.selections.length>=50) return sendText(chatId,"Your slip has reached SportyBet's 50-selection limit.",bookingKeyboard([]));
  s.selections.push({key,eventId:f.eventId,marketId:String(m.id),specifier:String(m.specifier||""),outcomeId:String(o.id),label:`${f.homeTeam} vs ${f.awayTeam} — ${m.name}: ${o.name} @ ${Number(o.odds).toFixed(2)}`,odds:Number(o.odds),startMs:Number(f.startMs)});
  await sendText(chatId,`✅ Added to slip (${s.selections.length}/20)\n${s.selections[s.selections.length-1].label}\n\nContinue selecting fixtures or view your slip.`,bookingKeyboard(s.fixtures.map((x,i)=>[{text:`${x.homeTeam} vs ${x.awayTeam}`,callback_data:`book_event_${i}`}]).slice(0,12)));
}
async function viewBooking(chatId) {
  const s=getBookingSession(chatId);
  if(!s.selections.length) return sendText(chatId,"Your slip is empty. Choose Build Booking Code and select at least one outcome.",MAIN_MENU);
  const odds=s.selections.reduce((n,x)=>n*x.odds,1);
  const lines=s.selections.map((x,i)=>`${i+1}. ${x.label}`).join("\n");
  await sendText(chatId,`🎟️ REVIEW YOUR SLIP\n\n${lines}\n\nSelections: ${s.selections.length}\nIndicative combined odds: ${odds.toFixed(2)}\n\nConfirm to request a booking code from SportyBet. This reserves a slip only; it does not place a bet.`,{inline_keyboard:[[{text:"✅ Generate booking code",callback_data:"book_create"}],[{text:"🗑 Clear slip",callback_data:"book_clear"},{text:"➕ Add selections",callback_data:"book_start"}],[{text:"⬅️ Main menu",callback_data:"menu"}]]});
}
async function createBookingForChat(chatId) {
  const s=getBookingSession(chatId);
  if(!s.selections.length) return sendText(chatId,"Your slip is empty.",MAIN_MENU);
  if(s.selections.some(x=>x.startMs<=Date.now())) return sendText(chatId,"At least one selected event has started. Clear the slip and choose upcoming fixtures.",MAIN_MENU);
  await sendText(chatId,"⏳ Requesting a real booking code from SportyBet. This request will not be automatically retried.");
  const result=await createBooking(s.selections);
  const unavailable=result.unavailableOutcomes.length ? `\n\n⚠️ SportyBet could not include ${result.unavailableOutcomes.length} selection(s). Please review the slip on SportyBet.` : "";
  const expiry=result.deadline ? new Date(result.deadline).toLocaleString("en-GB",{timeZone:TZ}) : "Not provided";
  const code=result.shareCode ? `\n\nBooking code: ${result.shareCode}` : "";
  const url=result.shareURL ? `\nOpen slip: ${result.shareURL}` : "";
  await sendText(chatId,`✅ SPORTYBET BOOKING CODE CREATED${code}${url}\n\nSelections requested: ${s.selections.length}\nExpiry: ${expiry}${unavailable}\n\nThis is a reserved bet slip only. No bet has been placed and no money has been staked.`,MAIN_MENU);
}


async function buildTargetBooking(chatId,target,offset=0) {
  const allowed=[10,20,50,100,500,1000];
  if(!allowed.includes(target)) return sendText(chatId,"Choose a supported target odds value.",MAIN_MENU);
  const useBothDays=target>=100, offsets=useBothDays?[0,1]:[offset];
  const periodLabel=useBothDays?"TODAY + TOMORROW":(offset?"TOMORROW":"TODAY");
  if(!process.env.GEMINI_API_KEY&&!process.env.OPENAI_API_KEY) return sendText(chatId,"⚠️ Add GEMINI_API_KEY or OPENAI_API_KEY in Vercel to enable AI ranking. No slip was built.",MAIN_MENU);
  await sendText(chatId,`🔎 Checking all available SportyBet football fixtures for ${periodLabel.toLowerCase()}. Exploring active SportyBet markets (1X2, double chance, draw no bet, goals, both teams to score, halves and corners where available) and asking Gemini to rank candidates. API-Football is not required.`);
  const dayFixtures=await Promise.all(offsets.map(dayOffset=>loadSportDay("football",dayOffset)));
  const fixtures=[...new Map(dayFixtures.flat().map(f=>[String(f.eventId),f])).values()].filter(f=>Number(f.startMs)>Date.now());
  if(!fixtures.length) return sendText(chatId,`No upcoming football fixtures were found for ${periodLabel.toLowerCase()}.`,MAIN_MENU);
  let candidates=fixtures.flatMap(f=>marketCandidatesFromAllOdds(f)).filter(p=>p.odds>1&&p.odds<=2.2&&p.eventId&&p.marketId&&p.outcomeId);
  candidates=await enrichCandidatesWithForm(fixtures,candidates,35);
  candidates=candidates.filter(p=>p.modelProbability>=50).sort((a,b)=>Number(b.formDataAvailable)-Number(a.formDataAvailable)||b.modelProbability-a.modelProbability||a.odds-b.odds);
  const bestByEvent=new Map();
  for(const p of candidates){const old=bestByEvent.get(String(p.eventId));if(!old||p.modelProbability>old.modelProbability)bestByEvent.set(String(p.eventId),p);}
  let ranked=[...bestByEvent.values()];
  if(!ranked.length) return sendText(chatId,"⚠️ No active SportyBet 1X2 selections met the filters (market-normalized probability ≥50%, odds ≤2.20). I won't add unsupported picks to force the target.",MAIN_MENU);
  try {
    const aiRanked=await rankWithAI(ranked.map((p,i)=>({id:i+1,match:p.match,market:p.market,selection:p.selection,odds:p.odds,modelProbability:p.modelProbability,marketProbability:p.marketProbability,formDataAvailable:p.formDataAvailable,formSummary:p.recentForm?{home:p.recentForm.homeForm,away:p.recentForm.awayForm}:null,expectedGoals:p.recentForm?{home:p.recentForm.expectedGoalsHome,away:p.recentForm.expectedGoalsAway}:null,dataQuality:p.dataQuality,league:p.league,startMs:p.startMs,reason:p.reason})),ranked.length);
    const order=new Map(aiRanked.map((p,i)=>[Number(p.id),Number(p.rank)||i+1]));
    if(aiRanked.length) ranked=ranked.map((p,i)=>({...p,aiRank:order.get(i+1)??999,aiMeta:aiRanked.find(x=>Number(x.id)===i+1)})).sort((a,b)=>a.aiRank-b.aiRank);
  } catch(e){console.error("AI target-slip ranking failed; using statistical ranking",e);}
  const picks=[];let product=1;
  for(const pick of ranked){if(product>=target||picks.length>=50)break;picks.push(pick);product*=pick.odds;}
  if(product<target) return sendText(chatId,`⚠️ I found ${ranked.length} qualifying fixtures across ${periodLabel.toLowerCase()}. Their combined odds are ${product.toFixed(2)} (max 50 selections), below your ${target} target. I won't lower the filters or invent stronger probabilities to force the target. Try a lower target or retry when more fixtures are available.`,MAIN_MENU);
  const session=getBookingSession(chatId);session.fixtures=fixtures;
  session.selections=picks.map(p=>({...p,key:[p.eventId,p.marketId,p.specifier,p.outcomeId].join(":"),label:`${p.match} — ${p.market}: ${p.selection} @ ${Number(p.odds).toFixed(2)}`}));
  const estimatedAllWin=picks.reduce((n,p)=>n*(Math.max(0,Math.min(100,p.modelProbability))/100),1)*100;
  const lines=picks.map((p,i)=>`${i+1}. ${p.match}\n   🎯 ${p.market}: ${p.selection} @ ${Number(p.odds).toFixed(2)}\n   📊 Normalized market probability: ${p.modelProbability.toFixed(1)}%\n   🏆 ${p.league||"League not provided"}`);
  await sendText(chatId,`🎯 STATS-FILTERED TARGET SLIP — ${periodLabel}\n\nRequested target: ${target}\nBuilt combined odds: ${product.toFixed(2)}\nSelections: ${picks.length}/50\nMethod: explore active SportyBet markets including 1X2, double chance, draw no bet, totals, both teams to score, halves and corners where available. Historical form is applied where the outcome can be mapped reliably; other markets use normalized prices. Gemini ranks candidates. One selection per event.\n\n${lines.join("\n\n")}\n\n📉 Product of normalized market probabilities: ${estimatedAllWin.toFixed(3)}% (rough illustration only, not a calibrated accumulator probability).\n\n⚠️ High combined odds still mean a low chance of every leg winning. Automatically requesting the booking code now.`);
  try {
    const result=await createBooking(session.selections), expiry=result.deadline?new Date(result.deadline).toLocaleString("en-GB",{timeZone:TZ}):"Not provided";
    const code=result.shareCode?`\n\nBooking code: ${result.shareCode}`:"", url=result.shareURL?`\nOpen slip: ${result.shareURL}`:"";
    const unavailable=result.unavailableOutcomes?.length?`\n\n⚠️ SportyBet could not include ${result.unavailableOutcomes.length} selection(s). Review the slip on SportyBet.`:"";
    await sendText(chatId,`✅ SPORTYBET BOOKING CODE CREATED${code}${url}\n\nSelections requested: ${session.selections.length}\nExpiry: ${expiry}${unavailable}\n\nThis is a shareable slip only. No bet has been placed and no money has been staked.`,MAIN_MENU);
  } catch(e){console.error("Automatic booking-code creation failed",e);await sendText(chatId,`⚠️ The slip was built, but SportyBet did not return a booking code: ${e.message||"request failed"}. Your selections remain in this chat session; tap View slip to review.`,bookingKeyboard([]));}
}


async function handleAction(chatId,action){
  if(action.startsWith("book_")){
    if(action==="book_start") return startBooking(chatId);
    if(action==="book_view") return viewBooking(chatId);
    if(action==="book_clear"){bookingSessions.set(String(chatId),{fixtures:[],selections:[],pendingEvent:null});return sendText(chatId,"Your booking slip has been cleared.",MAIN_MENU);}
    if(action==="book_create") return createBookingForChat(chatId);
    if(action.startsWith("book_event_")) return chooseBookingEvent(chatId,Number(action.slice("book_event_".length)));
    if(action.startsWith("book_market_")){
      const match=action.match(/^book_market_(\d+)_(.+)$/);
      if(!match) return sendText(chatId,"Invalid market selection. Start the builder again.",MAIN_MENU);
      return chooseBookingMarket(chatId,Number(match[1]),decodeURIComponent(match[2]));
    }
    if(action.startsWith("book_outcome_")){
      const match=action.match(/^book_outcome_(\d+)_([^_]+)_([^_]*)_(.+)$/);
      if(!match) return sendText(chatId,"Invalid outcome selection. Start the builder again.",MAIN_MENU);
      return addBookingOutcome(chatId,Number(match[1]),decodeURIComponent(match[2]),decodeURIComponent(match[3]),decodeURIComponent(match[4]));
    }
    if(action==="book_targets") return sendText(chatId,"Choose your target odds. For 100, 500 and 1,000 odds, use the combined option to pool eligible fixtures from today and tomorrow:",{inline_keyboard:[
      [10,20,50].map(n=>({text:`${n} odds today`,callback_data:`book_target_${n}`})),
      [10,20,50].map(n=>({text:`${n} odds tomorrow`,callback_data:`book_target_tomorrow_${n}`})),
      [100,500,1000].map(n=>({text:`${n} odds • TODAY + TOMORROW`,callback_data:`book_target_both_${n}`})),
      [{text:"⬅️ Main menu",callback_data:"menu"}]
    ]});
    if(action.startsWith("book_target_both_")) return buildTargetBooking(chatId,Number(action.slice("book_target_both_".length)),0);
    if(action.startsWith("book_target_tomorrow_")) return buildTargetBooking(chatId,Number(action.slice("book_target_tomorrow_".length)),1);
    if(action.startsWith("book_target_")) return buildTargetBooking(chatId,Number(action.slice("book_target_".length)),0);
  }
  if(action==="menu") return sendText(chatId,"⚽🏀🎾 SportyBet Markets Bot\n\nChoose a sport or request all sports:",MAIN_MENU);
  if(action==="help"||action==="search_help"){
    return sendText(chatId,action==="search_help"
      ?"🔎 Search\n\nUse /search Arsenal or /search NBA. Search is currently against tomorrow's all-sport fixture list."
      :"⚽🏀🎾 SportyBet Markets Bot\n\n/fixtures — choose Football, Basketball, Tennis or All Sports\n/today — all sports today\n/tomorrow — all sports tomorrow\n/pdf — all sports today\n/pdf_tomorrow — all sports tomorrow\n/excel — all sports today\n/excel_tomorrow — all sports tomorrow\n/football, /basketball, /tennis — sport menus\n/search TEAM — search tomorrow's all-sport fixtures\n\n🤖 /analyze tomorrow 10 — football AI analysis for now.\n🎟️ /book — build a SportyBet booking code from available upcoming football markets.",MAIN_MENU);
  }
  if(action==="leagues"||action==="markets"){
    const fixtures=await loadDay("all",1), counts=new Map();
    for(const f of fixtures){if(action==="leagues"){const n=f.league||"Unknown";counts.set(n,(counts.get(n)||0)+1)}else for(const m of f.markets||[]){const n=m.name||"Other";counts.set(n,(counts.get(n)||0)+1)}}
    const body=[...counts.entries()].sort((a,b)=>b[1]-a[1]).slice(0,50).map(([n,c],i)=>`${i+1}. ${n} — ${c}`).join("\n")||"No data found.";
    return sendText(chatId,`${action==="leagues"?"🏆":"📈"} Tomorrow's ${action}\n\n${body}`,MAIN_MENU);
  }
  if(action.startsWith("ai_tomorrow_")) return analyzeDay(chatId,1,Number(action.split("_").pop())||10);
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
    {command:"today",description:"All sports today"},
    {command:"tomorrow",description:"All sports tomorrow"},
    {command:"football",description:"Football fixtures menu"},
    {command:"basketball",description:"Basketball fixtures menu"},
    {command:"tennis",description:"Tennis fixtures menu"},
    {command:"pdf",description:"All sports PDF today"},
    {command:"pdf_tomorrow",description:"All sports PDF tomorrow"},
    {command:"all_pdf_today",description:"Download all sports PDF for today"},
    {command:"all_pdf_tomorrow",description:"Download all sports PDF for tomorrow"},
    {command:"excel",description:"All sports today's spreadsheet"},
    {command:"excel_tomorrow",description:"All sports tomorrow's spreadsheet"},
    {command:"leagues",description:"List tomorrow's leagues"},
    {command:"markets",description:"List tomorrow's markets"},
    {command:"search",description:"Search fixtures"},
    {command:"analyze",description:"AI football analysis"},
    {command:"book",description:"Build a SportyBet booking code"},
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
    if(callback){await answerCallback(callback.id);await handleAction(chatId,callback.data);return res.status(200).json({ok:true});}
    const raw=(msg.text||"").trim(), text=raw.toLowerCase(), command=text.split(/\s+/)[0];
    if(command==="/book"){await startBooking(chatId);return res.status(200).json({ok:true});}
    if(command==="/start"||command==="/help"){await setBotCommands();await sendText(chatId,"⚽🏀🎾 SportyBet Markets Bot\n\nChoose a sport or request all sports:",MAIN_MENU);return res.status(200).json({ok:true});}
    if(command==="/fixtures"||command==="/football"||command==="/basketball"||command==="/tennis"){
      const sport=command==="/fixtures"?"all":command.slice(1);
      await sendText(chatId,sport==="all"?"📋 Choose sport and date:":`${sportLabel(sport)}\n\nChoose date:`,SPORT_MENU());return res.status(200).json({ok:true});
    }
    if(command==="/today"||command==="/tomorrow"){await runReport(chatId,command,"all");return res.status(200).json({ok:true});}
    if(command==="/pdf"||command==="/pdf_tomorrow"||command==="/all_pdf_today"||command==="/all_pdf_tomorrow"||command==="/excel"||command==="/excel_tomorrow"){const action=command==="/all_pdf_today"?"pdf_today":command==="/all_pdf_tomorrow"?"pdf_tomorrow":command.slice(1);await runReport(chatId,action,"all");return res.status(200).json({ok:true});}
    if(command==="/leagues"||command==="/markets"){await handleAction(chatId,command.slice(1));return res.status(200).json({ok:true});}
    if(command==="/analyze"){const p=text.split(/\s+/),when=p[1]==="today"?0:1,n=Math.min(20,Math.max(1,Number(p[2])||10));await analyzeDay(chatId,when,n);return res.status(200).json({ok:true});}
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
  return handleWebhook(req,res);
}

export default handler;
