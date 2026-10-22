// Each candidate's stock bars, cut from the scan's one download as its own page would have
// fetched them (getStockOverview in lib/market-data/twelve-data.ts), so its rows, and so its test,
// are the page's. Pure, so the browser does it.

import type { ResearchBars } from "@/lib/history/types";
import { longHistoryStart, stockHistoryStart, STOCK_HISTORY_MS } from "@/lib/history/window";
import { sessionCloseTimes, tradingDayClose } from "@/lib/market-data/session";
import type { StockBar } from "@/lib/market-data/types";
import type { CompactBars, ScanPrices } from "./types";

/** The daily bars the 7, 30, and 90-day windows read when they end now (twelve-data.ts DAILY_BARS). */
const DAILY_BARS = 90;

/** 00:00 UTC of a time's UTC date: where a request with that start_date begins. */
const dateStart = (ms: number) => Date.parse(`${new Date(ms).toISOString().slice(0, 10)}T00:00:00Z`);

export const expand = ({ t, close }: CompactBars): StockBar[] => t.map((time, i) => ({ t: time, open: close[i], high: close[i], low: close[i], close: close[i], volume: null }));

/** The stock's bars as plain bars, once per scan. */
export interface ScanStock {
  halfHourly: StockBar[];
  daily: StockBar[];
  fetchedAt: number;
}

export const scanStock = (prices: ScanPrices): ScanStock => ({ halfHourly: expand(prices.halfHourly), daily: expand(prices.daily), fetchedAt: prices.fetchedAt });

/**
 * The bars one candidate's page would read: from where its request would start (its open, at
 * most 540 days back, at least 100), the 30-minute bars up to its end, and the daily bars as the
 * page splits them for its windows.
 *
 * One difference, by design: without the quote (a scan doesn't spend a credit on it), today's
 * session counts as complete at its scheduled 4 PM close. On an early-close day, between that
 * close and 4 PM, the page would already count it; the scan leaves it out. And with a stock split
 * inside the scan's span, its 30-minute bars are rescaled over the span's split sessions, which
 * can be more than the page sees (adjustIntradayForSplits).
 */
export function candidateBars({ halfHourly, daily: allDaily, fetchedAt }: ScanStock, { end, start }: { end: number | null; start: number | null }): { research: ResearchBars; fetchedAt: number } {
  const from = stockHistoryStart(start, end ?? fetchedAt);
  const first = dateStart(from);
  const bars = halfHourly.filter((b) => b.t >= first);
  const sinceFrom = allDaily.filter((b) => b.t >= first);
  if (end !== null) {
    return {
      research: {
        end,
        halfHourly: bars,
        daily: sinceFrom.filter((b) => b.t >= dateStart(end - STOCK_HISTORY_MS)),
        longDaily: sinceFrom,
        longStart: longHistoryStart(start, end),
      },
      fetchedAt,
    };
  }
  // A day's bar is final once its session has ended (by its last 30-minute bar, and no earlier than its scheduled close).
  const closes = sessionCloseTimes(bars);
  const completed = (b: StockBar) => (closes.get(b.t) ?? tradingDayClose(b.t)) <= fetchedAt && tradingDayClose(b.t) <= fetchedAt;
  return {
    research: {
      end: null,
      halfHourly: bars,
      daily: allDaily.slice(-DAILY_BARS).filter(completed),
      longDaily: sinceFrom.filter(completed),
      longStart: longHistoryStart(start, fetchedAt),
    },
    fetchedAt,
  };
}
