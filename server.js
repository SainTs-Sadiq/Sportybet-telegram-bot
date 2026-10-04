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

async function sendText(chatId, text) {
  return telegram("sendMessage", { chat_id: chatId, text });
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

async function handleSetup(req, res) {
  if (req.method !== "GET") return reply(res, 405, { error: "GET only" });
  if (!TOKEN) return reply(res, 500, { error: "TELEGRAM_BOT_TOKEN is missing in Vercel environment variables" });
  const host = req.headers.host;
  const webhook = `https://${host}/telegram/webhook`;
  const body = { url: webhook };
  if (SECRET) body.secret_token = SECRET;
  const r = await telegram("setWebhook", body);
  const data = await r.json();
  return reply(res, r.ok && data.ok ? 200 : 500, { webhook, telegram: data });
}

async function handleWebhook(req, res) {
  if (req.method !== "POST") return reply(res, 200, { ok: true });
  if (SECRET && req.headers["x-telegram-bot-api-secret-token"] !== SECRET) return reply(res, 401, { error: "Unauthorized" });

  const update = await readJson(req);
  const msg = update?.message;
  if (!msg?.chat?.id) return reply(res, 200, { ok: true });
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim().toLowerCase();

  try {
    if (text === "/start" || text === "/help") {
      await sendText(chatId, "⚽ SportyBet Markets Bot\n\n/today — today's games\n/tomorrow — tomorrow's games\n/pdf — today's PDF\n/pdf_tomorrow — tomorrow's PDF\n/excel — today's spreadsheet\n/excel_tomorrow — tomorrow's spreadsheet\n\nThe bot retrieves SportyBet data and does not place wagers.");
      return reply(res, 200, { ok: true });
    }

    const valid = ["/today", "/tomorrow", "/pdf", "/pdf_tomorrow", "/excel", "/excel_tomorrow"];
    if (!valid.includes(text)) {
      await sendText(chatId, "Use /today, /tomorrow, /pdf, or /excel. Send /help for all commands.");
      return reply(res, 200, { ok: true });
    }

    const offset = text.includes("tomorrow") ? 1 : 0;
    const isPdf = text.startsWith("/pdf");
    await sendText(chatId, `⏳ Fetching SportyBet fixtures and markets for ${offset ? "tomorrow" : "today"}...`);
    const raw = await getFixtures({ hours: offset ? 72 : 48 });
    const fixtures = filterByDay(raw, offset, TZ);

    if (text === "/today" || text === "/tomorrow") {
      await sendText(chatId, `⚽ ${offset ? "Tomorrow" : "Today"}\n\nGames: ${fixtures.length}\nMarket groups: ${fixtures.reduce((n, f) => n + f.markets.length, 0)}\n\nUse /pdf or /excel to download the full report.`);
    } else if (isPdf) {
      const buffer = await makePdf(fixtures, TZ, `SportyBet Football Markets — ${offset ? "Tomorrow" : "Today"}`);
      await sendDocument(chatId, buffer, `sportybet-${offset ? "tomorrow" : "today"}.pdf`, `📄 SportyBet report • ${fixtures.length} games`);
    } else {
      const buffer = makeXlsx(fixtures, TZ);
      await sendDocument(chatId, buffer, `sportybet-${offset ? "tomorrow" : "today"}.xlsx`, `📊 SportyBet spreadsheet • ${fixtures.length} games`);
    }
    return reply(res, 200, { ok: true });
  } catch (error) {
    console.error(error);
    try { await sendText(chatId, `❌ Error: ${error?.message || "Unable to retrieve SportyBet data."}`); } catch {}
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
