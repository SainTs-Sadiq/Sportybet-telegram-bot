import OpenAI from "openai";

const MODEL = process.env.OPENAI_MODEL || "gpt-5";

function valueScore(prob, odds) {
  if (!prob || !odds || odds <= 1) return null;
  return prob * odds - 1;
}

export function marketCandidates(fixture, prediction) {
  const out = [];
  const markets = fixture.markets || [];
  const home = fixture.homeTeam, away = fixture.awayTeam;
  const add = (marketNames, selection, prob, reason) => {
    if (!prob) return;
    for (const m of markets) {
      if (!marketNames.some(x => m.name.toLowerCase().includes(x))) continue;
      for (const o of m.outcomes || []) {
        if (o.name.toLowerCase() !== selection.toLowerCase()) continue;
        const edge = valueScore(prob / 100, o.odds);
        out.push({ match: `${home} vs ${away}`, market: m.name, selection: o.name, odds: o.odds, modelProbability: prob, edge, reason });
      }
    }
  };
  add(["1x2"], home, prediction.homeWinPct, `API-Football model home-win probability ${prediction.homeWinPct}%`);
  add(["1x2"], away, prediction.awayWinPct, `API-Football model away-win probability ${prediction.awayWinPct}%`);
  if (prediction.drawPct) add(["1x2"], "Draw", prediction.drawPct, `API-Football model draw probability ${prediction.drawPct}%`);
  return out;
}

export async function rankWithAI(candidates, targetCount = 10) {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured in Vercel.");
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const payload = candidates.map((c, i) => ({ id: i + 1, ...c }));
  const response = await client.responses.create({
    model: MODEL,
    instructions: `You are a football pre-match analysis assistant. Rank only the supplied candidate markets. Do not invent statistics, fixtures, odds, injuries, or markets. Prefer positive estimated value, stronger model probability, and data quality. Diversify across matches when practical. Never describe a selection as guaranteed. Return JSON only.`,
    input: `Select up to ${targetCount} strongest candidates from this data. Return an array of objects with id, rank, confidence (Low/Medium/High), rationale (one concise sentence), and risk (Low/Medium/High).\n\n${JSON.stringify(payload)}`,
    text: { format: { type: "json_schema", name: "ranked_picks", strict: true, schema: {
      type: "object", additionalProperties: false, required: ["picks"], properties: {
        picks: { type: "array", items: { type: "object", additionalProperties: false, required: ["id","rank","confidence","rationale","risk"], properties: {
          id: { type: "integer" }, rank: { type: "integer" }, confidence: { type: "string", enum: ["Low","Medium","High"] }, rationale: { type: "string" }, risk: { type: "string", enum: ["Low","Medium","High"] }
        } } }
      }
    } } }
  });
  const parsed = JSON.parse(response.output_text || "{\"picks\":[]}");
  return parsed.picks.map(p => ({ ...p, ...payload.find(x => x.id === p.id) })).filter(x => x.match);
}

export function combinedOdds(picks) { return picks.reduce((n, p) => n * Number(p.odds || 1), 1); }
