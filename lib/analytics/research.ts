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
  | "kalshi_last_price"
  /** An event's expected value is missing at this time; `expected.missing` says why. Never an older value instead. */
  | "expected_missing";

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
  /** Kalshi's value in effect at `t` (a probability, 0–1), or null before the first candle. */
  kalshiValue: number | null;
  kalshiSource: ProbabilitySource | null;
  /** When the Kalshi candle that `probability` comes from ended, ms. */
  kalshiAsOf: number | null;
  /** Why Kalshi's value can't be used here, or null if it can. */
  exclusion: RowExclusion | null;
  /** For an event's expected value: Σp, the open outcomes' tickers, and why E is missing. */
  expected?: ExpectedDetail;
}

export interface ExpectedDetail {
  sumP: number | null;
  /** Tickers separated by spaces; an interval whose ends differ in it has no change. */
  openSet: string;
  missing: string | null;
}

/** An event's expected value at one top-of-hour mark, or null with the reason it's missing. */
export interface ExpectedPoint {
  t: number;
  value: number | null;
  sumP: number | null;
  openSet: string[];
  missing: string | null;
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

/** Usable stock observations, oldest first. */
const usablePrices = (stock: TimePoint[]) => stock.filter((p) => Number.isFinite(p.value) && p.value > 0).sort((a, b) => a.t - b.t);

/** One row per stock observation, with the Kalshi probability in effect at that moment. */
export function buildResearchRows({ stock, kalshi, closeTime, resolution }: BuildOptions): ResearchRow[] {
  const prices = usablePrices(stock);
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
      kalshiValue: k?.value ?? null,
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

/**
 * One row per stock observation, with an event's expected value at that exact moment. Stock
 * observations are top-of-hour closes, and E is evaluated at every top of the hour, so each row
 * reads its own mark: a missing E stays missing rather than falling back to an older value.
 */
export function buildExpectedRows({ stock, marks, resolution }: { stock: TimePoint[]; marks: ExpectedPoint[]; resolution: Resolution }): ResearchRow[] {
  const byT = new Map(marks.map((m) => [m.t, m]));
  return usablePrices(stock).map((p, i) => {
    const m = byT.get(p.t);
    return {
      t: p.t,
      step: resolution === "hourly" ? Math.round(p.t / HOUR_MS) : i,
      stockClose: p.value,
      kalshiValue: m?.value ?? null,
      kalshiSource: null,
      kalshiAsOf: m ? m.t : null,
      exclusion: !m ? "before_kalshi" : m.value === null ? "expected_missing" : null,
      ...(m && { expected: { sumP: m.sumP, openSet: m.openSet.join(" "), missing: m.missing } }),
    };
  });
}

/** Rows observed after `from` (ms). */
export function rowsSince(rows: ResearchRow[], from: number): ResearchRow[] {
  return rows.filter((r) => r.t > from);
}
