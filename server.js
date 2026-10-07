import { handler as webhookHandler } from "./api/webhook.js";
import setupHandler from "./api/setup.js";

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

function adaptResponse(res) {
  return {
    status(code) {
      res.statusCode = code;
      return this;
    },
    json(data) {
      if (!res.headersSent) res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(data));
      return this;
    },
    end(data) {
      res.end(data);
      return this;
    }
  };
}

async function runHandler(req, res, fn) {
  const body = req.method === "POST" ? await readBody(req) : undefined;
  const adaptedReq = {
    ...req,
    body,
    headers: req.headers,
    method: req.method
  };
  return fn(adaptedReq, adaptResponse(res));
}

export default async function app(req, res) {
  const path = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`).pathname;

  if (path === "/health") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ ok: true, service: "sportybet-telegram-bot" }));
  }

  if (path === "/api/setup") {
    return runHandler(req, res, setupHandler);
  }

  if (path === "/telegram/webhook" || path === "/api/webhook") {
    return runHandler(req, res, webhookHandler);
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  return res.end(JSON.stringify({
    ok: true,
    service: "sportybet-telegram-bot",
    setup: "/api/setup"
  }));
}
