import OpenAI from "openai";

const MODEL = process.env.OPENAI_MODEL || "gpt-5";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

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
  const payload = candidates.map((c, i) => ({ id: i + 1, ...c }));
  const prompt = `You are a football pre-match analysis assistant. Rank only the supplied candidate markets. Do not invent statistics, fixtures, odds, injuries, or markets. Prefer stronger supplied model probability, positive estimated value, and data quality. Diversify across matches when practical. Never describe a selection as guaranteed. Select up to ${targetCount} strongest candidates. Return JSON only in this shape: {"picks":[{"id":1,"rank":1,"confidence":"Low|Medium|High","rationale":"one concise sentence based only on supplied data","risk":"Low|Medium|High"}]}. Candidate data:\n${JSON.stringify(payload)}`;

  let parsed;
  if (process.env.GEMINI_API_KEY) {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.2 }
      })
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Gemini API request failed (${response.status}): ${detail.slice(0, 300)}`);
    }
    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
    parsed = JSON.parse(text);
  } else if (process.env.OPENAI_API_KEY) {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const response = await client.responses.create({
      model: MODEL,
      instructions: "Rank only the supplied candidate markets. Never invent facts or describe picks as guaranteed. Return JSON only.",
      input: prompt,
      text: { format: { type: "json_schema", name: "ranked_picks", strict: true, schema: {
        type: "object", additionalProperties: false, required: ["picks"], properties: {
          picks: { type: "array", items: { type: "object", additionalProperties: false, required: ["id","rank","confidence","rationale","risk"], properties: {
            id: { type: "integer" }, rank: { type: "integer" }, confidence: { type: "string", enum: ["Low","Medium","High"] }, rationale: { type: "string" }, risk: { type: "string", enum: ["Low","Medium","High"] }
          } } }
        }
      } } }
    });
    parsed = JSON.parse(response.output_text || "{\"picks\":[]}");
  } else {
    throw new Error("Configure GEMINI_API_KEY in Vercel to use Gemini free tier, or set OPENAI_API_KEY.");
  }
  return (Array.isArray(parsed.picks) ? parsed.picks : [])
    .map(p => ({ ...p, ...payload.find(x => x.id === Number(p.id)) }))
    .filter(x => x.match)
    .slice(0, targetCount);
}

export function combinedOdds(picks) { return picks.reduce((n, p) => n * Number(p.odds || 1), 1); }
