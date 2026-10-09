import "server-only";

import { getKalshiOverview } from "@/lib/kalshi/client";
import { DEFAULT_BENCHMARK } from "@/lib/market-data/benchmark-series";
import { getBenchmarkSeries } from "@/lib/market-data/benchmark";
import { getStockOverview } from "@/lib/market-data/twelve-data";
import { findKalshiMarket, marketOf, researchWindowOf } from "./market";
import { getResearchHistory } from "./research";

/**
 * Starts every request one analysis needs, and returns a promise per dashboard section; none
 * of them rejects. Each section waits only for the data it needs.
 *
 * With the data store on, Research ends at a closed market's close (and can study markets
 * settled before Kalshi's archive cutoff), so the stock's history requests wait for the market
 * lookup to learn which window to cover. Without the store, nothing waits: Research ends now.
 */
export function loadAnalysis(stock: string, kalshi: string) {
  const market = findKalshiMarket(kalshi);
  const researchWindow = researchWindowOf(market);
  const kalshiData = getKalshiOverview(kalshi, marketOf(market));
  const stockData = getStockOverview(stock, researchWindow);
  // Research's 90-day history is a separate request, so it never slows the sections above.
  const researchHistory = getResearchHistory(kalshi, researchWindow);
  // Research's default benchmark waits for the stock's own requests, so the stock gets the
  // shared Twelve Data quota first. It's skipped if the stock failed or is the benchmark.
  const benchmarkData = Promise.all([stockData, researchWindow]).then(([s, { end }]) =>
    s.ok && stock !== DEFAULT_BENCHMARK.symbol ? getBenchmarkSeries(DEFAULT_BENCHMARK.symbol, { end }) : null,
  );
  return { kalshiData, stockData, researchHistory, benchmarkData };
}
