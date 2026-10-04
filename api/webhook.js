import { getFixtures, filterByDay, filterFixtures as sf } from "../lib/sportybet.js";
import { makePdf, makeXlsx } from "../lib/reports.js";
import { getDailyFixtures, buildCandidates, getPredictions, impliedProbability } from "../lib/football.js";
import { marketCandidates, rankWithAI, combinedOdds } from "../lib/ai.js";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SECRET = process.env.BOT_SECRET;
const TZ = process.env.REPORT_TIMEZONE || "Africa/Lagos";
let cache = { key: "", at: 0, fixtures: [] };

async function tg(method, body) { return fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body) }); }
async function sendText(chatId,text,replyMarkup){const body={chat_id:chatId,text};if(replyMarkup)body.reply_markup=replyMarkup;return tg("sendMessage",body);}
async function answerCallback(id){return tg("answerCallbackQuery",{callback_query_id:id});}
async function sendDocument(chatId,buffer,filename,caption){const form=new FormData();form.append("chat_id",String(chatId));form.append("caption",caption);form.append("document",new Blob([buffer]),filename);return fetch(`https://api.telegram.org/bot${TOKEN}/sendDocument`,{method:"POST",body:form});}

const keyboard={inline_keyboard:[
  [{text:"⚽ Today",callback_data:"today"},{text:"🔮 Tomorrow",callback_data:"tomorrow"}],
  [{text:"🤖 AI 10 Picks",callback_data:"ai_tomorrow_10"},{text:"🤖 AI 20 Picks",callback_data:"ai_tomorrow_20"}],
  [{text:"📄 PDF",callback_data:"pdf_today"},{text:"📊 Excel",callback_data:"excel_today"}],
  [{text:"📄 Tomorrow PDF",callback_data:"pdf_tomorrow"},{text:"📊 Tomorrow Excel",callback_data:"excel_tomorrow"}],
  [{text:"🏆 Leagues",callback_data:"leagues"},{text:"📈 Markets",callback_data:"markets"}]
]};

async function loadDay(offset){const key=String(offset);if(cache.key===key&&Date.now()-cache.at<45000)return cache.fixtures;const raw=await getFixtures({hours:offset?72:48,pageSize:100,maxPages:10});const fixtures=filterByDay(raw,offset,TZ);cache={key,at:Date.now(),fixtures};return fixtures;}
function filterFixtures(fixtures,{search="",league="",market=""}={}){const s=search.toLowerCase().trim(),l=league.toLowerCase().trim(),m=market.toLowerCase().trim();return fixtures.filter(f=>{const teamText=`${f.homeTeam} ${f.awayTeam}`.toLowerCase(),leagueText=`${f.league} ${f.category}`.toLowerCase(),marketText=f.markets.map(x=>x.name).join(" ").toLowerCase();return(!s||teamText.includes(s))&&(!l||leagueText.includes(l))&&(!m||marketText.includes(m));});}
function summary(fixtures,label){const groups=fixtures.reduce((n,f)=>n+f.markets.length,0),outcomes=fixtures.reduce((n,f)=>n+f.markets.reduce((a,m)=>a+m.outcomes.length,0),0);return `⚽ ${label}\n\nGames: ${fixtures.length}\nMarket groups: ${groups}\nSelections/outcomes: ${outcomes}\n\nUse the buttons below or /help for commands.`;}

