import type { ProbabilityEstimate, TimePoint } from "./types";

const HOUR_MS = 60 * 60 * 1000;

function isPrice(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * Estimate the implied probability of a binary contract from its order book.
 *
 * Prefers the YES bid/ask midpoint: probability = (yesBid + yesAsk) / 2.
 * A bid of 0 or an ask of 1 means that side of the book is empty, so the
 * midpoint would be meaningless; in that case fall back to the last trade price.
 */
export function impliedProbability(
  yesBid: number | null,
  yesAsk: number | null,
  lastPrice: number | null = null,
): ProbabilityEstimate {
  const hasBid = isPrice(yesBid) && yesBid > 0;
  const hasAsk = isPrice(yesAsk) && yesAsk < 1;

  if (hasBid && hasAsk && yesAsk >= yesBid) {
    return { value: (yesBid + yesAsk) / 2, source: "midpoint" };
  }
  if (isPrice(lastPrice) && lastPrice > 0) {
    return { value: lastPrice, source: "last_price" };
  }
  return { value: null, source: "unavailable" };
}

/**
 * Change in probability over a lookback window, in percentage points.
 *
 * Compares `current` against the latest historical point at or before
 * `asOf - lookbackMs`. Returns null if history does not reach back far enough.
 */
export function probabilityChangePp(
  history: TimePoint[],
  current: number | null,
  lookbackMs: number,
  asOf: number = Date.now(),
): number | null {
  if (current === null) return null;

  const cutoff = asOf - lookbackMs;
  let reference: TimePoint | undefined;
  for (const point of history) {
    if (point.t > cutoff) break;
    reference = point;
  }
  if (!reference) return null;

  return (current - reference.value) * 100;
}

export const probabilityChange1hPp = (history: TimePoint[], current: number | null, asOf?: number) =>
  probabilityChangePp(history, current, HOUR_MS, asOf);

export const probabilityChange24hPp = (history: TimePoint[], current: number | null, asOf?: number) =>
  probabilityChangePp(history, current, 24 * HOUR_MS, asOf);
