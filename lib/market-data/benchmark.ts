import "server-only";

import { LIVE } from "@/lib/fetch-cache";
import { fail, ok, type Result } from "@/lib/result";
import { benchmarkExpiry, benchmarkPoints } from "./benchmark-series";
import { DAILY_BARS, describeError, getApiKey, getTimeSeries, HALF_HOURLY_BARS } from "./twelve-data";
import type { BenchmarkSeries } from "./types";

// Benchmarks are kept in this server instance's memory rather than Next.js's data cache.
// Its time-based cache serves stale entries while it refreshes them, and can't say when an
// entry was fetched; the benchmark needs that time to leave out bars that were still forming.
// Benchmark requests are cheap to repeat for many stocks (SPY is the default for every
// analysis), so each is kept until its next bar settles: 2 credits per symbol at most every
// 30 minutes.
const MAX_CACHED = 20;
const cache = new Map<string, { series: BenchmarkSeries; expiresAt: number }>();
const loading = new Map<string, Promise<Result<BenchmarkSeries>>>();

async function download(symbol: string): Promise<Result<BenchmarkSeries>> {
  const apiKey = getApiKey();
  if (!apiKey) {
    return fail("missing_key", "Benchmark prices aren't available because this site hasn't been set up with a market-data API key.");
  }
  try {
    // No quote: the bars are all research needs, and settled bars are final.
    const [halfHourly, daily] = await Promise.all([
      getTimeSeries(symbol, "30min", HALF_HOURLY_BARS, apiKey, LIVE),
      getTimeSeries(symbol, "1day", DAILY_BARS, apiKey, LIVE),
    ]);
    return ok(benchmarkPoints(symbol, halfHourly.bars, daily.bars, Date.now()));
  } catch (err) {
    return describeError(err, symbol, apiKey);
  }
}

/**
 * A benchmark's closes at research's observation times (see benchmarkPoints): from memory
 * while complete, otherwise 2 Twelve Data credits, shared by every request waiting for the
 * same symbol. Failures aren't cached, so the next analysis tries again.
 */
export async function getBenchmarkSeries(symbol: string): Promise<Result<BenchmarkSeries>> {
  const cached = cache.get(symbol);
  if (cached && Date.now() < cached.expiresAt) return ok(cached.series);

  let pending = loading.get(symbol);
  if (!pending) {
    pending = download(symbol).then((result) => {
      loading.delete(symbol);
      if (result.ok) {
        cache.delete(symbol); // Re-insert so the least recently fetched symbol is evicted first.
        cache.set(symbol, { series: result.data, expiresAt: benchmarkExpiry(result.data.fetchedAt) });
        if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
      }
      return result;
    });
    loading.set(symbol, pending);
  }
  return pending;
}
