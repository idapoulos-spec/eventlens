import type { NextRequest } from "next/server";
import { clientIp } from "@/lib/client-ip";
import { createRateLimiter } from "@/lib/rate-limit";
import { SEARCH_QUERY_PARAM, searchError, validateSearchQuery } from "@/lib/search/api";
import type { StockSearchResponse } from "@/lib/search/types";

// Typeahead sends a request each time the user pauses typing, so this is looser than the
// analysis limit. It is per IP and per server instance, so it does not protect the shared
// Twelve Data quota (8 requests a minute for the whole site): the search must not spend a
// Twelve Data request on every query.
const limiter = createRateLimiter([
  { windowMs: 60 * 1000, max: 30 },
  { windowMs: 60 * 60 * 1000, max: 300 },
]);

/** GET /api/search/stocks?q=… → StockSearchResponse. Stub: always returns no results. */
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

  const body: StockSearchResponse = { query: query.value, results: [] };
  return Response.json(body);
}
