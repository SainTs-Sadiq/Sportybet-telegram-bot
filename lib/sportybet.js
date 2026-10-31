import { MARKET_IDS, MARKET_NAMES } from "./markets.js";

const BASE = process.env.SPORTYBET_API_BASE_URL || "https://www.sportybet.com";
const REGION = process.env.SPORTYBET_REGION || "ng";
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Keep the initial payload small. Asking SportyBet for every market at once has
// been timing out on the desktop endpoint; the bot can still display the main
// markets and the full market catalogue remains available for labels.
const CORE_MARKET_IDS = ["1", "18", "10", "29", "11", "26", "36", "14", "60100"];
const BASKETBALL_MARKET_IDS = ["219", "225", "223"];

async function fetchJson(url, attempts = 3) {
  let last = { status: 502, json: null, body: "No response" };
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
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
        signal: AbortSignal.timeout(20000)
      });
      if (res.ok) {
        try {
          const json = await res.json();
          return { status: res.status, json, body: null };
        } catch {
          last = { status: 502, json: null, body: "Response was not valid JSON" };
        }
      } else {
        let body = "";
        try { body = await res.text(); } catch {}
        last = { status: res.status, json: null, body: body.slice(0, 1000) };
      }
      if (attempt < attempts && (last.status === 429 || last.status >= 500)) {
        await sleep(400 * attempt);
        continue;
      }
      return last;
    } catch (err) {
      last = { status: 502, json: null, body: err instanceof Error ? err.message : String(err) };
      if (attempt < attempts) {
        await sleep(400 * attempt);
        continue;
      }
    }
  }
  return last;
}

function makeUrl(path, { pageNum, pageSize, hours, sportId, marketIds, slimMarkets = false }) {
  const url = new URL(`${BASE}/api/${REGION}/factsCenter/${path}`);
  url.searchParams.set("sportId", sportId || "sr:sport:1");
  // Never apply football market IDs to another sport.
  const selectedMarkets = Array.isArray(marketIds)
    ? marketIds
    : (sportId === "sr:sport:1" ? (slimMarkets ? CORE_MARKET_IDS : MARKET_IDS)
      : sportId === "sr:sport:2" ? BASKETBALL_MARKET_IDS
      : []);
  if (selectedMarkets.length) url.searchParams.set("marketId", selectedMarkets.join(","));
  url.searchParams.set("pageSize", String(Math.min(Number(pageSize) || 100, 100)));
  url.searchParams.set("pageNum", String(pageNum));
  url.searchParams.set("todayGames", "false");
  url.searchParams.set("timeline", String(Math.min(hours, 720)));
  url.searchParams.set("_t", String(Date.now()));
  return url;
}

export async function getFixtures({ hours = 48, pageSize = 100, maxPages = 10, sportId = "sr:sport:1", marketIds } = {}) {
  const all = [];
  let endpoint = "pcUpcomingEvents";

  for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
    const paths = sportId === "sr:sport:1"
      ? (endpoint === "wapConfigurableUpcomingEvents" ? [endpoint, "pcUpcomingEvents"] : ["pcUpcomingEvents", "wapConfigurableUpcomingEvents"])
      : ["wapConfigurableUpcomingEvents", "pcUpcomingEvents"];
    let result = null, bestCount = -1, selectedPath = null;
    let sawUpstreamFailure = false;

    // Race all endpoint/slim variants in parallel; sequential trials added up
    // to two full request round-trips per page.
    const attempts = [...new Set(paths)].flatMap((path) => {
      const variants = path === "pcUpcomingEvents" && sportId === "sr:sport:1" && !Array.isArray(marketIds)
        ? [false, true]
        : [false];
      return variants.map((slimMarkets) => ({ path, slimMarkets }));
    });
    const responses = await Promise.all(attempts.map(async ({ path, slimMarkets }) => {
      const requestUrl = makeUrl(path, { pageNum, pageSize, hours, sportId, marketIds, slimMarkets });
      const r = await fetchJson(requestUrl);
      return { path, slimMarkets, requestUrl, r };
    }));
    for (const { path, slimMarkets, requestUrl, r } of responses) {
      if (r.status === 200 && r.json?.bizCode === 10000) {
        const eventRows = responseEventRows(r.json, sportId);
        const eventCount = eventRows.length;
        console.log("[fixtures-debug]", JSON.stringify({
          sportId, path, pageNum, status: r.status, bizCode: r.json?.bizCode,
          totalNum: r.json?.data?.totalNum, tournamentCount: Array.isArray(r.json?.data) ? new Set(eventRows.map(({ tournament }) => tournament.name)).size : (r.json?.data?.tournaments || []).length,
          eventCount, marketFilter: requestUrl.searchParams.get("marketId"),
          slimMarkets
        }));
        if (eventCount > bestCount) {
          result = r.json;
          bestCount = eventCount;
          selectedPath = path;
        }
      } else {
        if (r.status >= 500 || r.status === 429) sawUpstreamFailure = true;
        console.log("[fixtures-debug-response]", JSON.stringify({
          sportId, path, pageNum, status: r.status,
          bizCode: r.json?.bizCode ?? null,
          message: r.json?.message ?? r.json?.msg ?? null,
          requestParams: Object.fromEntries(requestUrl.searchParams.entries()),
          bodyPreview: r.json === null ? (r.body || null) : JSON.stringify(r.json).slice(0, 500)
        }));
      }
    }

    if (selectedPath) endpoint = selectedPath;
    if (!result) {
      throw new Error(sawUpstreamFailure
        ? "SportyBet's fixture feed is timing out or temporarily unavailable. Please try again shortly."
        : "SportyBet rejected the fixture request. The upstream API may have changed; please try again later.");
    }

    const eventRows = parseFixtureResponse(result, sportId);
    all.push(...eventRows);
    const total = Number(result?.data?.totalNum || all.length);
    if (all.length >= total || eventRows.length === 0) break;
    await sleep(300);
  }
  return all;
}

