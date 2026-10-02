import type { Result } from "@/lib/result";

/**
 * A cache in this server instance's memory for upstream data whose age matters. Next.js's
 * time-based data cache can't be used for that: it serves an entry however old it is while
 * it refreshes it in the background, and doesn't say when the entry was fetched.
 *
 * Each value is kept until `expiresAt(value)`. Concurrent requests for a key share one
 * load. Failures aren't kept, so the next request tries again. Beyond `maxEntries`, the
 * least recently loaded key is dropped.
 */
export function memoryCache<T>(maxEntries: number) {
  const entries = new Map<string, { value: T; expiresAt: number }>();
  const loading = new Map<string, Promise<Result<T>>>();

  return function get(key: string, load: () => Promise<Result<T>>, expiresAt: (value: T) => number): Promise<Result<T>> {
    const hit = entries.get(key);
    if (hit && Date.now() < hit.expiresAt) return Promise.resolve({ ok: true, data: hit.value });

    let pending = loading.get(key);
    if (!pending) {
      pending = (async () => {
        try {
          const result = await load();
          if (result.ok) {
            entries.delete(key); // Re-insert so the least recently loaded key is dropped first.
            entries.set(key, { value: result.data, expiresAt: expiresAt(result.data) });
            if (entries.size > maxEntries) entries.delete(entries.keys().next().value!);
          }
          return result;
        } finally {
          loading.delete(key);
        }
      })();
      loading.set(key, pending);
    }
    return pending;
  };
}