function dateForOffset(offset){const now=new Date();const parts=new Intl.DateTimeFormat("en-CA",{timeZone:TZ,year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(now);const y=parts.find(x=>x.type==="year").value,m=parts.find(x=>x.type==="month").value,d=parts.find(x=>x.type==="day").value;const dt=new Date(`${y}-${m}-${d}T12:00:00Z`);dt.setUTCDate(dt.getUTCDate()+offset);return dt.toISOString().slice(0,10);}

async function analyzeDay(chatId, offset=1, requested=10){
  if(!process.env.API_FOOTBALL_KEY) throw new Error("AI analysis needs API_FOOTBALL_KEY in Vercel.");
  if(!process.env.OPENAI_API_KEY) throw new Error("AI analysis needs OPENAI_API_KEY in Vercel.");
  const fixtures=await loadDay(offset);
  if(!fixtures.length){await sendText(chatId,"No SportyBet fixtures found for the selected day.");return;}
  await sendText(chatId,`🤖 Analyzing ${fixtures.length} games...\n\nChecking SportyBet markets against football performance/prediction data. This can take a little longer than a normal report.`);
  const date=dateForOffset(offset);
  const external=await getDailyFixtures(date);
  const matched=buildCandidates(fixtures,external,25);
  if(!matched.length){await sendText(chatId,"⚠️ I couldn't match the SportyBet fixtures to the statistical provider for this date. No picks were generated.");return;}
  const predicted=(await Promise.all(matched.map(async c=>{try{return {...c,prediction:await getPredictions(c.api.fixture?.id)}}catch{return {...c,prediction:null}}}))).filter(x=>x.prediction);
  const candidates=predicted.flatMap(c=>marketCandidates(c.sporty,c.prediction).map(x=>({...x,sourceMatchScore:c.matchScore,apiFixtureId:c.api.fixture.id})));
  const usable=candidates.filter(x=>x.odds>1 && x.modelProbability>=50).sort((a,b)=>(b.edge??-99)-(a.edge??-99));
  if(!usable.length){await sendText(chatId,"⚠️ No statistically supported SportyBet selections met the minimum threshold. I won't manufacture picks just to fill the list.");return;}
  const picks=await rankWithAI(usable.slice(0,60),Math.min(20,Math.max(1,requested)));
  if(!picks.length){await sendText(chatId,"⚠️ The AI ranking returned no selections.");return;}
  const lines=picks.map((p,i)=>`${i+1}. ${p.match}\n   🎯 ${p.market}: ${p.selection} @ ${Number(p.odds).toFixed(2)}\n   📊 Model: ${p.modelProbability.toFixed(1)}% | Implied: ${(impliedProbability(p.odds)*100).toFixed(1)}% | Edge: ${((p.edge||0)*100).toFixed(1)}%\n   ${p.confidence} confidence • ${p.risk} risk\n   ${p.rationale}`);
  const combined=combinedOdds(picks);
  await sendText(chatId,`🤖 AI STATISTICAL ANALYSIS — ${offset?"TOMORROW":"TODAY"}\n\n${lines.join("\n\n")}\n\n📈 Combined odds of these selections: ${combined.toFixed(2)}\n\n⚠️ This is a statistical ranking, not a guarantee. Picks are only generated where the available data supports them.\n\nData sources: SportyBet markets/odds + API-Football prediction data + AI ranking.`);
}

async function handleAction(chatId,action){
  if(action.startsWith("ai_tomorrow_")){const n=Number(action.split("_").pop())||10;return analyzeDay(chatId,1,n);}
  if(action==="leagues"){const fixtures=[...await loadDay(0),...await loadDay(1)],counts=new Map();for(const f of fixtures)counts.set(f.league,(counts.get(f.league)||0)+1);const lines=[...counts.entries()].sort((a,b)=>b[1]-a[1]).slice(0,40).map(([name,n],i)=>`${i+1}. ${name} — ${n} games`);return sendText(chatId,`🏆 Leagues found\n\n${lines.join("\n")||"No leagues found."}`);}
  if(action==="markets"){const fixtures=await loadDay(0),counts=new Map();for(const f of fixtures)for(const m of f.markets)counts.set(m.name,(counts.get(m.name)||0)+1);const lines=[...counts.entries()].sort((a,b)=>b[1]-a[1]).slice(0,50).map(([name,n],i)=>`${i+1}. ${name} — ${n} games`);return sendText(chatId,`📈 Today's markets\n\n${lines.join("\n")||"No markets found."}`);}
  const offset=action.includes("tomorrow")?1:0,fixtures=await loadDay(offset);
  if(action==="today"||action==="tomorrow")return sendText(chatId,summary(fixtures,offset?"Tomorrow":"Today"),keyboard);
  const isPdf=action.startsWith("pdf_"),isExcel=action.startsWith("excel_");
  if(isPdf||isExcel){await sendText(chatId,`⏳ Building ${offset?"tomorrow's":"today's"} ${isPdf?"PDF":"Excel report"} for ${fixtures.length} games...`);if(isPdf){const b=await makePdf(fixtures,TZ,`SportyBet Football Markets — ${offset?"Tomorrow":"Today"}`);await sendDocument(chatId,b,`sportybet-${offset?"tomorrow":"today"}.pdf`,`📄 SportyBet report • ${fixtures.length} games`);}else{const b=makeXlsx(fixtures,TZ);await sendDocument(chatId,b,`sportybet-${offset?"tomorrow":"today"}.xlsx`,`📊 SportyBet spreadsheet • ${fixtures.length} games`);}}
}

export default async function handler(req,res){
  if(req.method!=="POST")return res.status(200).json({ok:true,service:"sportybet-telegram-bot"});
  if(SECRET&&req.headers["x-telegram-bot-api-secret-token"]!==SECRET)return res.status(401).end();
  const update=req.body||{},msg=update.message,callback=update.callback_query,chatId=msg?.chat?.id||callback?.message?.chat?.id;if(!chatId)return res.status(200).json({ok:true});
  try{
    if(callback){await answerCallback(callback.id);await handleAction(chatId,callback.data);return res.status(200).json({ok:true});}
    const rawText=(msg.text||"").trim(),text=rawText.toLowerCase();
    if(text==="/start"||text==="/help"){await sendText(chatId,`⚽ SportyBet Markets Bot v3\n\nTODAY / TOMORROW\n/today — today's games\n/tomorrow — tomorrow's games\n\nREPORTS\n/pdf — today's full PDF\n/pdf_tomorrow — tomorrow's PDF\n/excel — today's Excel\n/excel_tomorrow — tomorrow's Excel\n\nFILTERS\n/search Arsenal — find team fixtures\n/leagues — league list\n/markets — today's market list\n/market corners — games offering that market\n\n🤖 AI ANALYSIS\n/analyze tomorrow 10 — rank up to 10 statistical picks\n/analyze tomorrow 20 — rank up to 20 statistical picks\n\nAI combines SportyBet odds with external football prediction/performance data and then uses an AI ranking layer. It does not guarantee outcomes or place wagers.`,keyboard);return res.status(200).json({ok:true});}
    const command=text.split(/\s+/)[0];
    if(command==="/analyze"){const parts=text.split(/\s+/),when=parts[1]==="today"?0:1,n=Math.min(20,Math.max(1,Number(parts[2])||10));await analyzeDay(chatId,when,n);return res.status(200).json({ok:true});}
    if(command==="/today"||command==="/tomorrow"){await handleAction(chatId,command.slice(1));return res.status(200).json({ok:true});}
    if(command==="/pdf"||command==="/excel"||command==="/pdf_tomorrow"||command==="/excel_tomorrow"){const action=command.startsWith("/pdf")?`pdf_${command.includes("tomorrow")?"tomorrow":"today"}`:`excel_${command.includes("tomorrow")?"tomorrow":"today"}`;await handleAction(chatId,action);return res.status(200).json({ok:true});}
    if(command==="/leagues"||command==="/markets"){await handleAction(chatId,command.slice(1));return res.status(200).json({ok:true});}
    if(command==="/search"||command==="/market"){const query=rawText.slice(command.length).trim();if(!query){await sendText(chatId,command==="/search"?"Usage: /search Arsenal":"Usage: /market corners");return res.status(200).json({ok:true});}const fixtures=await loadDay(0),filtered=command==="/search"?filterFixtures(fixtures,{search:query}):filterFixtures(fixtures,{market:query});const lines=filtered.slice(0,35).map((f,i)=>`${i+1}. ${new Intl.DateTimeFormat("en-GB",{timeZone:TZ,hour:"2-digit",minute:"2-digit"}).format(new Date(f.startMs))} — ${f.homeTeam} vs ${f.awayTeam}\n   ${f.league}`);await sendText(chatId,`🔎 ${command==="/search"?"Search":"Market"}: ${query}\n\n${lines.join("\n")||"No matching fixtures found."}\n\nFound ${filtered.length} game(s).`);return res.status(200).json({ok:true});}
    await sendText(chatId,"Unknown command. Send /help to see everything available.",keyboard);return res.status(200).json({ok:true});
  }catch(e){console.error(e);await sendText(chatId,`❌ Error: ${e.message||"Unable to retrieve data."}`);return res.status(200).json({ok:false});}
}
