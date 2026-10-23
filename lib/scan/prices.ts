import "server-only";

import { benchmarkPoints, DEFAULT_BENCHMARK } from "@/lib/market-data/benchmark-series";
import { getBenchmarkSeries } from "@/lib/market-data/benchmark";
import { memoryCache } from "@/lib/market-data/memory-cache";
import { adjustIntradayForSplits } from "@/lib/market-data/session";
import { describeError, getApiKey, getTimeSeries, MAX_BARS, STOCK_HISTORY_TTL_MS, type Interval } from "@/lib/market-data/twelve-data";
import type { BenchmarkSeries, StockBar } from "@/lib/market-data/types";
import { fail, ok, type Result } from "@/lib/result";
import { benchmarkFromCache, halfHourlyRequests, MAX_PRICE_REQUESTS, priceCredits, type BarRequest, type PriceSpan } from "./span";
import type { CompactBars, ScanPrices } from "./types";

// A scan's prices: the stock's bars and the benchmark's closes over every candidate's window, once.
// The same requests the pages make (time_series, 1 credit each whatever the length), one per 540
// days of 30-minute bars plus one for daily bars, per symbol, and no quote.

const DAY_MS = 24 * 60 * 60 * 1000;
/** The daily bars reach back at least this far, as the pages' do (twelve-data.ts PANEL_DAILY_MS), so the last 90 sessions are complete. */
const PANEL_DAILY_MS = 140 * DAY_MS;

interface Fetched {
  bars: StockBar[];
  fetchedAt: number;
}

// Bars that ended in the past never change, so they're kept until they're the least recently
// loaded; the latest ones for a minute, as the pages keep a stock's.
const cache = memoryCache<Fetched>(60);

/** One request's bars, from memory or 1 credit; `counted` is told when it costs one. */
function bars(symbol: string, interval: Interval, request: BarRequest, apiKey: string, counted: () => void): Promise<Result<Fetched>> {
  return cache(
    `${symbol}|${interval}|${request.startDate}|${request.endDate ?? "now"}`,
    async () => {
      counted();
      const fetchedAt = Date.now();
      try {
        const series = await getTimeSeries(symbol, interval, MAX_BARS, apiKey, request);
        return ok({ bars: series.bars, fetchedAt });
      } catch (err) {
        return describeError(err, symbol, apiKey);
      }
    },
    (f) => (request.endDate !== undefined && Date.parse(`${request.endDate}T00:00:00Z`) + DAY_MS < f.fetchedAt ? Infinity : f.fetchedAt + STOCK_HISTORY_TTL_MS),
  );
}

/** A symbol's 30-minute bars (split-adjusted) and daily bars over the span; the earliest fetch time among the latest bars. */
async function symbolBars(symbol: string, span: PriceSpan, apiKey: string, counted: () => void, now: number): Promise<Result<{ halfHourly: StockBar[]; daily: StockBar[]; fetchedAt: number }>> {
  const dailyStart = new Date(Math.min(span.from, now - PANEL_DAILY_MS)).toISOString().slice(0, 10);
  const parts = await Promise.all([
    ...halfHourlyRequests(span).map((r) => bars(symbol, "30min", r, apiKey, counted)),
    bars(symbol, "1day", { startDate: dailyStart }, apiKey, counted),
  ]);
  const failed = parts.find((p) => !p.ok);
  if (failed && !failed.ok) return failed;
  const fetched = parts.map((p) => (p as { ok: true; data: Fetched }).data);
  const daily = fetched.pop()!;
  const byT = new Map<number, StockBar>();
  for (const f of fetched) for (const b of f.bars) byT.set(b.t, b);
  const halfHourly = [...byT.values()].sort((a, b) => a.t - b.t);
  // Which bars count as settled depends on when the latest ones were fetched, as on the pages:
  // the last 30-minute request and the daily one (earlier requests ended in the past, so they're complete).
  const fetchedAt = Math.min(fetched[fetched.length - 1].fetchedAt, daily.fetchedAt);
  return ok({ halfHourly: adjustIntradayForSplits(halfHourly, daily.bars), daily: daily.bars, fetchedAt });
}

const compact = (bars: StockBar[]): CompactBars => ({ t: bars.map((b) => b.t), close: bars.map((b) => b.close) });

/**
 * The stock's bars and the default benchmark's closes over `span`. The stock's requests go first,
 * so it gets the shared Twelve Data quota first, as on the pages. Refused when the span needs more
 * than MAX_PRICE_REQUESTS requests.
 */
export async function getScanPrices(symbol: string, span: PriceSpan): Promise<Result<ScanPrices>> {
  if (priceCredits(span) > MAX_PRICE_REQUESTS) {
    return fail("too_long", "These candidates' windows span too long a time for one scan's prices (at most 8 Twelve Data requests). Pick fewer settled events, or a shorter window.");
  }
  const apiKey = getApiKey();
  if (!apiKey) return fail("missing_key", "Stock prices aren't available because this site hasn't been set up with a market-data API key.");
  const now = Date.now();
  let requests = 0;
  const counted = () => void requests++;

  const stock = await symbolBars(symbol, span, apiKey, counted, now);
  if (!stock.ok) return stock;

  let benchmark: Result<BenchmarkSeries>;
  if (benchmarkFromCache(span, now)) {
    const started = Date.now();
    benchmark = await getBenchmarkSeries(DEFAULT_BENCHMARK.symbol);
    // Downloaded for this call (2 requests), or already in memory.
    if (benchmark.ok && benchmark.data.fetchedAt >= started) requests += 2;
  } else {
    const b = await symbolBars(DEFAULT_BENCHMARK.symbol, span, apiKey, counted, now);
    benchmark = b.ok ? ok(benchmarkPoints(DEFAULT_BENCHMARK.symbol, b.data.halfHourly, b.data.daily, b.data.fetchedAt)) : b;
  }
  if (!benchmark.ok) return benchmark;

  return ok({
    symbol,
    halfHourly: compact(stock.data.halfHourly),
    daily: compact(stock.data.daily),
    fetchedAt: stock.data.fetchedAt,
    benchmark: benchmark.data,
    requests,
  });
}
