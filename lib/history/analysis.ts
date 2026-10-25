import "server-only";

import { getKalshiOverview } from "@/lib/kalshi/client";
import { DEFAULT_BENCHMARK } from "@/lib/market-data/benchmark-series";
import { getBenchmarkSeries } from "@/lib/market-data/benchmark";
import { getStockOverview } from "@/lib/market-data/twelve-data";
import { findKalshiMarket, marketOf, researchWindowOf } from "./market";
import { getLongResearchHistory, getResearchHistory } from "./research";

/**
 * Starts every request one analysis needs, and returns a promise per dashboard section; none
 * of them rejects. Each section waits only for the data it needs.
 *
 * The stock's history requests wait for the market lookup to learn which window to cover: with
 * the data store on, Research ends at a closed market's close (and can study markets settled
 * before Kalshi's archive cutoff); either way, its longer windows reach back to the market's open.
 * With `asOf` (a frozen link), Research ends at that time instead of now; with `benchmark` (a
 * link's), Research starts with that benchmark instead of the default, for the same 2 credits.
 */
export function loadAnalysis(stock: string, kalshi: string, { asOf = null, benchmark = DEFAULT_BENCHMARK.symbol }: { asOf?: number | null; benchmark?: string } = {}) {
  const market = findKalshiMarket(kalshi);
  const researchWindow = researchWindowOf(market, asOf);
  const kalshiData = getKalshiOverview(kalshi, marketOf(market));
  const stockData = getStockOverview(stock, researchWindow);
  // Research's 90-day history is a separate request, so it never slows the sections above, and
  // the longer windows' history another, streamed after the page's first render.
  const researchHistory = getResearchHistory(kalshi, researchWindow);
  const longHistory = getLongResearchHistory(kalshi, researchWindow);
  // Research's benchmark (the default, or the link's) waits for the stock's own requests, so the
  // stock gets the shared Twelve Data quota first. It's skipped if the stock failed or is the benchmark.
  const benchmarkData = Promise.all([stockData, researchWindow]).then(([s, { end, frozen }]) =>
    s.ok && stock !== benchmark ? getBenchmarkSeries(benchmark, { end, frozen }) : null,
  );
  return { kalshiData, stockData, researchHistory, benchmarkData, longHistory };
}
