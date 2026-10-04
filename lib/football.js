const BASE = "https://v3.football.api-sports.io";
const KEY = process.env.API_FOOTBALL_KEY;

async function api(path, params = {}) {
  if (!KEY) throw new Error("API_FOOTBALL_KEY is not configured in Vercel.");
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  const r = await fetch(url, { headers: { "x-apisports-key": KEY, Accept: "application/json" }, signal: AbortSignal.timeout(12000) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`API-Football HTTP ${r.status}`);
  if (data.errors && Object.keys(data.errors).length) throw new Error(`API-Football: ${Object.values(data.errors).join(", ")}`);
  return data.response || [];
}

function norm(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
function tokens(s) { return new Set(norm(s).split(" ").filter(x => x.length > 2)); }
function similarity(a, b) {
  const A = tokens(a), B = tokens(b); if (!A.size || !B.size) return 0;
  let hit = 0; for (const x of A) if (B.has(x)) hit++;
  return hit / Math.max(A.size, B.size);
}

export async function getDailyFixtures(date) {
  return api("/fixtures", { date, timezone: "Africa/Lagos" });
}

export function matchSportyFixture(sporty, candidates) {
  let best = null, score = 0;
  for (const f of candidates) {
    const home = f.teams?.home?.name || "", away = f.teams?.away?.name || "";
    const direct = (similarity(sporty.homeTeam, home) + similarity(sporty.awayTeam, away)) / 2;
    const swapped = (similarity(sporty.homeTeam, away) + similarity(sporty.awayTeam, home)) / 2;
    const s = Math.max(direct, swapped);
    if (s > score) { score = s; best = f; }
  }
  return score >= 0.55 ? { fixture: best, score } : null;
}

export async function getPredictions(fixtureId) {
  const rows = await api("/predictions", { fixture: fixtureId });
  const p = rows[0];
  if (!p) return null;
  return {
    fixtureId,
    winner: p.predictions?.winner?.name || null,
    winnerComment: p.predictions?.winner?.comment || null,
    winOrDraw: p.predictions?.win_or_draw ?? null,
    underOver: p.predictions?.under_over || null,
    advice: p.predictions?.advice || null,
    homeWinPct: Number(p.predictions?.percent?.home) || null,
    drawPct: Number(p.predictions?.percent?.draw) || null,
    awayWinPct: Number(p.predictions?.percent?.away) || null,
    goalsHome: p.predictions?.goals?.home ?? null,
    goalsAway: p.predictions?.goals?.away ?? null,
    comparison: p.comparison || null,
    h2h: p.h2h || []
  };
}

export function impliedProbability(odds) { return odds > 1 ? 1 / odds : null; }

export function buildCandidates(sportyFixtures, apiFixtures, maxGames = 25) {
  const out = [];
  for (const s of sportyFixtures) {
    const m = matchSportyFixture(s, apiFixtures);
    if (!m) continue;
    out.push({ sporty: s, api: m.fixture, matchScore: m.score });
    if (out.length >= maxGames) break;
  }
  return out;
}
