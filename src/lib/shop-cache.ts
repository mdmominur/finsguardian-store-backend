type CacheEntry<T = unknown> = {
  value: T;
  expiresAt: number;
};

const store = new Map<string, Map<string, CacheEntry>>();
const inFlight = new Map<string, Promise<unknown>>();

const MAX_KEYS_PER_SHOP = 200;

/**
 * Read from per-shop in-memory TTL cache or compute & store.
 * Also deduplicates concurrent identical requests in-flight.
 */
export async function getOrComputeShopCache<T>(
  shopId: string,
  key: string,
  ttlMs: number,
  compute: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  const shopMap = store.get(shopId);
  if (shopMap) {
    const hit = shopMap.get(key);
    if (hit && hit.expiresAt > now) {
      return hit.value as T;
    }
    if (hit) {
      shopMap.delete(key);
    }
  }

  const flightKey = `${shopId}::${key}`;
  const existingFlight = inFlight.get(flightKey);
  if (existingFlight) {
    return existingFlight as Promise<T>;
  }

  const promise = (async () => {
    try {
      const val = await compute();
      let map = store.get(shopId);
      if (!map) {
        map = new Map();
        store.set(shopId, map);
      }
      if (map.size >= MAX_KEYS_PER_SHOP) {
        const oldestKey = map.keys().next().value;
        if (oldestKey !== undefined) map.delete(oldestKey);
      }
      map.set(key, {
        value: val,
        expiresAt: Date.now() + ttlMs,
      });
      return val;
    } finally {
      inFlight.delete(flightKey);
    }
  })();

  inFlight.set(flightKey, promise);
  return promise;
}

/**
 * Invalidate cached entries for a shop (all keys, or keys matching a prefix).
 */
export function invalidateShopCache(shopId: string, prefix?: string): void {
  const map = store.get(shopId);
  if (!map) return;
  if (!prefix) {
    store.delete(shopId);
    return;
  }
  for (const k of map.keys()) {
    if (k.startsWith(prefix)) {
      map.delete(k);
    }
  }
}
