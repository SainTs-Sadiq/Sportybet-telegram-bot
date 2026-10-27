// Tiny key-value store used to keep Telegram session state across serverless
// invocations. Vercel functions are cold-started on different instances, so
// plain in-memory Maps lose booking/document sessions between requests.
// When Upstash Redis REST credentials are configured, sessions are hydrated
// from Redis on request entry and written back on request exit. Without
// credentials the bot still works exactly as before (memory only).
const REST_URL = process.env.UPSTASH_REDIS_REST_URL || "";
const REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";

export const storeEnabled = Boolean(REST_URL && REST_TOKEN);

async function cmd(args) {
  try {
    const res = await fetch(REST_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${REST_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    return data?.result ?? null;
  } catch (e) {
    console.warn("[kv-store]", e?.message || String(e));
    return null;
  }
}

export async function kvGet(key) {
  if (!storeEnabled) return undefined;
  const raw = await cmd(["GET", key]);
  if (typeof raw !== "string") return undefined;
  try { return JSON.parse(raw); } catch { return undefined; }
}

export async function kvSet(key, value, ttlSeconds) {
  if (!storeEnabled) return;
  const args = ["SET", key, JSON.stringify(value)];
  if (Number.isFinite(ttlSeconds) && ttlSeconds > 0) args.push("EX", String(Math.floor(ttlSeconds)));
  await cmd(args);
}

export async function kvDel(key) {
  if (!storeEnabled) return;
  await cmd(["DEL", key]);
}
