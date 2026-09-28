import type { TimePoint } from "./types";

export interface AlignedPoint {
  t: number;
  /** Kalshi implied probability in percent (0–100). */
  probability: number | null;
  /** Probability change since the first aligned observation, in percentage points. */
  probabilityChange: number | null;
  stockPrice: number | null;
  /** Stock return since the first aligned observation, in percent. */
  stockReturn: number | null;
}

/**
 * Merge time series into one chronologically sorted series.
 * When several points share a timestamp, the one from the later series wins.
 */
export function mergeSeries(...series: TimePoint[][]): TimePoint[] {
  const byTime = new Map<number, number>();
  for (const s of series) for (const p of s) byTime.set(p.t, p.value);
  return Array.from(byTime, ([t, value]) => ({ t, value })).sort((a, b) => a.t - b.t);
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
  let baseProb: number | null = null;
  let basePrice: number | null = null;

  for (const t of timeline) {
    while (pi < probs.length && probs[pi].t <= t) lastProb = probs[pi++].value;
    while (si < prices.length && prices[si].t <= t) lastPrice = prices[si++].value;
    if (lastProb === null || lastPrice === null) continue;

    baseProb ??= lastProb;
    basePrice ??= lastPrice;
    aligned.push({
      t,
      probability: lastProb * 100,
      probabilityChange: (lastProb - baseProb) * 100,
      stockPrice: lastPrice,
      stockReturn: basePrice > 0 ? (lastPrice / basePrice - 1) * 100 : null,
    });
  }

  return aligned;
}
