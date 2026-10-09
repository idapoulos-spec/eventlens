import "server-only";

import { readStoredStockWindow } from "@/lib/history/stocks";
import { readStore } from "@/lib/history/store";
import { STOCK_HISTORY_MS } from "@/lib/history/window";
import { fail, ok, type Result } from "@/lib/result";
import { BENCHMARK_SETTLE_MS, benchmarkExpiry, benchmarkPoints } from "./benchmark-series";
import { memoryCache } from "./memory-cache";
import { DAILY_BARS, describeError, getApiKey, getTimeSeries, HALF_HOURLY_BARS, MAX_BARS, windowDates } from "./twelve-data";
import type { BenchmarkSeries } from "./types";

// Benchmarks are kept in this server instance's memory with when they were fetched, which
// decides which bars are final. The same benchmark serves many stocks (SPY is the default
// for every analysis), so each is kept until its next bar settles: 2 credits per symbol at
// most every 30 minutes. A benchmark for a window that ended in the past (a closed market's
// Research) never changes once fetched, so it's kept until it's the least recently loaded.
const cache = memoryCache<BenchmarkSeries>(20);

function missingKey(): Result<never> {
  return fail("missing_key", "Benchmark prices aren't available because this site hasn't been set up with a market-data API key.");
}

async function download(symbol: string): Promise<Result<BenchmarkSeries>> {
  const apiKey = getApiKey();
  if (!apiKey) return missingKey();
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

/** The bars of a research window ending at `end`: stored if the store covers the window, otherwise 1 credit each. */
async function downloadWindow(symbol: string, end: number): Promise<Result<BenchmarkSeries>> {
  const range = { from: end - STOCK_HISTORY_MS, to: end + 1 };
  const [storedHalfHourly, storedDaily] =
    (await readStore("benchmark bars", (sql) =>
      Promise.all([readStoredStockWindow(sql, symbol, "30min", range), readStoredStockWindow(sql, symbol, "1day", range)]),
    )) ?? [null, null];
  if (storedHalfHourly && storedDaily) return ok(benchmarkPoints(symbol, storedHalfHourly.bars, storedDaily.bars, Date.now()));

  const apiKey = getApiKey();
  if (!apiKey) return missingKey();
  const fetchedAt = Date.now();
  try {
    const [halfHourly, daily] = await Promise.all([
      storedHalfHourly ?? getTimeSeries(symbol, "30min", MAX_BARS, apiKey, windowDates(end)),
      storedDaily ?? getTimeSeries(symbol, "1day", MAX_BARS, apiKey, windowDates(end)),
    ]);
    return ok(benchmarkPoints(symbol, halfHourly.bars, daily.bars, fetchedAt));
  } catch (err) {
    return describeError(err, symbol, apiKey);
  }
}

/**
 * A benchmark's closes at research's observation times (see benchmarkPoints): from memory
 * while complete, otherwise 2 Twelve Data credits, shared by every request waiting for the
 * same symbol. Failures aren't cached, so the next analysis tries again. With `end` (a closed
 * market's close), the bars cover the research window ending there instead of the latest ones.
 */
export function getBenchmarkSeries(symbol: string, { end = null }: { end?: number | null } = {}): Promise<Result<BenchmarkSeries>> {
  if (end === null) return cache(symbol, () => download(symbol), (series) => benchmarkExpiry(series.fetchedAt));
  return cache(
    `${symbol}@${end}`,
    () => downloadWindow(symbol, end),
    // Every bar up to `end` had settled when fetched: nothing in the window can change.
    (series) => (end + BENCHMARK_SETTLE_MS <= series.fetchedAt ? Infinity : benchmarkExpiry(series.fetchedAt)),
  );
}
