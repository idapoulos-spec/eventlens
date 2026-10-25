import "server-only";

import { readStoredStockWindow } from "@/lib/history/stocks";
import { readStore } from "@/lib/history/store";
import { LONG_HISTORY_MS } from "@/lib/history/window";
import { fail, ok, type Result } from "@/lib/result";
import { BENCHMARK_SETTLE_MS, benchmarkExpiry, benchmarkPoints } from "./benchmark-series";
import { memoryCache } from "./memory-cache";
import { adjustIntradayForSplits } from "./session";
import { describeError, getApiKey, getTimeSeries, MAX_BARS, utcDate, windowDates } from "./twelve-data";
import type { BenchmarkSeries } from "./types";

// Benchmarks are kept in this server instance's memory with when they were fetched, which
// decides which bars are final. The same benchmark serves many stocks (SPY is the default
// for every analysis), so each is kept until its next bar settles: 2 credits per symbol at
// most every 30 minutes. A benchmark for a window that ended in the past (a closed market's
// Research) never changes once fetched, so it's kept until it's the least recently loaded.
// Each covers the longest history any analysis reads (LONG_HISTORY_MS before the window's end;
// still 1 credit a request), so one download serves every stock whatever its market's life.
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
    const dates = { startDate: utcDate(fetchedAt - LONG_HISTORY_MS) };
    const [halfHourly, daily] = await Promise.all([
      getTimeSeries(symbol, "30min", MAX_BARS, apiKey, dates),
      getTimeSeries(symbol, "1day", MAX_BARS, apiKey, dates),
    ]);
    return ok(benchmarkPoints(symbol, adjustIntradayForSplits(halfHourly.bars, daily.bars), daily.bars, fetchedAt));
  } catch (err) {
    return describeError(err, symbol, apiKey);
  }
}

/**
 * The bars of a research window ending at `end`: stored if the store covers the window, otherwise
 * 1 credit each. For a frozen window (`end` is a link's as-of time), bars count as settled at `end`.
 */
async function downloadWindow(symbol: string, end: number, frozen: boolean): Promise<Result<BenchmarkSeries>> {
  const settled = (fetchedAt: number) => (frozen ? Math.min(fetchedAt, end) : fetchedAt);
  const range = { from: end - LONG_HISTORY_MS, to: end + 1 };
  const [storedHalfHourly, storedDaily] =
    (await readStore("benchmark bars", (sql) =>
      Promise.all([readStoredStockWindow(sql, symbol, "30min", range), readStoredStockWindow(sql, symbol, "1day", range)]),
    )) ?? [null, null];
  if (storedHalfHourly && storedDaily) {
    const fetchedAt = Date.now();
    return ok(benchmarkPoints(symbol, adjustIntradayForSplits(storedHalfHourly.bars, storedDaily.bars), storedDaily.bars, fetchedAt, settled(fetchedAt)));
  }

  const apiKey = getApiKey();
  if (!apiKey) return missingKey();
  const fetchedAt = Date.now();
  try {
    const [halfHourly, daily] = await Promise.all([
      storedHalfHourly ?? getTimeSeries(symbol, "30min", MAX_BARS, apiKey, windowDates(end, range.from)),
      storedDaily ?? getTimeSeries(symbol, "1day", MAX_BARS, apiKey, windowDates(end, range.from)),
    ]);
    return ok(benchmarkPoints(symbol, adjustIntradayForSplits(halfHourly.bars, daily.bars), daily.bars, fetchedAt, settled(fetchedAt)));
  } catch (err) {
    return describeError(err, symbol, apiKey);
  }
}

/**
 * A benchmark's closes at research's observation times (see benchmarkPoints): from memory
 * while complete, otherwise 2 Twelve Data credits, shared by every request waiting for the
 * same symbol. Failures aren't cached, so the next analysis tries again. With `end` (a closed
 * market's close), the bars cover the research window ending there instead of the latest ones;
 * with `frozen` too (`end` is a link's as-of time), only bars settled by then count.
 */
export function getBenchmarkSeries(symbol: string, { end = null, frozen = false }: { end?: number | null; frozen?: boolean } = {}): Promise<Result<BenchmarkSeries>> {
  if (end === null) return cache(symbol, () => download(symbol), (series) => benchmarkExpiry(series.fetchedAt));
  if (frozen) {
    // Bars settled by the as-of time had settled when fetched (it's in the past), so they never change.
    return cache(`${symbol}@${end}~asof`, () => downloadWindow(symbol, end, true), () => Infinity);
  }
  return cache(
    `${symbol}@${end}`,
    () => downloadWindow(symbol, end, false),
    // Every bar up to `end` had settled when fetched: nothing in the window can change.
    (series) => (end + BENCHMARK_SETTLE_MS <= series.fetchedAt ? Infinity : benchmarkExpiry(series.fetchedAt)),
  );
}
