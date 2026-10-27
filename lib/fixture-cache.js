// Short-TTL cache for SportyBet fixture feeds. prepareDocumentSlip loads up to
// 20 pages per sport; on Vercel a retry or a second pick in the same request
// must not refetch all of it (function timeout risk). 5 minutes keeps fixtures
// fresh enough for matching while cutting repeat load dramatically.
const cache = new Map();
const TTL_MS = 5 * 60 * 1000;

export function getFixturesCachedParamsKey(params) {
  return JSON.stringify(params || {});
}

export async function getFixturesCached(getFixtures, params = {}) {
  const key = getFixturesCachedParamsKey(params);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.fixtures;
  const fixtures = await getFixtures(params);
  cache.set(key, { at: Date.now(), fixtures });
  return fixtures;
}

export function clearFixtureCache() { cache.clear(); }
