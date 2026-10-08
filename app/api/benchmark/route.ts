import type { NextRequest } from "next/server";
import { rejectUnlessSignedIn } from "@/lib/auth/session";
import { clientIp } from "@/lib/client-ip";
import { BENCHMARK_END_PARAM, parseWindowEnd } from "@/lib/history/window";
import { BENCHMARK_SYMBOL_PARAM, getBenchmarkSeries, type BenchmarkErrorResponse, type BenchmarkSeries } from "@/lib/market-data";
import { createRateLimiter } from "@/lib/rate-limit";
import { validateStockTicker } from "@/lib/validation";

// A benchmark the server doesn't have in memory costs 2 Twelve Data credits, so this matches
// the analysis limit. Per IP and per server instance, so it doesn't protect the shared quota
// on its own; getBenchmarkSeries keeps each benchmark until its next bar settles.
const limiter = createRateLimiter([
  { windowMs: 60 * 1000, max: 5 },
  { windowMs: 60 * 60 * 1000, max: 30 },
]);

/** HTTP status for each getBenchmarkSeries error code; anything else is 502. */
const ERROR_STATUS: Record<string, number> = {
  missing_key: 503,
  rate_limited: 503,
  timeout: 504,
  not_found: 404,
  plan: 403,
};

function error(status: number, code: string, message: string, headers?: HeadersInit): Response {
  const body: BenchmarkErrorResponse = { error: { code, message } };
  return Response.json(body, { status, headers });
}

/**
 * GET /api/benchmark?symbol=… → BenchmarkSeries: a benchmark for the Research panel's market
 * adjustment. With &end=… (ms), its bars cover the research window ending then (a closed
 * market's close) instead of the latest ones.
 */
export async function GET(request: NextRequest) {
  // Before anything else, so a visitor who isn't signed in learns nothing, not even whether the input is valid.
  const denied = await rejectUnlessSignedIn(request.cookies);
  if (denied) return denied;

  const symbol = validateStockTicker(request.nextUrl.searchParams.get(BENCHMARK_SYMBOL_PARAM));
  if (!symbol.ok) return error(400, "invalid_symbol", symbol.message);
  const end = parseWindowEnd(request.nextUrl.searchParams.get(BENCHMARK_END_PARAM), Date.now());
  if (!end.ok) return error(400, end.error.code, end.error.message);

  // Only valid symbols can reach Twelve Data, so only they count against the limit.
  const limit = limiter(clientIp(request.headers));
  if (!limit.ok) {
    return error(429, "rate_limited", "Too many benchmark changes. Please wait a moment and try again.", {
      "Retry-After": String(limit.retryAfterSec),
    });
  }

  const series = await (end.data === null ? getBenchmarkSeries(symbol.value) : getBenchmarkSeries(symbol.value, { end: end.data }));
  if (!series.ok) return error(ERROR_STATUS[series.error.code] ?? 502, series.error.code, series.error.message);
  const body: BenchmarkSeries = series.data;
  return Response.json(body);
}
