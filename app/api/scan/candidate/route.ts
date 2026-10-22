import type { NextRequest } from "next/server";
import { rejectUnlessSignedIn } from "@/lib/auth/session";
import { clientIp } from "@/lib/client-ip";
import { createRateLimiter } from "@/lib/rate-limit";
import { scanError, upstreamError } from "@/lib/scan/api";
import { loadCandidateKalshi } from "@/lib/scan/load";
import { validateKalshiTicker } from "@/lib/validation";

// As a page's Kalshi side: the lookup, then the stored history and a live tail, or the archive;
// the longer history gives up after 15 s.
export const maxDuration = 40;

// Kalshi requests only (no Twelve Data credits). A scan of 200 candidates, with a retry or two,
// stays inside this; the page loads 3 at a time, so Kalshi sees a few requests a second.
const limiter = createRateLimiter([
  { windowMs: 10 * 60 * 1000, max: 400 },
  { windowMs: 60 * 60 * 1000, max: 1_200 },
]);

/**
 * GET /api/scan/candidate?ticker=…&kind=event|market&long=0|1 → ScanKalshi: one candidate's
 * Kalshi side, as its own page reads it; with long=1 also its history for 180D, 1Y, and All.
 */
export async function GET(request: NextRequest) {
  const denied = await rejectUnlessSignedIn(request.cookies);
  if (denied) return denied;

  const params = request.nextUrl.searchParams;
  const ticker = validateKalshiTicker(params.get("ticker"));
  if (!ticker.ok) return scanError(400, "invalid_ticker", ticker.message);
  const kind = params.get("kind");
  if (kind !== "event" && kind !== "market") return scanError(400, "invalid_kind", "A candidate is an event or a market.");

  const limit = limiter(clientIp(request.headers));
  if (!limit.ok) return scanError(429, "rate_limited", "Too many candidates loaded. Please wait a moment and try again.", { "Retry-After": String(limit.retryAfterSec) });

  const kalshi = await loadCandidateKalshi(ticker.value, kind, params.get("long") === "1");
  if (!kalshi.ok) return upstreamError(kalshi.error);
  return Response.json(kalshi.data);
}
