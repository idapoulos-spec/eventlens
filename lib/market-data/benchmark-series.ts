// How research reads a benchmark (e.g. SPY): at the same moments it reads the stock. Pure, so
// the browser can use it too; benchmark.ts fetches and caches the bars.

import { topOfHourCloses } from "@/lib/analytics/research";
import type { DataError } from "@/lib/result";
import { sessionClosePoints, tradingDayClose } from "./session";
import type { BenchmarkSeries, StockBar } from "./types";

/** The benchmark research uses unless another is picked. */
export const DEFAULT_BENCHMARK = { symbol: "SPY", name: "SPDR S&P 500 ETF Trust" } as const;

/** GET /api/benchmark?symbol=QQQ returns a BenchmarkSeries, or a BenchmarkErrorResponse. */
export const BENCHMARK_API_PATH = "/api/benchmark";
export const BENCHMARK_SYMBOL_PARAM = "symbol";

/** Error response of /api/benchmark: 400 invalid_symbol, 429 rate_limited (with Retry-After), or the upstream failure. */
export interface BenchmarkErrorResponse {
  error: DataError;
}

/** A bar is final this long after its close, as for the stock (see topOfHourCloses). */
export const BENCHMARK_SETTLE_MS = 5 * 60 * 1000;

const HALF_HOUR_MS = 30 * 60 * 1000;

/**
 * A benchmark's research closes from its 30-minute and daily bars, stamped exactly like
 * the stock's: top-of-hour closes, and session closes (sessionClosePoints). Bars that
 * hadn't settled when they were fetched are left out. While a session is under way its
 * daily bar is too, even when the latest 30-minute bar has settled.
 */
export function benchmarkPoints(symbol: string, halfHourly: StockBar[], daily: StockBar[], fetchedAt: number): BenchmarkSeries {
  const cutoff = fetchedAt - BENCHMARK_SETTLE_MS;
  const closes = sessionClosePoints(daily, halfHourly);
  return {
    symbol,
    hourly: topOfHourCloses(
      halfHourly.map((b) => ({ t: b.t, value: b.close })),
      fetchedAt,
      BENCHMARK_SETTLE_MS,
    ),
    daily: closes.filter((p, i) => p.t <= cutoff && tradingDayClose(daily[i].t) <= cutoff),
    fetchedAt,
  };
}

/**
 * Until the next 30-minute bar after `fetchedAt` has settled, fetching again would return
 * the same settled bars, so a cached benchmark is complete until then (at most 30 minutes).
 */
export function benchmarkExpiry(fetchedAt: number): number {
  return (Math.floor((fetchedAt - BENCHMARK_SETTLE_MS) / HALF_HOUR_MS) + 1) * HALF_HOUR_MS + BENCHMARK_SETTLE_MS;
}
