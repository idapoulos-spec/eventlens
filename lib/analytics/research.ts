import { HOUR_MS } from "./probability";
import type { ProbabilitySource, TimePoint } from "./types";

/**
 * Research compares Kalshi and the stock only at moments where both have a real
 * observation. The stock is observed at its bar closes during trading hours; Kalshi is
 * read at those same moments. Kalshi only writes a candle when something changes, so
 * the latest candle at or before a moment is the probability in effect then, not a guess.
 */

/** "hourly": top-of-hour closes during trading hours. "daily": session closes. */
export type Resolution = "hourly" | "daily";

/** Why Kalshi's value at a row can't be used. */
export type RowExclusion =
  /** No Kalshi candle yet in the loaded history, so the probability in effect is unknown. */
  | "before_kalshi"
  /** After the market's close time: its last price is no longer a live probability. */
  | "market_closed"
  /** Estimated from the last trade (the book was one-sided), which may be stale. */
  | "kalshi_last_price";

export interface SourcedPoint extends TimePoint {
  source: ProbabilitySource;
}

export interface ResearchRow {
  /** Stock observation time (a bar close), ms. */
  t: number;
  /**
   * Position on a regular grid: consecutive observations with no gap between them differ
   * by exactly 1. Hours since the epoch for hourly rows, trading-day index for daily rows.
   */
  step: number;
  stockClose: number;
  /** Kalshi probability in effect at `t` (0–1), or null before the first candle. */
  probability: number | null;
  kalshiSource: ProbabilitySource | null;
  /** When the Kalshi candle that `probability` comes from ended, ms. */
  kalshiAsOf: number | null;
  /** Why Kalshi's value can't be used here, or null if it can. */
  exclusion: RowExclusion | null;
}

/**
 * Top-of-hour closes that line up with Kalshi's hourly candles, from close-stamped
 * intraday bars. Leaves out bars that are still forming or closed less than `settleMs`
 * before `asOf`, since their close may not be final yet.
 */
export function topOfHourCloses(bars: TimePoint[], asOf: number, settleMs = 5 * 60 * 1000): TimePoint[] {
  return bars.filter((b) => b.t % HOUR_MS === 0 && b.t <= asOf - settleMs);
}

interface BuildOptions {
  /** Stock observations: bar closes stamped at their close time. */
  stock: TimePoint[];
  /** Kalshi probability points (0–1), each stamped at its candle's end. */
  kalshi: SourcedPoint[];
  /** The market's close time (ms), or null if unknown. */
  closeTime: number | null;
  resolution: Resolution;
}

/** One row per stock observation, with the Kalshi probability in effect at that moment. */
export function buildResearchRows({ stock, kalshi, closeTime, resolution }: BuildOptions): ResearchRow[] {
  const prices = stock.filter((p) => Number.isFinite(p.value) && p.value > 0).sort((a, b) => a.t - b.t);
  const probs = [...kalshi].sort((a, b) => a.t - b.t);

  const rows: ResearchRow[] = [];
  let ki = -1;
  for (const [i, p] of prices.entries()) {
    while (ki + 1 < probs.length && probs[ki + 1].t <= p.t) ki++;
    const k = ki >= 0 ? probs[ki] : null;
    rows.push({
      t: p.t,
      step: resolution === "hourly" ? Math.round(p.t / HOUR_MS) : i,
      stockClose: p.value,
      probability: k?.value ?? null,
      kalshiSource: k?.source ?? null,
      kalshiAsOf: k?.t ?? null,
      exclusion:
        k === null
          ? "before_kalshi"
          : closeTime !== null && p.t > closeTime
            ? "market_closed"
            : k.source !== "midpoint"
              ? "kalshi_last_price"
              : null,
    });
  }
  return rows;
}

/** Rows observed after `from` (ms). */
export function rowsSince(rows: ResearchRow[], from: number): ResearchRow[] {
  return rows.filter((r) => r.t > from);
}
