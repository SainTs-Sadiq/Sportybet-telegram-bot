import { get, list, put } from "@vercel/blob";

const BASE = "https://footballcharts-backend.onrender.com/api/v1";
const CACHE_TTL = 12 * 60 * 60 * 1000;
const mem = new Map();

function norm(s) {
  return String(s || "").normalize("NFKD").toLowerCase()
    .replace(/\b(fc|cf|sc|afc|club|the)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ").trim();
}
function slug(s) { return norm(s).replace(/\s+/g, "-").slice(0, 100) || "unknown"; }

async function readCache(pathname) {
  const hit = mem.get(pathname);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.data;
  if (!process.env.BLOB_READ_WRITE_TOKEN) return null;
  try {
    const item = await get(pathname, { access: "private" });
    if (!item || item.statusCode !== 200 || !item.stream) return null;
    const chunks = [];
    for await (const chunk of item.stream) chunks.push(Buffer.from(chunk));
    const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    mem.set(pathname, { at: Date.now(), data });
    return data;
  } catch (e) {
    if (!/not found|404/i.test(String(e?.message || e))) console.warn("[history-cache-read]", pathname, e.message);
    return null;
  }
}

async function writeCache(pathname, data) {
  mem.set(pathname, { at: Date.now(), data });
  if (!process.env.BLOB_READ_WRITE_TOKEN) return;
  try {
    await put(pathname, JSON.stringify(data), {
      access: "private", contentType: "application/json", allowOverwrite: true
    });
  } catch (e) { console.warn("[history-cache-write]", pathname, e.message); }
}

async function fetchJson(url) {
  const r = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`Football Charts HTTP ${r.status}`);
  return r.json();
}
function unwrapList(json) {
  if (Array.isArray(json)) return json;
  for (const key of ["data", "leagues", "results", "matches", "fixtures"]) {
    if (Array.isArray(json?.[key])) return json[key];
    if (Array.isArray(json?.data?.[key])) return json.data[key];
  }
  return [];
}
function pick(o, keys) {
  for (const k of keys) if (o?.[k] !== undefined && o?.[k] !== null && o?.[k] !== "") return o[k];
  return null;
}
function scoreOf(m) {
  const hg = pick(m, ["home_goals", "homeGoals", "goals_home", "score_home"]);
  const ag = pick(m, ["away_goals", "awayGoals", "goals_away", "score_away"]);
  if (hg !== null && ag !== null && Number.isFinite(Number(hg)) && Number.isFinite(Number(ag))) return [Number(hg), Number(ag)];
  const score = pick(m, ["score", "ft_score", "full_time_score", "result", "ft_result"]);
  if (typeof score === "string") {
    const match = score.match(/^(\d+)\s*[:\-–]\s*(\d+)$/);
    if (match) return [Number(match[1]), Number(match[2])];
  }
  return null;
}
function normalizeResult(m, league) {
  const home = pick(m, ["home_team_name", "homeTeam", "home_team", "home"]);
  const away = pick(m, ["away_team_name", "awayTeam", "away_team", "away"]);
  const score = scoreOf(m);
  const status = String(pick(m, ["match_status", "status", "state"]) || "").toLowerCase();
  if (!home || !away || !score) return null;
  if (status && !["finished", "ft", "complete", "completed", "ended", "played"].includes(status)) return null;
  return {
    league, home: String(typeof home === "object" ? home.name || home.team_name || "" : home),
    away: String(typeof away === "object" ? away.name || away.team_name || "" : away),
    homeGoals: score[0], awayGoals: score[1],
    date: String(pick(m, ["kickoff_date", "date", "match_date", "utc_date"]) || ""),
    source: "Football Charts"
  };
}

