import { MARKET_IDS, MARKET_NAMES } from "./markets.js";
const BASE = process.env.SPORTYBET_API_BASE_URL || "https://www.sportybet.com";
const REGION = process.env.SPORTYBET_REGION || "ng";
export async function getFixtures({ hours = 48, pageSize = 100, maxPages = 10 } = {}) {
  const all = [];
  for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
    const url = new URL(`${BASE}/api/${REGION}/factsCenter/pcUpcomingEvents`);
    url.searchParams.set("sportId", "sr:sport:1"); url.searchParams.set("marketId", MARKET_IDS.join(","));
    url.searchParams.set("pageSize", String(pageSize)); url.searchParams.set("pageNum", String(pageNum));
    url.searchParams.set("todayGames", "false"); url.searchParams.set("timeline", String(Math.min(hours,720))); url.searchParams.set("_t", String(Date.now()));
    const res = await fetch(url, { headers:{Accept:"application/json","Current-Country":"NG","User-Agent":"Mozilla/5.0"}, signal:AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`SportyBet HTTP ${res.status}`);
    const json = await res.json(); if (json?.bizCode !== 10000) throw new Error(`SportyBet rejected request (bizCode ${json?.bizCode})`);
    const tournaments = json?.data?.tournaments || [];
    for (const tournament of tournaments) for (const event of (tournament.events || [])) all.push(normalizeEvent(event,tournament));
    const total = Number(json?.data?.totalNum || all.length); if (all.length >= total || tournaments.length === 0) break;
    await new Promise(r=>setTimeout(r,300));
  }
  return all;
}
function normalizeEvent(event,tournament) {
  return { eventId:String(event.eventId), league:tournament?.name || tournament?.categoryName || "Unknown", category:tournament?.categoryName || "",
    homeTeam:event.homeTeamName || "", awayTeam:event.awayTeamName || "", startMs:Number(event.estimateStartTime), status:event.matchStatus,
    markets:(event.markets || []).map(m=>({id:String(m.id),name:MARKET_NAMES[String(m.id)] || m.desc || `Market ${m.id}`,desc:m.desc || "",specifier:m.specifier ?? "",status:m.status,
      outcomes:(m.outcomes || []).map(o=>({id:String(o.id),name:o.desc || String(o.id),odds:Number(o.odds),active:Boolean(o.isActive)}))})) };
}
export function filterByDay(fixtures,dayOffset=0,timeZone="Africa/Lagos") {
  const fmt=new Intl.DateTimeFormat("en-CA",{timeZone,year:"numeric",month:"2-digit",day:"2-digit"});
  const base=fmt.format(new Date()); const target=new Date(`${base}T12:00:00Z`); target.setUTCDate(target.getUTCDate()+dayOffset); const date=target.toISOString().slice(0,10);
  return fixtures.filter(f=>fmt.format(new Date(f.startMs))===date).sort((a,b)=>a.startMs-b.startMs);
}