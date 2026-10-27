// Two-layer cache for SportyBet fixture feeds: in-memory (per instance, 5 min)
// plus Upstash Redis (shared across serverless instances, 15 min). Cuts repeat
// page loads (20 pages x 100 fixtures) to zero on warm paths.
import { kvGet, kvSet } from "./store.js";

const cache = new Map();
const TTL_MS = 5 * 60 * 1000;
const REDIS_TTL_SECONDS = 15 * 60;

export async function getFixturesCached(getFixtures, params = {}) {
  const key = "sb:fixtures:" + JSON.stringify(params);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.fixtures;
  const redisHit = await kvGet(key);
  if (Array.isArray(redisHit) && redisHit.length) {
    cache.set(key, { at: Date.now(), fixtures: redisHit });
    return redisHit;
  }
  const fixtures = await getFixtures(params);
  cache.set(key, { at: Date.now(), fixtures });
  await kvSet(key, fixtures, REDIS_TTL_SECONDS);
  return fixtures;
}

export function clearFixtureCache() { cache.clear(); }