// Desktop responses wrap events in data.tournaments[].events; the WAP endpoint
// returns events directly in data[] with sport metadata nested. Keep this parser
// exported so a captured feed can be dry-parsed without making network calls.
export function parseFixtureResponse(payload, sportId = "sr:sport:1") {
  return responseEventRows(payload, sportId).map(({event,tournament})=>normalizeFixtureEvent(event,tournament,sportId));
}

export function responseEventRows(payload, sportId) {
  const data = payload?.data;
  if (Array.isArray(data)) return data.map(event => ({
    event,
    tournament: {
      name: event?.sport?.category?.tournament?.name || event?.tournamentName || "Unknown",
      categoryName: event?.sport?.category?.name || event?.categoryName || "",
      sportId: event?.sport?.id || event?.sportId || sportId
    }
  }));
  return (Array.isArray(data?.tournaments) ? data.tournaments : []).flatMap(tournament =>
    (Array.isArray(tournament.events) ? tournament.events : []).map(event => ({ event, tournament }))
  );
}

export function normalizeFixtureEvent(event, tournament, sportId = "sr:sport:1") {
  return {
    eventId: String(event.eventId),
    league: tournament?.name || tournament?.categoryName || "Unknown",
    category: tournament?.categoryName || "",
    homeTeam: event.homeTeamName || "",
    awayTeam: event.awayTeamName || "",
    startMs: Number(event.estimateStartTime),
    status: event.matchStatus,
    sportId: event.sportId || tournament?.sportId || sportId,
    sourceSportId: event.sportId || tournament?.sportId || null,
    markets: (event.markets || []).map(m => ({
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


// Create a non-staking SportyBet slip share code. This POST is intentionally
// never retried because the first request may have succeeded without a reply.
export async function createBooking(selections) {
  if (!Array.isArray(selections) || selections.length < 1 || selections.length > 50) {
    throw new Error("Choose between 1 and 50 selections.");
  }
  const clean = selections.map((s) => ({
    eventId: String(s.eventId || ""),
    marketId: String(s.marketId || ""),
    specifier: String(s.specifier || ""),
    outcomeId: String(s.outcomeId || "")
  }));
  if (clean.some(s => !s.eventId || !s.marketId || !s.outcomeId)) {
    throw new Error("A selection is missing its event, market, or outcome ID.");
  }
  const unique = new Set(clean.map(s => [s.eventId, s.marketId, s.specifier, s.outcomeId].join(":")));
  if (unique.size !== clean.length) throw new Error("Remove duplicate selections before generating a code.");

  const response = await fetch(`${BASE}/api/${REGION}/orders/share`, {
    method: "POST",
    headers: {
      "Accept": "application/json, text/plain, */*",
      "Content-Type": "application/json",
      "Current-Country": REGION.toUpperCase(),
      "Accept-Language": "en-NG,en;q=0.9",
      "Referer": `${BASE}/ng/`,
      "Origin": BASE,
      "User-Agent": "Mozilla/5.0 (Linux; Android 12; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36"
    },
    body: JSON.stringify({ selections: clean }),
    signal: AbortSignal.timeout(15000)
  });
  let payload = null;
  try { payload = await response.json(); } catch {}
  const data = payload?.data || {};
  if (!response.ok || (payload?.bizCode && payload.bizCode !== 10000) || !(data.shareCode || data.shareURL)) {
    throw new Error(`SportyBet rejected the booking request (HTTP ${response.status}). No automatic retry was made; check SportyBet before submitting again.`);
  }
  return {
    shareCode: String(data.shareCode || ""),
    shareURL: String(data.shareURL || ""),
    deadline: Number(data.deadline || 0),
    outcomes: Array.isArray(data.outcomes) ? data.outcomes : [],
    unavailableOutcomes: Array.isArray(data.unavailableOutcomes) ? data.unavailableOutcomes : []
  };
}
