import { after, type NextRequest } from "next/server";
import { rejectUnlessSignedIn } from "@/lib/auth/session";
import { clientIp } from "@/lib/client-ip";
import { FAILED_BUILD_BACKOFF_SEC, pendingKalshiIndexRefresh, searchKalshiMarkets } from "@/lib/kalshi/search";
import { createRateLimiter } from "@/lib/rate-limit";
import { SEARCH_QUERY_PARAM, searchError, validateSearchQuery } from "@/lib/search/api";
import type { KalshiSearchResponse } from "@/lib/search/types";

// The first search on a server waits while the market index is built, one page of Kalshi
// events after another (about 15 seconds in September 2026); later searches answer from memory.
export const maxDuration = 60;

// Typeahead sends a request each time the user pauses typing, so this is looser than the
// analysis limit. Per IP and per server instance, like every limit in this app.
const limiter = createRateLimiter([
  { windowMs: 60 * 1000, max: 30 },
  { windowMs: 60 * 60 * 1000, max: 300 },
]);

/** Upstream failures are the server's (5xx), not the client's; anything unexpected is a 502. */
const UPSTREAM_STATUS: Record<string, number> = { upstream_rate_limited: 503, upstream_timeout: 504 };

/** GET /api/search/kalshi?q=… → KalshiSearchResponse: open markets matching the query, best first. */
export async function GET(request: NextRequest) {
  // Before anything else, so a visitor who isn't signed in learns nothing, not even whether the input is valid.
  const denied = await rejectUnlessSignedIn(request.cookies);
  if (denied) return denied;

  const query = validateSearchQuery(request.nextUrl.searchParams.get(SEARCH_QUERY_PARAM));
  if (!query.ok) return searchError(400, "invalid_query", query.message);

  // Only valid queries can reach an upstream API, so only they count against the limit.
  const limit = limiter(clientIp(request.headers));
  if (!limit.ok) {
    return searchError(429, "rate_limited", "Too many searches. Please wait a moment and try again.", {
      "Retry-After": String(limit.retryAfterSec),
    });
  }

  const found = await searchKalshiMarkets(query.value);
  // A search may have started refreshing a stale index while it answered from the old one.
  // Keep the function running until the refresh finishes, or serverless hosts may freeze it.
  after(() => pendingKalshiIndexRefresh());

  if (!found.ok) {
    const { code, message } = found.error;
    const retry = code === "upstream_rate_limited" ? { "Retry-After": String(FAILED_BUILD_BACKOFF_SEC) } : undefined;
    return searchError(UPSTREAM_STATUS[code] ?? 502, code, message, retry);
  }
  const body: KalshiSearchResponse = { query: query.value, results: found.data };
  return Response.json(body);
}
