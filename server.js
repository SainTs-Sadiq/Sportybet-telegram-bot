import { createServer } from "node:http";
import { getFixtures, filterByDay } from "./lib/sportybet.js";
import { makePdf, makeXlsx } from "./lib/reports.js";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SECRET = process.env.BOT_SECRET;
const TZ = process.env.REPORT_TIMEZONE || "Africa/Lagos";

async function telegram(method, body) {
  if (!TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is missing");
  return fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function sendText(chatId, text, extra = {}) {
  return telegram("sendMessage", { chat_id: chatId, text, ...extra });
}

async function answerCallback(id, text = "") {
  return telegram("answerCallbackQuery", { callback_query_id: id, text });
}

async function sendDocument(chatId, buffer, filename, caption) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("caption", caption);
  form.append("document", new Blob([buffer]), filename);
  return fetch(`https://api.telegram.org/bot${TOKEN}/sendDocument`, { method: "POST", body: form });
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function reply(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(body);
}

const MENU = {
  inline_keyboard: [
    [
      { text: "⚽ Today's Games", callback_data: "today" },
      { text: "📅 Tomorrow", callback_data: "tomorrow" }
    ],
    [
      { text: "📄 Today's PDF", callback_data: "pdf" },
      { text: "📄 Tomorrow PDF", callback_data: "pdf_tomorrow" }
    ],
    [
      { text: "📊 Today's Excel", callback_data: "excel" },
      { text: "📊 Tomorrow Excel", callback_data: "excel_tomorrow" }
    ],
    [
      { text: "🏆 Leagues", callback_data: "leagues" },
      { text: "📋 Markets", callback_data: "markets" }
    ],
    [
      { text: "🔎 Search", callback_data: "search_help" },
      { text: "🤖 AI Analysis", callback_data: "ai_help" }
    ],
    [{ text: "ℹ️ Help", callback_data: "help" }]
  ]
};

const HELP = `⚽ SportyBet Markets Bot\n\nUse the buttons below or these commands:\n\n/today — today's games\n/tomorrow — tomorrow's games\n/pdf — today's PDF\n/pdf_tomorrow — tomorrow's PDF\n/excel — today's spreadsheet\n/excel_tomorrow — tomorrow's spreadsheet\n/leagues — leagues in the current fixture list\n/markets — available market groups\n/search TEAM — find a team in tomorrow's fixtures\n\n🤖 AI analysis is being prepared separately and will use statistical data plus current SportyBet odds.\n\nThe bot retrieves SportyBet data and does not place wagers.`;

async function showMenu(chatId) {
  return sendText(chatId, "⚽ SportyBet Markets Bot\n\nChoose an option:", { reply_markup: MENU });
}

async function setBotCommands() {
  const commands = [
    { command: "start", description: "Open the main menu" },
    { command: "today", description: "Today's games" },
    { command: "tomorrow", description: "Tomorrow's games" },
    { command: "pdf", description: "Today's PDF" },
    { command: "pdf_tomorrow", description: "Tomorrow's PDF" },
    { command: "excel", description: "Today's spreadsheet" },
    { command: "excel_tomorrow", description: "Tomorrow's spreadsheet" },
    { command: "leagues", description: "List leagues" },
    { command: "markets", description: "List markets" },
    { command: "search", description: "Search a team" },
    { command: "help", description: "Help" }
  ];
  try { await telegram("setMyCommands", { commands }); } catch (e) { console.error(e); }
}

async function handleSetup(req, res) {
  if (req.method !== "GET") return reply(res, 405, { error: "GET only" });
  if (!TOKEN) return reply(res, 500, { error: "TELEGRAM_BOT_TOKEN is missing in Vercel environment variables" });
  const host = req.headers.host;
  const webhook = `https://${host}/telegram/webhook`;
  const body = { url: webhook };
  if (SECRET) body.secret_token = SECRET;
  const r = await telegram("setWebhook", body);
  const data = await r.json();
  await setBotCommands();
  return reply(res, r.ok && data.ok ? 200 : 500, { webhook, telegram: data, commands: true });
}

async function getDayFixtures(offset) {
  const raw = await getFixtures({ hours: offset ? 72 : 48 });
  return filterByDay(raw, offset, TZ);
}

function marketNames(fixtures) {
  const counts = new Map();
  for (const f of fixtures) for (const m of (f.markets || [])) {
    const name = m.name || m.marketName || m.market || "Other";
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function leagueNames(fixtures) {
  const counts = new Map();
  for (const f of fixtures) {
    const name = f.league || f.leagueName || f.competition || "Unknown league";
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function fixtureLabel(f) {
  return `${f.home || f.homeTeam || "Home"} vs ${f.away || f.awayTeam || "Away"}`;
}

async function runReport(chatId, text) {
  const offset = text.includes("tomorrow") ? 1 : 0;
  const isPdf = text.startsWith("/pdf");
  await sendText(chatId, `⏳ Fetching SportyBet fixtures and markets for ${offset ? "tomorrow" : "today"}...`);
  const fixtures = await getDayFixtures(offset);
  if (text === "/today" || text === "/tomorrow") {
    await sendText(chatId, `⚽ ${offset ? "Tomorrow" : "Today"}\n\nGames: ${fixtures.length}\nMarket groups: ${fixtures.reduce((n, f) => n + (f.markets || []).length, 0)}\n\nChoose a report below:`, { reply_markup: MENU });
  } else if (isPdf) {
    const buffer = await makePdf(fixtures, TZ, `SportyBet Football Markets — ${offset ? "Tomorrow" : "Today"}`);
    await sendDocument(chatId, buffer, `sportybet-${offset ? "tomorrow" : "today"}.pdf`, `📄 SportyBet report • ${fixtures.length} games`);
  } else {
    const buffer = makeXlsx(fixtures, TZ);
    await sendDocument(chatId, buffer, `sportybet-${offset ? "tomorrow" : "today"}.xlsx`, `📊 SportyBet spreadsheet • ${fixtures.length} games`);
  }
}

async function handleAction(chatId, action) {
  if (action === "help" || action === "search_help" || action === "ai_help") {
    const text = action === "search_help"
      ? "🔎 Search\n\nUse /search followed by a team name.\nExample: /search Arsenal\n\nThe search checks tomorrow's fixture list."
      : action === "ai_help"
        ? "🤖 AI Analysis\n\nThe AI analysis engine is being prepared. It will combine SportyBet odds with independent football statistics and rank selections by estimated probability and value. It is not enabled yet."
        : HELP;
    return sendText(chatId, text, { reply_markup: MENU });
  }
  if (action === "leagues" || action === "markets") {
    await sendText(chatId, `⏳ Loading ${action}...`);
    const fixtures = await getDayFixtures(1);
    const rows = action === "leagues" ? leagueNames(fixtures) : marketNames(fixtures);
    const title = action === "leagues" ? "🏆 Tomorrow's leagues" : "📋 Tomorrow's market groups";
    const body = rows.length ? rows.slice(0, 50).map(([n, c], i) => `${i + 1}. ${n} — ${c}`).join("\n") : "No data found.";
    return sendText(chatId, `${title}\n\n${body}`, { reply_markup: MENU });
  }
  return runReport(chatId, `/${action}`);
}

async function handleWebhook(req, res) {
  if (req.method !== "POST") return reply(res, 200, { ok: true });
  if (SECRET && req.headers["x-telegram-bot-api-secret-token"] !== SECRET) return reply(res, 401, { error: "Unauthorized" });

  const update = await readJson(req);
  const callback = update?.callback_query;
  const msg = update?.message;
  const chatId = callback?.message?.chat?.id || msg?.chat?.id;
  if (!chatId) return reply(res, 200, { ok: true });

  try {
    if (callback) {
      await answerCallback(callback.id);
      await handleAction(chatId, callback.data);
      return reply(res, 200, { ok: true });
    }

    const rawText = (msg.text || "").trim();
    const text = rawText.toLowerCase();

    if (text === "/start" || text === "/help") {
      await setBotCommands();
      await showMenu(chatId);
      return reply(res, 200, { ok: true });
    }

    if (text.startsWith("/search ")) {
      const query = rawText.slice(8).trim().toLowerCase();
      if (!query) { await sendText(chatId, "Use /search followed by a team name. Example: /search Arsenal", { reply_markup: MENU }); return reply(res, 200, { ok: true }); }
      await sendText(chatId, `🔎 Searching tomorrow's fixtures for “${rawText.slice(8).trim()}”...`);
      const fixtures = await getDayFixtures(1);
      const matches = fixtures.filter(f => fixtureLabel(f).toLowerCase().includes(query));
      const body = matches.length ? matches.slice(0, 30).map(f => `⚽ ${fixtureLabel(f)}`).join("\n") : "No matching fixtures found.";
      await sendText(chatId, `🔎 Search results\n\n${body}`, { reply_markup: MENU });
      return reply(res, 200, { ok: true });
    }

    const valid = ["/today", "/tomorrow", "/pdf", "/pdf_tomorrow", "/excel", "/excel_tomorrow", "/leagues", "/markets"];
    if (valid.includes(text)) {
      if (text === "/leagues" || text === "/markets") await handleAction(chatId, text.slice(1));
      else await runReport(chatId, text);
      return reply(res, 200, { ok: true });
    }

    await sendText(chatId, "I didn't recognize that command. Tap /start to open the menu.", { reply_markup: MENU });
    return reply(res, 200, { ok: true });
  } catch (error) {
    console.error(error);
    try { await sendText(chatId, `❌ Error: ${error?.message || "Unable to retrieve SportyBet data."}`, { reply_markup: MENU }); } catch {}
    return reply(res, 200, { ok: false });
  }
}

const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`).pathname;
    if (path === "/api/setup") return await handleSetup(req, res);
    if (path === "/telegram/webhook" || path === "/api/webhook") return await handleWebhook(req, res);
    if (path === "/health") return reply(res, 200, { ok: true, service: "sportybet-telegram-bot" });
    return reply(res, 200, { ok: true, service: "sportybet-telegram-bot", setup: "/api/setup" });
  } catch (error) {
    console.error(error);
    return reply(res, 500, { ok: false, error: error?.message || "Internal server error" });
  }
});

server.listen(Number(process.env.PORT || 3000));
