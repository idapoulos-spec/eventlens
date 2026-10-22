import type { NextRequest } from "next/server";
import { checkAnalysisRateLimit, ANALYSIS_LIMIT_SUMMARY } from "@/lib/analysis-rate-limit";
import { rejectUnlessSignedIn } from "@/lib/auth/session";
import { DEFAULT_BENCHMARK } from "@/lib/market-data/benchmark-series";
import { parseSpan, scanError, upstreamError } from "@/lib/scan/api";
import { getScanPrices } from "@/lib/scan/prices";
import { validateStockTicker } from "@/lib/validation";

// The stock's requests, then the benchmark's (as on the pages): each up to 6 s, a few at once.
export const maxDuration = 40;

/**
 * GET /api/scan/prices?stock=TLT&from=…&to=…&live=0|1 → ScanPrices: the stock's bars and the
 * default benchmark's closes over the scan's span, once per scan. It spends Twelve Data credits
 * (see lib/scan/span.ts priceCredits), so it counts as an analysis against the visitor's limit.
 */
export async function GET(request: NextRequest) {
  const denied = await rejectUnlessSignedIn(request.cookies);
  if (denied) return denied;

  const stock = validateStockTicker(request.nextUrl.searchParams.get("stock"));
  if (!stock.ok) return scanError(400, "invalid_symbol", stock.message);
  if (stock.value === DEFAULT_BENCHMARK.symbol) {
    return scanError(400, "is_benchmark", `${DEFAULT_BENCHMARK.symbol} is the benchmark, so its market-adjusted returns are always zero. Pick another stock.`);
  }
  const span = parseSpan(request.nextUrl.searchParams, Date.now());
  if (!span.ok) return scanError(400, "invalid_span", span.message);

  const limit = await checkAnalysisRateLimit();
  if (!limit.ok) {
    return scanError(429, "rate_limited", `To protect the shared market-data quota, each visitor can run ${ANALYSIS_LIMIT_SUMMARY}, and a scan counts as one.`, {
      "Retry-After": String(limit.retryAfterSec),
    });
  }

  const prices = await getScanPrices(stock.value, span.value);
  if (!prices.ok) return upstreamError(prices.error);
  return Response.json(prices.data);
}
