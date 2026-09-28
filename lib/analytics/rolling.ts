import type { ChangePoint } from "./changes";
import { pearson } from "./correlation";

export interface RollingPoint {
  /** End of the window: the last interval it includes. */
  t: number;
  /** Start of the window: the first interval it includes. */
  startT: number;
  /** Correlation over the window, or null if Kalshi or the stock didn't move in it. */
  r: number | null;
  n: number;
}

/** Correlation of Kalshi changes and stock returns over each run of `window` consecutive usable intervals. */
export function rollingCorrelation(changes: ChangePoint[], window: number): RollingPoint[] {
  const points: RollingPoint[] = [];
  if (window < 2) return points;
  for (let end = window; end <= changes.length; end++) {
    const slice = changes.slice(end - window, end);
    points.push({
      t: slice[slice.length - 1].t,
      startT: slice[0].t,
      r: pearson(slice.map((c) => c.probChangePp), slice.map((c) => c.logReturn)),
      n: window,
    });
  }
  return points;
}
