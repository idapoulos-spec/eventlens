import "server-only";

import { fail, ok, type Result } from "@/lib/result";
import { benchmarkExpiry, benchmarkPoints } from "./benchmark-series";
import { memoryCache } from "./memory-cache";
import { DAILY_BARS, describeError, getApiKey, getTimeSeries, HALF_HOURLY_BARS } from "./twelve-data";
import type { BenchmarkSeries } from "./types";

// Benchmarks are kept in this server instance's memory with when they were fetched, which
// decides which bars are final. The same benchmark serves many stocks (SPY is the default
// for every analysis), so each is kept until its next bar settles: 2 credits per symbol at
// most every 30 minutes.
const cache = memoryCache<BenchmarkSeries>(20);

async function download(symbol: string): Promise<Result<BenchmarkSeries>> {
  const apiKey = getApiKey();
  if (!apiKey) {
    return fail("missing_key", "Benchmark prices aren't available because this site hasn't been set up with a market-data API key.");
  }
  const fetchedAt = Date.now();
  try {
    // No quote: the bars are all research needs, and settled bars are final.
    const [halfHourly, daily] = await Promise.all([
      getTimeSeries(symbol, "30min", HALF_HOURLY_BARS, apiKey),
      getTimeSeries(symbol, "1day", DAILY_BARS, apiKey),
    ]);
    return ok(benchmarkPoints(symbol, halfHourly.bars, daily.bars, fetchedAt));
  } catch (err) {
    return describeError(err, symbol, apiKey);
  }
}

/**
 * A benchmark's closes at research's observation times (see benchmarkPoints): from memory
 * while complete, otherwise 2 Twelve Data credits, shared by every request waiting for the
 * same symbol. Failures aren't cached, so the next analysis tries again.
 */
export function getBenchmarkSeries(symbol: string): Promise<Result<BenchmarkSeries>> {
  return cache(symbol, () => download(symbol), (series) => benchmarkExpiry(series.fetchedAt));
}
