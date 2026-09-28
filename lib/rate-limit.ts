export interface RateLimitRule {
  windowMs: number;
  max: number;
}

export type RateLimitResult = { ok: true } | { ok: false; retryAfterSec: number };

/**
 * Minimal in-memory sliding-window rate limiter. A request is allowed only if it
 * fits every rule; rejected requests are not counted.
 *
 * State lives in this server process's memory, so it is not shared between
 * server instances and resets when an instance restarts. At most `maxKeys`
 * clients are tracked; beyond that the least recently allowed one is dropped.
 */
export function createRateLimiter(rules: RateLimitRule[], maxKeys = 10_000) {
  const longestWindowMs = Math.max(...rules.map((r) => r.windowMs));
  const hits = new Map<string, number[]>();

  return function check(key: string, now: number = Date.now()): RateLimitResult {
    const recent = (hits.get(key) ?? []).filter((t) => now - t < longestWindowMs);

    for (const { windowMs, max } of rules) {
      const inWindow = recent.filter((t) => now - t < windowMs);
      if (inWindow.length >= max) {
        hits.set(key, recent);
        // Sliding window: a slot frees up when the oldest request in it expires.
        return { ok: false, retryAfterSec: Math.ceil((inWindow[0] + windowMs - now) / 1000) };
      }
    }

    recent.push(now);
    hits.delete(key); // Re-insert so Map order tracks recency for eviction.
    hits.set(key, recent);
    if (hits.size > maxKeys) hits.delete(hits.keys().next().value!);
    return { ok: true };
  };
}
