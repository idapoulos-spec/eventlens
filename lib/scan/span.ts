// Which stock bars a scan needs, and what they cost. Pure, so the page can show the cost before a
// scan runs and the prices route can check it.

import { isLongWindow, LONG_HISTORY_MS, stockHistoryStart, STOCK_HISTORY_MS, type WindowChoice } from "@/lib/history/window";
import type { ScanCandidate } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;
/** The UTC date of a time, as Twelve Data's start_date and end_date take it (twelve-data.ts utcDate; that file is server-only). */
const utcDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * The most Twelve Data requests one scan's prices may take: the free plan allows 8 a minute, for
 * every user of the key together.
 */
export const MAX_PRICE_REQUESTS = 8;

/** Where the stock's 30-minute bars must start and end for every candidate's window. */
export interface PriceSpan {
  from: number;
  /** The latest window end (ms): now when any candidate is open. */
  to: number;
  /** Some candidate is open, so the bars run to now. */
  live: boolean;
}

/**
 * The bars each candidate's analysis reads: up to its end (its close, or now), from 100 days back
 * for the 7, 30, and 90-day windows, or from where its longer windows start (its open, at most
 * 540 days back) for the others, as its own page loads them. With `asOf` (a frozen scan), the
 * windows of candidates still open then end there, and nothing runs to now.
 */
export function priceSpan(candidates: Pick<ScanCandidate, "end" | "start">[], choice: WindowChoice, now: number, asOf: number | null = null): PriceSpan | null {
  if (candidates.length === 0) return null;
  let from = Infinity;
  let to = -Infinity;
  let live = false;
  for (const { end, start } of candidates) {
    const anchor = end ?? asOf ?? now;
    if (end === null && asOf === null) live = true;
    from = Math.min(from, isLongWindow(choice) ? stockHistoryStart(start, anchor) : anchor - STOCK_HISTORY_MS);
    to = Math.max(to, anchor);
  }
  return { from, to: live ? now : to, live };
}

/** One 30-minute request: start and end dates as Twelve Data takes them; no end date for the latest bars. */
export interface BarRequest {
  startDate: string;
  endDate?: string;
}

/**
 * The span's 30-minute requests: one per 540 days (each holds about 4,840 bars, under the 5,000
 * one request returns), the last open-ended when the span runs to now. Each runs to the day after
 * its end, as windowDates does, so no bar up to it is missed whatever time zone Twelve Data reads
 * the dates in; bars on a shared edge are kept once.
 */
export function halfHourlyRequests({ from, to, live }: PriceSpan): BarRequest[] {
  const out: BarRequest[] = [];
  for (let start = from; start < to; start += LONG_HISTORY_MS) {
    const end = Math.min(start + LONG_HISTORY_MS, to);
    out.push(live && end === to ? { startDate: utcDate(start) } : { startDate: utcDate(start), endDate: utcDate(end + DAY_MS) });
  }
  return out.length > 0 ? out : [{ startDate: utcDate(from) }];
}

/**
 * The benchmark comes from the pages' own cache (getBenchmarkSeries, shared with every analysis)
 * when the span is within the 540 days it holds up to now; otherwise from requests like the stock's.
 */
export function benchmarkFromCache({ from, live }: PriceSpan, now: number): boolean {
  return live && from >= now - LONG_HISTORY_MS + DAY_MS;
}

/** Twelve Data credits a scan's prices cost at most: per symbol, its 30-minute requests and one daily request. The benchmark costs nothing when it's in memory. */
export function priceCredits(span: PriceSpan): number {
  return 2 * (halfHourlyRequests(span).length + 1);
}
