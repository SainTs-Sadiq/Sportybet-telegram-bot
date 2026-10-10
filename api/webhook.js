import { getFixtures, filterByDay, createBooking } from "../lib/sportybet.js";
import { makePdf, makeXlsx } from "../lib/reports.js";
import { getDailyFixtures, buildCandidates, getPredictions, impliedProbability } from "../lib/football.js";
import { marketCandidates, rankWithAI, combinedOdds } from "../lib/ai.js";
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
  [{text:"⚽ Football",callback_data:"sport_football_today"},{text:"🏀 Basketball",callback_data:"sport_basketball_today"},{text:"🎾 Tennis",callback_data:"sport_tennis_today"}],
  [{text:"📋 All Sports Today",callback_data:"all_today"},{text:"📅 All Sports Tomorrow",callback_data:"all_tomorrow"}],
  [{text:"🌎 All Sports PDF — Today",callback_data:"pdf_today"},{text:"🌎 All Sports PDF — Tomorrow",callback_data:"pdf_tomorrow"}],
  [{text:"📊 All Sports Excel — Today",callback_data:"excel_today"},{text:"📊 All Sports Excel — Tomorrow",callback_data:"excel_tomorrow"}],
  [{text:"🤖 AI 10 Picks",callback_data:"ai_tomorrow_10"},{text:"🤖 AI 20 Picks",callback_data:"ai_tomorrow_20"}],
  [{text:"🎟️ Build Booking Code",callback_data:"book_start"}],
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
  if(!process.env.API_FOOTBALL_KEY) throw new Error("AI analysis needs API_FOOTBALL_KEY in Vercel.");
  if(!process.env.OPENAI_API_KEY) throw new Error("AI analysis needs OPENAI_API_KEY in Vercel.");
  const fixtures=await loadSportDay("football",offset);
  if(!fixtures.length){await sendText(chatId,"No football fixtures found for the selected day.");return;}
  await sendText(chatId,`🤖 Analyzing ${fixtures.length} football games...\n\nThe multi-sport fixture/report system is separate from the football AI model for now.`);
  const date=dateForOffset(offset), external=await getDailyFixtures(date), matched=buildCandidates(fixtures,external,25);
  if(!matched.length){await sendText(chatId,"⚠️ I couldn't match the SportyBet fixtures to the statistical provider. No picks were generated.");return;}
  const predicted=(await Promise.all(matched.map(async c=>{try{return {...c,prediction:await getPredictions(c.api.fixture?.id)}}catch{return {...c,prediction:null}}}))).filter(x=>x.prediction);
  const candidates=predicted.flatMap(c=>marketCandidates(c.sporty,c.prediction).map(x=>({...x,sourceMatchScore:c.matchScore,apiFixtureId:c.api.fixture.id})));
  const usable=candidates.filter(x=>x.odds>1&&x.modelProbability>=50).sort((a,b)=>(b.edge??-99)-(a.edge??-99));
  if(!usable.length){await sendText(chatId,"⚠️ No statistically supported selections met the minimum threshold.");return;}
  const picks=await rankWithAI(usable.slice(0,60),Math.min(20,Math.max(1,requested)));
  if(!picks.length){await sendText(chatId,"⚠️ The AI ranking returned no selections.");return;}
  const lines=picks.map((p,i)=>`${i+1}. ${p.match}\n   🎯 ${p.market}: ${p.selection} @ ${Number(p.odds).toFixed(2)}\n   📊 Model: ${p.modelProbability.toFixed(1)}% | Implied: ${(impliedProbability(p.odds)*100).toFixed(1)}% | Edge: ${((p.edge||0)*100).toFixed(1)}%\n   ${p.confidence} confidence • ${p.risk} risk\n   ${p.rationale}`);
  await sendText(chatId,`🤖 AI FOOTBALL ANALYSIS — ${offset?"TOMORROW":"TODAY"}\n\n${lines.join("\n\n")}\n\n📈 Combined odds: ${combinedOdds(picks).toFixed(2)}\n\n⚠️ Statistical ranking, not a guarantee.`);
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
  if(s.selections.length>=20) return sendText(chatId,"Your slip has reached the 20-selection limit.",bookingKeyboard([]));
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

async function handleAction(chatId,action){
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
    {command:"analyze",description:"AI football analysis"},\n    {command:"book",description:"Build a SportyBet booking code"},
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
    if(command==="/book"){await startBooking(chatId);return res.status(200).json({ok:true});}\n    if(command==="/start"||command==="/help"){await setBotCommands();await sendText(chatId,"⚽🏀🎾 SportyBet Markets Bot\n\nChoose a sport or request all sports:",MAIN_MENU);return res.status(200).json({ok:true});}
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
