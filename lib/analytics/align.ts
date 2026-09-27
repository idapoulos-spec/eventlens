import type { TimePoint } from "./types";

export interface AlignedPoint {
  t: number;
  /** Kalshi implied probability in percent (0–100). */
  probability: number | null;
  stockPrice: number | null;
  /** Stock return since the first aligned observation, in percent. */
  stockReturn: number | null;
}

/**
 * Align two time series on a shared timeline using an as-of join.
 *
 * The timeline is the union of both series' timestamps. At each timestamp,
 * each series carries forward its most recent known value, so a stock that
 * only trades during market hours lines up with a market that trades 24/7.
 * Points before both series have started are dropped.
 */
export function alignSeries(probability: TimePoint[], stock: TimePoint[]): AlignedPoint[] {
  const probs = [...probability].sort((a, b) => a.t - b.t);
  const prices = [...stock].sort((a, b) => a.t - b.t);
  const timeline = Array.from(new Set([...probs, ...prices].map((p) => p.t))).sort((a, b) => a - b);

  const aligned: AlignedPoint[] = [];
  let pi = 0;
  let si = 0;
  let lastProb: number | null = null;
  let lastPrice: number | null = null;
  let basePrice: number | null = null;

  for (const t of timeline) {
    while (pi < probs.length && probs[pi].t <= t) lastProb = probs[pi++].value;
    while (si < prices.length && prices[si].t <= t) lastPrice = prices[si++].value;
    if (lastProb === null || lastPrice === null) continue;

    basePrice ??= lastPrice;
    aligned.push({
      t,
      probability: lastProb * 100,
      stockPrice: lastPrice,
      stockReturn: basePrice > 0 ? (lastPrice / basePrice - 1) * 100 : null,
    });
  }

  return aligned;
}
