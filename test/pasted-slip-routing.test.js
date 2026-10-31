import test from "node:test";
import assert from "node:assert/strict";
import { hasPipeTableRows, parsePastedPicks, handleWebhook } from "../api/webhook.js";

test("numbered pipe-table slips are detected and parsed without a prior session", () => {
  const slip = ["1 | Betis vs Malaga | Betis Win | 1.35", "2 | Bayern vs Dortmund | Bayern Win | 1.36"].join("\n");
  assert.equal(hasPipeTableRows(slip), true);
  const picks = parsePastedPicks(slip);
  assert.equal(picks.length, 2);
  assert.deepEqual(picks.map(({ match, market, selection, odds }) => ({ match, market, selection, odds })), [
    { match: "Betis vs Malaga", market: "1X2", selection: "Betis", odds: 1.35 },
    { match: "Bayern vs Dortmund", market: "1X2", selection: "Bayern", odds: 1.36 }
  ]);
});

test("a pipe slip reaches live-feed matching without an existing session", async () => {
  const originalFetch = globalThis.fetch;
  const telegramMessages = [];
  let feedRequests = 0;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).includes("api.telegram.org")) {
      const body = JSON.parse(init.body || "{}");
      telegramMessages.push(body.text || "");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (String(url).includes("sportybet.com/api/")) {
      feedRequests++;
      return new Response(JSON.stringify({ bizCode: 10000, data: [] }), { status: 200 });
    }
    throw new Error(`unexpected outbound request: ${url}`);
  };
  const res = { body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; }, end() { return this; } };
  try {
    await handleWebhook({
      method: "POST",
      headers: {},
      body: { message: { chat: { id: 987655 }, text: "1 | Betis vs Malaga | Betis Win | 1.35\n2 | Bayern vs Dortmund | Bayern Win | 1.36" } }
    }, res);
  } finally { globalThis.fetch = originalFetch; }
  assert.equal(res.body?.ok, true);
  assert.ok(feedRequests > 0, "handler should request live fixture feeds");
  assert.ok(telegramMessages.some(text => text.includes("Matching the extracted picks against live SportyBet fixtures")));
  assert.ok(telegramMessages.some(text => text.includes("Slip incomplete: 0/2 legs matched")));
  assert.ok(telegramMessages.every(text => !text.includes("Unknown command. Send /start.")));
});


test("non-command chatter still receives the /start hint", async () => {
  const originalFetch = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, init) => {
    if (!String(url).includes("api.telegram.org")) throw new Error("unexpected outbound request");
    sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const res = { statusCode: 0, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; }, end() { return this; } };
  try {
    await handleWebhook({ method: "POST", headers: {}, body: { message: { chat: { id: 987654 }, text: "hey bot" } } }, res);
  } finally { globalThis.fetch = originalFetch; }
  assert.equal(res.body?.ok, true);
  assert.ok((sent.at(-1)?.text || "").includes("Unknown command. Send /start."));
});