async function getLeagueIndex() {
  const path = "team-history/league-index.json";
  const cached = await readCache(path);
  if (cached?.items?.length) return cached.items;
  const raw = await fetchJson(`${BASE}/leagues/`);
  const items = unwrapList(raw).map(l => ({
    slug: String(pick(l, ["slug", "key", "code", "id", "league"]) || ""),
    name: String(pick(l, ["name", "league_name", "title"]) || ""),
    country: String(pick(l, ["country", "country_name", "area"]) || ""),
    seasons: pick(l, ["seasons", "available_seasons"]) || []
  })).filter(l => l.slug && l.name);
  if (items.length) await writeCache(path, { items, fetchedAt: Date.now() });
  return items;
}
function leagueScore(a, b) {
  const A = norm(a), B = norm(b);
  if (!A || !B) return 0;
  if (A === B) return 1;
  const aa = new Set(A.split(" ")), bb = new Set(B.split(" "));
  const overlap = [...aa].filter(x => bb.has(x)).length / Math.max(aa.size, bb.size);
  return overlap;
}
async function getLeagueResults(league) {
  const path = `team-history/results-${slug(league.slug)}.json`;
  const cached = await readCache(path);
  if (cached?.matches?.length && Date.now() - Number(cached.fetchedAt || 0) < CACHE_TTL) return cached.matches;
  const currentYear = new Date().getUTCFullYear();
  const seasons = [`${currentYear}-${currentYear + 1}`, currentYear, `${currentYear - 1}-${currentYear}`, currentYear - 1];
  for (const season of [...new Set(seasons)]) {
    try {
      const url = new URL(`${BASE}/leagues/${encodeURIComponent(league.slug)}/results/`);
      url.searchParams.set("season", String(season));
      const raw = await fetchJson(url);
      const matches = unwrapList(raw).map(m => normalizeResult(m, league.name)).filter(Boolean);
      if (matches.length) {
        matches.sort((a,b) => String(a.date).localeCompare(String(b.date)));
        await writeCache(path, { matches: matches.slice(-800), fetchedAt: Date.now(), season });
        return matches.slice(-800);
      }
    } catch (e) { console.warn("[history-results]", league.slug, season, e.message); }
  }
  return [];
}

function summarizeTeam(team, results, venue, limit = 8) {
  const key = norm(team);
  const matches = results.filter(m => {
    const isHome = norm(m.home) === key, isAway = norm(m.away) === key;
    return (isHome || isAway) && (!venue || (venue === "home" ? isHome : isAway));
  }).slice(-limit);
  if (!matches.length) return null;
  let gf = 0, ga = 0, wins = 0, draws = 0, losses = 0, points = 0;
  const form = [];
  for (const m of matches) {
    const isHome = norm(m.home) === key;
    const scored = isHome ? m.homeGoals : m.awayGoals;
    const conceded = isHome ? m.awayGoals : m.homeGoals;
    gf += scored; ga += conceded;
    const outcome = scored > conceded ? "W" : scored === conceded ? "D" : "L";
    form.push(outcome);
    if (outcome === "W") { wins++; points += 3; } else if (outcome === "D") { draws++; points++; } else losses++;
  }
  return {
    team, venue: venue || "all", played: matches.length, wins, draws, losses,
    goalsFor: Number((gf / matches.length).toFixed(2)),
    goalsAgainst: Number((ga / matches.length).toFixed(2)),
    pointsPerGame: Number((points / matches.length).toFixed(2)),
    form: form.join(""), latestDate: matches[matches.length - 1].date
  };
}

