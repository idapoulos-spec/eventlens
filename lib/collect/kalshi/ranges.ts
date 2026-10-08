// Which time ranges the Kalshi collector fetches. Pure, so the rules are tested without Kalshi or
// a database. Like fetch_coverage (db/migrations/0001_init.sql), a range is half-open, [from, to)
// in milliseconds, and places a candle by its end time.
//
// Ranges start and end on whole minutes, since Kalshi candles end on minute boundaries and its
// requests take seconds. They are not aligned to periods: daily candles end at midnight New York
// time, which is 04:00 or 05:00 UTC depending on daylight saving time.

import type { TimeRange } from "@/lib/store/runs";
import type { KalshiPeriod } from "@/lib/store/schema";

const MINUTE_MS = 60_000;

/** A candle is stored once it ended this long ago, so one Kalshi writes a moment late isn't missed. */
export const SETTLE_MS = 5 * MINUTE_MS;
/** Incremental runs fetch again from this many periods before the end of what's covered. */
export const OVERLAP_PERIODS = 2;
/** Periods per request, under Kalshi's 10,000 (MAX_CANDLES_PER_REQUEST): 400 days of hourly candles. */
export const MAX_PERIODS_PER_WINDOW = 9_600;

export const KALSHI_PERIODS: readonly KalshiPeriod[] = ["60", "1440"];

export function periodMs(period: KalshiPeriod): number {
  return Number(period) * MINUTE_MS;
}

const floorMinute = (ms: number) => Math.floor(ms / MINUTE_MS) * MINUTE_MS;

/** A market's times (ms), null where Kalshi left one out. */
export interface MarketTimes {
  openTime: number | null;
  closeTime: number | null;
  settlementTs: number | null;
}

/**
 * Every candle a market can have, by end time: from its open until one period after it closed or
 * settled, whichever is later (a candle can end after the close: the period holding the close
 * ends after it, and some markets trade until settlement), and never past `now − SETTLE_MS`.
 * Null if the market has no settled candle yet.
 */
export function targetRange({ openTime, closeTime, settlementTs }: MarketTimes, period: KalshiPeriod, now: number): TimeRange | null {
  if (openTime === null) return null;
  const ended = Math.max(closeTime ?? -Infinity, settlementTs ?? -Infinity);
  const last = Math.min(now - SETTLE_MS, ended + periodMs(period));
  const range = { from: floorMinute(openTime), to: floorMinute(last) };
  return range.from < range.to ? range : null;
}

/**
 * What an incremental run fetches of `target`: from a little before the end of what's covered,
 * so a late correction is picked up, or all of it if nothing was. Null if it's covered through its end.
 */
export function incrementalRange(target: TimeRange, coveredUntil: number | null, period: KalshiPeriod): TimeRange | null {
  if (coveredUntil === null) return target;
  if (coveredUntil >= target.to) return null;
  return { from: Math.max(target.from, coveredUntil - OVERLAP_PERIODS * periodMs(period)), to: target.to };
}

/** `range` as consecutive windows of at most MAX_PERIODS_PER_WINDOW periods, oldest first. */
export function splitWindows({ from, to }: TimeRange, period: KalshiPeriod): TimeRange[] {
  const span = MAX_PERIODS_PER_WINDOW * periodMs(period);
  const windows: TimeRange[] = [];
  for (let start = from; start < to; start += span) windows.push({ from: start, to: Math.min(to, start + span) });
  return windows;
}
