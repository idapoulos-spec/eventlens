import { MIN_KALSHI_MOVES, sampleFlag, type SampleFlag } from "./sample";

/** A Kalshi probability change (x, pp) paired with a stock log return (y). */
export interface Pair {
  x: number;
  y: number;
}

/**
 * Pearson correlation coefficient. Null for fewer than two pairs, mismatched lengths,
 * or when either series doesn't vary (the correlation is undefined).
 */
export function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 2 || ys.length !== n) return null;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return null;
  // Rounding can push a perfect correlation a hair past ±1.
  return Math.max(-1, Math.min(1, sxy / Math.sqrt(sxx * syy)));
}

export interface CorrelationStats {
  /** Pearson r, or null when there are too few pairs or a series doesn't vary. */
  r: number | null;
  n: number;
  /**
   * Half-width of the rough 95% range for r if there were no relationship: 1.96/√n.
   * Assumes independent observations.
   */
  band: number | null;
  /** How many pairs have a non-zero Kalshi change. */
  kalshiMoves: number;
  flag: SampleFlag;
  /** Fewer than MIN_KALSHI_MOVES non-zero Kalshi changes, so a few moves decide r. */
  fewKalshiMoves: boolean;
  /** At least MIN_PAIRS pairs, but Kalshi or the stock never moved, so r is undefined. */
  noVariation: boolean;
}

export function correlationStats(pairs: Pair[]): CorrelationStats {
  const n = pairs.length;
  const kalshiMoves = pairs.filter((p) => p.x !== 0).length;
  const flag = sampleFlag(n);
  const r = flag === "insufficient" ? null : pearson(pairs.map((p) => p.x), pairs.map((p) => p.y));
  return {
    r,
    n,
    band: r === null ? null : 1.96 / Math.sqrt(n),
    kalshiMoves,
    flag,
    fewKalshiMoves: kalshiMoves < MIN_KALSHI_MOVES,
    noVariation: flag !== "insufficient" && r === null,
  };
}