function poisson(lambda, k) {
  let fact = 1; for (let i = 2; i <= k; i++) fact *= i;
  return Math.exp(-lambda) * Math.pow(lambda, k) / fact;
}
function formModel(home, away, leagueResults) {
  const homeForm = summarizeTeam(home, leagueResults, null, 8);
  const awayForm = summarizeTeam(away, leagueResults, null, 8);
  const homeVenue = summarizeTeam(home, leagueResults, "home", 6);
  const awayVenue = summarizeTeam(away, leagueResults, "away", 6);
  if (!homeForm || !awayForm || homeForm.played < 3 || awayForm.played < 3) return null;
  const avgGoals = leagueResults.length ? leagueResults.reduce((s,m)=>s+m.homeGoals+m.awayGoals,0)/(2*leagueResults.length) : 1.35;
  const hAttack = 0.65 * homeForm.goalsFor + 0.35 * (homeVenue?.goalsFor ?? homeForm.goalsFor);
  const hDef = 0.65 * homeForm.goalsAgainst + 0.35 * (homeVenue?.goalsAgainst ?? homeForm.goalsAgainst);
  const aAttack = 0.65 * awayForm.goalsFor + 0.35 * (awayVenue?.goalsFor ?? awayForm.goalsFor);
  const aDef = 0.65 * awayForm.goalsAgainst + 0.35 * (awayVenue?.goalsAgainst ?? awayForm.goalsAgainst);
  const homeAdvantage = 1.08;
  const expHome = Math.max(0.15, Math.min(3.8, ((hAttack / avgGoals) * (aDef / avgGoals) * avgGoals) * homeAdvantage));
  const expAway = Math.max(0.15, Math.min(3.8, ((aAttack / avgGoals) * (hDef / avgGoals) * avgGoals) / homeAdvantage));
  let h = 0, d = 0, a = 0;
  for (let i=0;i<=8;i++) for(let j=0;j<=8;j++) {
    const p=poisson(expHome,i)*poisson(expAway,j);
    if(i>j) h+=p; else if(i===j) d+=p; else a+=p;
  }
  const total=h+d+a || 1;
  return {
    home: Number((h/total*100).toFixed(1)), draw: Number((d/total*100).toFixed(1)), away: Number((a/total*100).toFixed(1)),
    expectedGoalsHome: Number(expHome.toFixed(2)), expectedGoalsAway: Number(expAway.toFixed(2)),
    homeForm, awayForm, homeVenue, awayVenue,
    dataQuality: Math.min(1, Math.min(homeForm.played, awayForm.played) / 8),
    dataSource: "Football Charts historical results"
  };
}

export async function getTeamFormAnalysis(fixture) {
  const index = await getLeagueIndex();
  if (!index.length) return null;
  const best = index.map(l => ({ ...l, score: leagueScore(fixture.league, l.name) }))
    .sort((a,b)=>b.score-a.score)[0];
  if (!best || best.score < 0.45) return null;
  const results = await getLeagueResults(best);
  if (!results.length) return null;
  const home = summarizeTeam(fixture.homeTeam, results, null, 8);
  const away = summarizeTeam(fixture.awayTeam, results, null, 8);
  if (!home || !away) return null;
  const model = formModel(fixture.homeTeam, fixture.awayTeam, results);
  if (!model) return null;
  return { ...model, leagueMatched: best.name, leagueMatchScore: best.score, resultsCount: results.length, source: "Football Charts" };
}

export function blendFormAndMarket(form, marketCandidates) {
  if (!form) return marketCandidates.map(p => ({...p, formDataAvailable:false, analysisSource:"market-only"}));
  const keys = { home: form.home, draw: form.draw, away: form.away };
  return marketCandidates.map(p => {
    const selection = String(p.selection || "").toLowerCase();
    const isHome = selection === String(p.homeTeam || "").toLowerCase() || selection === "1" || selection === "home";
    const isDraw = selection === "draw" || selection === "x";
    const isAway = selection === String(p.awayTeam || "").toLowerCase() || selection === "2" || selection === "away";
    const fp = isHome ? keys.home : isDraw ? keys.draw : isAway ? keys.away : null;
    if (fp === null) return {...p, formDataAvailable:false, analysisSource:"market-only"};
    const probability = 0.65 * fp + 0.35 * p.modelProbability;
    return {
      ...p, modelProbability: Number(probability.toFixed(1)), formProbability: fp,
      marketProbability: p.modelProbability, formDataAvailable:true,
      formSummary: { home: form.homeForm, away: form.awayForm, homeVenue: form.homeVenue, awayVenue: form.awayVenue },
      expectedGoals: { home: form.expectedGoalsHome, away: form.expectedGoalsAway },
      dataQuality: form.dataQuality, analysisSource: "form+market"
    };
  });
}
