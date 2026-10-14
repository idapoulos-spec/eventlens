import type { TimePoint } from "./types";

export interface AlignedPoint {
  t: number;
  /** Kalshi's value, scaled: an implied probability in percent (0–100), or an expected value in its unit. Null in a gap. */
  probability: number | null;
  /** Its change since the first aligned observation (pp for a probability), or null in a gap. */
  probabilityChange: number | null;
  stockPrice: number | null;
  /** Stock return since the first aligned observation, in percent. */
  stockReturn: number | null;
}

/**
 * Merge time series into one chronologically sorted series. Points keep any extra fields.
 * When several points share a timestamp, the one from the later series wins.
 */
export function mergeSeries<P extends TimePoint>(...series: P[][]): P[] {
  const byTime = new Map<number, P>();
  for (const s of series) for (const p of s) byTime.set(p.t, p);
  return Array.from(byTime.values()).sort((a, b) => a.t - b.t);
}

/**
 * Align two time series on a shared timeline using an as-of join.
 *
 * The timeline is the union of both series' timestamps. At each timestamp,
 * each series carries forward its most recent known value, so a stock that
 * only trades during market hours lines up with a market that trades 24/7.
 * Points before both series have started are dropped. A null value in the first series (an
 * expected value that's missing) is a gap until its next value, not a value carried over it.
 * `scale` multiplies it: 100 shows a probability in percent.
 */
export function alignSeries(probability: { t: number; value: number | null }[], stock: TimePoint[], scale = 100): AlignedPoint[] {
  const probs = [...probability].sort((a, b) => a.t - b.t);
  const prices = [...stock].sort((a, b) => a.t - b.t);
  const timeline = Array.from(new Set([...probs, ...prices].map((p) => p.t))).sort((a, b) => a - b);

  const aligned: AlignedPoint[] = [];
  let pi = 0;
  let si = 0;
  let lastProb: number | null = null;
  let seenProb = false;
  let lastPrice: number | null = null;
  let baseProb: number | null = null;
  let basePrice: number | null = null;

  for (const t of timeline) {
    while (pi < probs.length && probs[pi].t <= t) {
      lastProb = probs[pi++].value;
      seenProb = true;
    }
    while (si < prices.length && prices[si].t <= t) lastPrice = prices[si++].value;
    if (!seenProb || lastPrice === null) continue;

    if (lastProb !== null) baseProb ??= lastProb;
    basePrice ??= lastPrice;
    aligned.push({
      t,
      probability: lastProb === null ? null : lastProb * scale,
      probabilityChange: lastProb === null || baseProb === null ? null : (lastProb - baseProb) * scale,
      stockPrice: lastPrice,
      stockReturn: basePrice > 0 ? (lastPrice / basePrice - 1) * 100 : null,
    });
  }

  return aligned;
}
