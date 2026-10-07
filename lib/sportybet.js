import { MARKET_IDS, MARKET_NAMES } from "./markets.js";

const BASE = process.env.SPORTYBET_API_BASE_URL || "https://www.sportybet.com";
const REGION = process.env.SPORTYBET_REGION || "ng";

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      "Accept": "application/json, text/plain, */*",
      "Content-Type": "application/json",
      "Current-Country": REGION.toUpperCase(),
      "Accept-Language": "en-NG,en;q=0.9",
      "Referer": `${BASE}/ng/`,
      "Origin": BASE,
      "User-Agent": "Mozilla/5.0 (Linux; Android 12; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36"
    },
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) return { status: res.status, json: null };
  try { return { status: res.status, json: await res.json() }; }
  catch { return { status: 502, json: null }; }
}

function makeUrl(path, { pageNum, pageSize, hours, sportId, marketIds }) {
  const url = new URL(`${BASE}/api/${REGION}/factsCenter/${path}`);
  url.searchParams.set("sportId", "sr:sport:1");
  url.searchParams.set("marketId", MARKET_IDS.join(","));
  url.searchParams.set("pageSize", String(pageSize));
  url.searchParams.set("pageNum", String(pageNum));
  url.searchParams.set("todayGames", "false");
  url.searchParams.set("timeline", String(Math.min(hours, 720)));
  url.searchParams.set("_t", String(Date.now()));
  return url;
}

export async function getFixtures({ hours = 48, pageSize = 100, maxPages = 10, sportId = "sr:sport:1", marketIds = MARKET_IDS } = {}) {
  const all = [];
  let endpoint = "pcUpcomingEvents";

  for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
    const paths = endpoint === "wapConfigurableUpcomingEvents"
      ? [endpoint]
      : ["pcUpcomingEvents", "wapConfigurableUpcomingEvents"];
    let result;
    for (const path of paths) {
      const r = await fetchJson(makeUrl(path, { pageNum, pageSize, hours, sportId, marketIds }));
      if (r.status === 200 && r.json?.bizCode === 10000) {
        result = r.json;
        endpoint = path;
        break;
      }
      if (r.status === 429 || r.status >= 500) await sleep(600);
    }

    if (!result) {
      throw new Error("SportyBet is refusing cloud-server requests (HTTP 403) or is temporarily unavailable. Please try again shortly.");
    }

    const tournaments = result?.data?.tournaments || [];
    for (const tournament of tournaments) {
      for (const event of (tournament.events || [])) {
        all.push(normalizeEvent(event, tournament, sportId));
      }
    }
    const total = Number(result?.data?.totalNum || all.length);
    if (all.length >= total || tournaments.length === 0) break;
    await sleep(300);
  }
  return all;
}

function normalizeEvent(event, tournament, sportId = "sr:sport:1") {
  return {
    eventId: String(event.eventId),
    league: tournament?.name || tournament?.categoryName || "Unknown",
    category: tournament?.categoryName || "",
    homeTeam: event.homeTeamName || "",
    awayTeam: event.awayTeamName || "",
    startMs: Number(event.estimateStartTime),
    status: event.matchStatus,
    sportId: event.sportId || tournament?.sportId || sportId,\n    markets: (event.markets || []).map(m => ({
      id: String(m.id),
      name: MARKET_NAMES[String(m.id)] || m.desc || `Market ${m.id}`,
      desc: m.desc || "",
      specifier: m.specifier ?? "",
      status: m.status,
      outcomes: (m.outcomes || []).map(o => ({
        id: String(o.id),
        name: o.desc || String(o.id),
        odds: Number(o.odds),
        active: Boolean(o.isActive)
      }))
    }))
  };
}

export function filterByDay(fixtures, dayOffset = 0, timeZone = "Africa/Lagos") {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone, year:"numeric", month:"2-digit", day:"2-digit" });
  const base = fmt.format(new Date());
  const target = new Date(`${base}T12:00:00Z`);
  target.setUTCDate(target.getUTCDate() + dayOffset);
  const date = target.toISOString().slice(0, 10);
  return fixtures.filter(f => fmt.format(new Date(f.startMs)) === date).sort((a,b) => a.startMs - b.startMs);
}
