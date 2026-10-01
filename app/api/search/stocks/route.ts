import type { NextRequest } from "next/server";
import { clientIp } from "@/lib/client-ip";
import { searchUsStocks } from "@/lib/market-data";
import { createRateLimiter } from "@/lib/rate-limit";
import { SEARCH_QUERY_PARAM, searchError, validateSearchQuery } from "@/lib/search/api";
import type { StockSearchResponse } from "@/lib/search/types";

// Typeahead sends a request each time the user pauses typing, so this is looser than the
// analysis limit. It is per IP and per server instance, so it does not protect the shared
// Twelve Data quota (8 requests a minute for the whole site); searchUsStocks does that by
// searching a copy of the symbol lists it downloads once a day.
const limiter = createRateLimiter([
  { windowMs: 60 * 1000, max: 30 },
  { windowMs: 60 * 60 * 1000, max: 300 },
]);

// The first search on a server instance each day waits for Twelve Data's symbol lists, which
// can take over 20 seconds (see SYMBOL_LIST_TIMEOUT_MS). Hosts use this as the route's time limit.
export const maxDuration = 60;

/** HTTP status for each searchUsStocks error code; anything else is 502. */
const ERROR_STATUS: Record<string, number> = {
  missing_key: 503,
  rate_limited: 503,
  timeout: 504,
};

/** GET /api/search/stocks?q=… → StockSearchResponse: US stocks and ETFs by ticker or name. */
export async function GET(request: NextRequest) {
  const query = validateSearchQuery(request.nextUrl.searchParams.get(SEARCH_QUERY_PARAM));
  if (!query.ok) return searchError(400, "invalid_query", query.message);

  // Only valid queries can reach an upstream API, so only they count against the limit.
  const limit = limiter(clientIp(request.headers));
  if (!limit.ok) {
    return searchError(429, "rate_limited", "Too many searches. Please wait a moment and try again.", {
      "Retry-After": String(limit.retryAfterSec),
    });
  }

  const results = await searchUsStocks(query.value);
  if (!results.ok) return searchError(ERROR_STATUS[results.error.code] ?? 502, results.error.code, results.error.message);

  const body: StockSearchResponse = { query: query.value, results: results.data };
  return Response.json(body);
}
