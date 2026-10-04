import { getFixtures, filterByDay } from "../lib/sportybet.js";
import { makePdf, makeXlsx } from "../lib/reports.js";

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
  [{text:"📄 PDF",callback_data:"pdf_today"},{text:"📊 Excel",callback_data:"excel_today"}],
  [{text:"📄 Tomorrow PDF",callback_data:"pdf_tomorrow"},{text:"📊 Tomorrow Excel",callback_data:"excel_tomorrow"}],
  [{text:"🏆 Leagues",callback_data:"leagues"},{text:"📈 Markets",callback_data:"markets"}]
]};

async function loadDay(offset){const key=String(offset);if(cache.key===key&&Date.now()-cache.at<45000)return cache.fixtures;const raw=await getFixtures({hours:offset?72:48,pageSize:100,maxPages:10});const fixtures=filterByDay(raw,offset,TZ);cache={key,at:Date.now(),fixtures};return fixtures;}
function filterFixtures(fixtures,{search="",league="",market=""}={}){const s=search.toLowerCase().trim(),l=league.toLowerCase().trim(),m=market.toLowerCase().trim();return fixtures.filter(f=>{const teamText=`${f.homeTeam} ${f.awayTeam}`.toLowerCase(),leagueText=`${f.league} ${f.category}`.toLowerCase(),marketText=f.markets.map(x=>x.name).join(" ").toLowerCase();return(!s||teamText.includes(s))&&(!l||leagueText.includes(l))&&(!m||marketText.includes(m));});}
function summary(fixtures,label){const groups=fixtures.reduce((n,f)=>n+f.markets.length,0),outcomes=fixtures.reduce((n,f)=>n+f.markets.reduce((a,m)=>a+m.outcomes.length,0),0);return `⚽ ${label}\n\nGames: ${fixtures.length}\nMarket groups: ${groups}\nSelections/outcomes: ${outcomes}\n\nUse the buttons below or /help for commands.`;}

async function handleAction(chatId,action){
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
    if(text==="/start"||text==="/help"){await sendText(chatId,`⚽ SportyBet Markets Bot v2\n\nTODAY / TOMORROW\n/today — today's games\n/tomorrow — tomorrow's games\n\nREPORTS\n/pdf — today's full PDF\n/pdf_tomorrow — tomorrow's PDF\n/excel — today's Excel\n/excel_tomorrow — tomorrow's Excel\n\nFILTERS\n/search Arsenal — find team fixtures\n/leagues — league list\n/markets — today's market list\n/market corners — games offering that market\n\nThe reports contain the games, available markets, selections and current odds returned by SportyBet.\n\n🤖 AI analysis is not enabled yet. The bot currently reports live market data only.`,keyboard);return res.status(200).json({ok:true});}
    const command=text.split(/\s+/)[0];
    if(command==="/today"||command==="/tomorrow"){await handleAction(chatId,command.slice(1));return res.status(200).json({ok:true});}
    if(command==="/pdf"||command==="/excel"||command==="/pdf_tomorrow"||command==="/excel_tomorrow"){const action=command.startsWith("/pdf")?`pdf_${command.includes("tomorrow")?"tomorrow":"today"}`:`excel_${command.includes("tomorrow")?"tomorrow":"today"}`;await handleAction(chatId,action);return res.status(200).json({ok:true});}
    if(command==="/leagues"||command==="/markets"){await handleAction(chatId,command.slice(1));return res.status(200).json({ok:true});}
    if(command==="/search"||command==="/market"){const query=rawText.slice(command.length).trim();if(!query){await sendText(chatId,command==="/search"?"Usage: /search Arsenal":"Usage: /market corners");return res.status(200).json({ok:true});}const fixtures=await loadDay(0),filtered=command==="/search"?filterFixtures(fixtures,{search:query}):filterFixtures(fixtures,{market:query});const lines=filtered.slice(0,35).map((f,i)=>`${i+1}. ${new Intl.DateTimeFormat("en-GB",{timeZone:TZ,hour:"2-digit",minute:"2-digit"}).format(new Date(f.startMs))} — ${f.homeTeam} vs ${f.awayTeam}\n   ${f.league}`);await sendText(chatId,`🔎 ${command==="/search"?"Search":"Market"}: ${query}\n\n${lines.join("\n")||"No matching fixtures found."}\n\nFound ${filtered.length} game(s).`);return res.status(200).json({ok:true});}
    await sendText(chatId,"Unknown command. Send /help to see everything available.",keyboard);return res.status(200).json({ok:true});
  }catch(e){console.error(e);await sendText(chatId,`❌ Error: ${e.message||"Unable to retrieve SportyBet data."}`);return res.status(200).json({ok:false});}
}
