const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";

const EXTRACTION_PROMPT = `Read the attached betting tips document/image and extract ONLY the selections explicitly shown.
Return valid JSON only, with this shape:
{"selections":[{"sport":"football|basketball|tennis|other","homeTeam":"exact team/player 1 name","awayTeam":"exact team/player 2 name","match":"displayed fixture text","market":"market name exactly or as close as shown","selection":"chosen outcome exactly as shown","date":"date if visible, otherwise null","odds":number or null,"notes":"short ambiguity note or empty string"}],"documentNotes":"brief note"}
Rules:
- Do not invent missing selections or infer a tip from odds alone.
- For tennis, homeTeam/awayTeam mean the two player names.
- Preserve the intended market and line/specifier (e.g. Over 2.5, Asian Handicap -1.0, 1st Half).
- If a row is unclear, include it with a note; do not silently guess.
- Ignore commentary, suggested stakes, and accumulator total odds.
- Return an empty selections array if no actual picks are present.`;

export async function extractSelectionsFromDocument(buffer, mimeType) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("Document extraction needs GEMINI_API_KEY. Add it in Vercel Environment Variables, then redeploy.");
  }
  const allowed = new Set(["image/jpeg","image/png","image/webp","application/pdf"]);
  if (!allowed.has(mimeType)) throw new Error("Please upload a JPG, PNG, WEBP image or PDF.");
  if (!buffer?.length) throw new Error("The uploaded file was empty.");
  if (buffer.length > 18 * 1024 * 1024) throw new Error("File is too large. Please upload a file under 18 MB.");
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [
        { text: EXTRACTION_PROMPT },
        { inline_data: { mime_type: mimeType, data: buffer.toString("base64") } }
      ]}],
      generationConfig: { responseMimeType: "application/json", temperature: 0.1 }
    }),
    signal: AbortSignal.timeout(55000)
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Document extraction failed (${response.status}): ${detail.slice(0,220)}`);
  }
  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw new Error("AI could not read the file as a structured list. Try a clearer image or PDF."); }
  const selections = Array.isArray(parsed.selections) ? parsed.selections : [];
  return {
    documentNotes: String(parsed.documentNotes || ""),
    selections: selections.slice(0, 100).map((p, i) => ({
      index: i + 1,
      sport: String(p.sport || "football").toLowerCase(),
      homeTeam: String(p.homeTeam || "").trim(),
      awayTeam: String(p.awayTeam || "").trim(),
      match: String(p.match || "").trim(),
      market: String(p.market || "").trim(),
      selection: String(p.selection || "").trim(),
      date: p.date ? String(p.date) : null,
      odds: Number.isFinite(Number(p.odds)) ? Number(p.odds) : null,
      notes: String(p.notes || "").trim()
    })).filter(p => p.match || (p.homeTeam && p.awayTeam) || p.selection)
  };
}
