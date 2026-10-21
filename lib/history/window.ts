// Where Research's window ends, and what it reads in it. Pure, so the browser can use it too
// (the benchmark picker sends the window's end to /api/benchmark).

import { topOfHourCloses } from "@/lib/analytics/research";
import type { TimePoint } from "@/lib/analytics/types";
import { formatDateTime } from "@/lib/format";
import { sessionClosePoints } from "@/lib/market-data/session";
import type { StockBar } from "@/lib/market-data/types";
import { fail, ok, type Result } from "@/lib/result";
import type { FoundMarket, Provenance, ResearchWindow } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The rows the page loads with (the 7, 30, and 90-day windows). */
export const RESEARCH_WINDOW_MS = 90 * DAY_MS;
/** Kalshi history reaches a week further back, to find the probability in effect when the window starts. */
export const KALSHI_HISTORY_MS = RESEARCH_WINDOW_MS + 7 * DAY_MS;
/** Stock bars for a window that ends in the past: the 90 days, plus a margin for the session before it. */
export const STOCK_HISTORY_MS = 100 * DAY_MS;
/**
 * The longest history Research's longer windows (180 days, a year, and "All") can read: 540
 * days of 30-minute bars is about 372 sessions of 13 bars, under the 5,000 one Twelve Data
 * request returns for one credit (4,828 for SPY from 2025-04-22 to 2026-10-14).
 */
export const LONG_HISTORY_DAYS = 540;
export const LONG_HISTORY_MS = LONG_HISTORY_DAYS * DAY_MS;

/** Research ending now, as without the store. */
export const LIVE_WINDOW: ResearchWindow = { end: null, archived: false, start: null };

const timeOf = (iso: string | null) => {
  const ms = iso === null ? NaN : Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
};

/** Research ends at the market's close once that has passed, otherwise now; its longer windows start no earlier than its open. */
export function windowFor({ market, archived }: FoundMarket, now: number): ResearchWindow {
  const close = timeOf(market.closeTime);
  return { end: close !== null && close <= now ? close : null, archived, start: timeOf(market.openTime) };
}

/**
 * Where the longer windows start for a window ending at `anchor` (ms): the market's open, but no
 * more than LONG_HISTORY_MS before the end.
 */
export function longHistoryStart(start: number | null, anchor: number): number {
  return Math.max(start ?? -Infinity, anchor - LONG_HISTORY_MS);
}

/** Where a stock's bars start: far enough back for the longer windows, and never less than STOCK_HISTORY_MS. */
export function stockHistoryStart(start: number | null, anchor: number): number {
  return Math.min(longHistoryStart(start, anchor), anchor - STOCK_HISTORY_MS);
}

/**
 * The stock observations Research lines Kalshi up with: top-of-hour closes of settled bars, and
 * each session's close (see sessionClosePoints). A window ending in the past keeps what came
 * up to its end, including a bar that closed at that very moment.
 */
export function researchStockPoints({
  halfHourly,
  daily,
  fetchedAt,
  end,
}: {
  halfHourly: StockBar[];
  daily: StockBar[];
  /** When the bars were fetched: bars that hadn't settled by then are left out. */
  fetchedAt: number;
  end: number | null;
}): { hourly: TimePoint[]; daily: TimePoint[] } {
  const hourly = topOfHourCloses(
    halfHourly.map((b) => ({ t: b.t, value: b.close })),
    fetchedAt,
  );
  // Each session's real close, so early-close days line up with Kalshi at the right moment.
  const closes = sessionClosePoints(daily, halfHourly);
  if (end === null) return { hourly, daily: closes };
  return { hourly: hourly.filter((p) => p.t <= end), daily: closes.filter((p) => p.t <= end) };
}

// ---- /api/benchmark?symbol=QQQ&end=… : a benchmark for a window that ends in the past ----

export const BENCHMARK_END_PARAM = "end";
const EARLIEST_END = Date.UTC(2015, 0, 1);

/** A window's end from a URL: absent (null), or whole milliseconds since 2015, not in the future. */
export function parseWindowEnd(value: string | null, now: number): Result<number | null> {
  if (value === null) return ok(null);
  const end = /^\d{1,15}$/.test(value) ? Number(value) : NaN;
  if (!(end >= EARLIEST_END && end <= now)) {
    return fail("invalid_end", "The research window's end must be a past time, in milliseconds.");
  }
  return ok(end);
}

// ---- The Sources note ----

/** "Kalshi research history stored through …", or null if no stored candles were used. */
export function provenanceNote({ storedThrough, liveFrom, liveFailed }: Provenance): string | null {
  if (storedThrough === null) return null;
  const through = `Kalshi research history stored through ${formatDateTime(storedThrough, { withYear: true })}`;
  if (liveFailed) return `${through}; later candles couldn't be loaded.`;
  return liveFrom === null ? `${through}.` : `${through}, live after that.`;
}
