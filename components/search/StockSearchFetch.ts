// Browser client for GET /api/search/stocks. Results stay in memory for the page view, so
// deleting back to an earlier query shows its results again without another request.

import { SEARCH_QUERY_PARAM, validateSearchQuery } from "@/lib/search/api";
import type { SearchErrorResponse, StockSearchResponse, StockSearchResult } from "@/lib/search/types";

const SEARCH_URL = "/api/search/stocks";
const MAX_CACHED_QUERIES = 100;

const cache = new Map<string, StockSearchResult[]>();

export function cachedStockResults(query: string): StockSearchResult[] | undefined {
  return cache.get(query);
}

/**
 * For text submitted without picking a result: the best match, if the field loaded results
 * for the text and none of them has it as its ticker. Such text is most likely a name:
 * "nvidia" passes validateStockTicker, but analyzing it would only spend Twelve Data credits
 * on an error. Null when the text is a listed ticker or no results for it have loaded; sends
 * no request.
 */
export function unlistedTickerMatch(text: string): StockSearchResult | null {
  const query = validateSearchQuery(text);
  const results = query.ok ? cache.get(query.value) : undefined;
  if (!query.ok || !results?.length) return null;
  const ticker = query.value.toUpperCase();
  return results.some((r) => r.symbol === ticker) ? null : results[0];
}

function remember(query: string, results: StockSearchResult[]) {
  cache.delete(query); // Re-insert so the oldest query is evicted first.
  cache.set(query, results);
  if (cache.size > MAX_CACHED_QUERIES) cache.delete(cache.keys().next().value!);
}

export type StockSearchOutcome =
  | { ok: true; query: string; results: StockSearchResult[] }
  | { ok: false; query: string; message: string };

const UNAVAILABLE = "Stock search isn't available right now. You can still enter a ticker.";
const OFFLINE = "Couldn't reach stock search. Check your connection, or enter a ticker.";

/**
 * Searches for `query`, which must already be normalized with validateSearchQuery. Resolves to
 * null if `signal` aborts the request (a newer query replaced it); never rejects.
 */
export async function fetchStockResults(query: string, signal?: AbortSignal): Promise<StockSearchOutcome | null> {
  try {
    const res = await fetch(`${SEARCH_URL}?${new URLSearchParams({ [SEARCH_QUERY_PARAM]: query })}`, { signal });
    const body = (await res.json().catch(() => null)) as Partial<StockSearchResponse & SearchErrorResponse> | null;
    if (signal?.aborted) return null;
    if (res.ok && Array.isArray(body?.results)) {
      remember(query, body.results);
      return { ok: true, query, results: body.results };
    }
    return { ok: false, query, message: body?.error?.message ?? UNAVAILABLE };
  } catch {
    return signal?.aborted ? null : { ok: false, query, message: OFFLINE };
  }
}
