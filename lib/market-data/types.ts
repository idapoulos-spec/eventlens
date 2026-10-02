import type { TimePoint } from "@/lib/analytics/types";

export interface StockQuote {
  symbol: string;
  name: string;
  exchange: string;
  currency: string;
  price: number;
  change: number | null;
  percentChange: number | null;
  previousClose: number | null;
  volume: number | null;
  averageVolume: number | null;
  isMarketOpen: boolean;
}

/**
 * OHLCV bar. `t` is a Unix timestamp in milliseconds: the close time for intraday
 * bars, and 00:00 UTC of the trading date for daily bars.
 */
export interface StockBar {
  t: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
}

export interface StockOverview {
  quote: StockQuote;
  /** Hourly bars covering roughly the last two weeks, oldest first. The last may still be forming. */
  intraday: StockBar[];
  /**
   * 30-minute bars covering roughly the last 70 sessions (regular hours only), oldest
   * first. The last may still be forming.
   */
  halfHourly: StockBar[];
  /**
   * Daily bars of completed sessions covering roughly the last three months, oldest first.
   * While the market is open, today's unfinished bar is left out.
   */
  daily: StockBar[];
  /** Annualized 30-trading-day realized volatility, in percent, from the completed sessions in `daily`. */
  realizedVol30d: number | null;
  /**
   * The latest session's volume as a percentage of average volume. Null while the market
   * is open: today's volume is still accumulating, and Twelve Data's intraday count can
   * miss part of the market, so it isn't comparable with the average until the close.
   */
  relativeVolume: number | null;
  /** When the bars in `intraday`, `halfHourly`, and `daily` were fetched (ms): up to a minute before `fetchedAt`. */
  historyFetchedAt: number;
  fetchedAt: number;
}

/**
 * A benchmark's closes at the moments research observes a stock: top-of-hour closes during
 * trading hours, and session closes. Only bars that had closed at least 5 minutes before
 * `fetchedAt` are included, so none is still forming.
 */
export interface BenchmarkSeries {
  symbol: string;
  hourly: TimePoint[];
  daily: TimePoint[];
  /** When the bars were fetched from Twelve Data (ms). */
  fetchedAt: number;
}

// ---- Raw Twelve Data shapes (only the fields we read) ----

export interface RawError {
  status: "error";
  code: number;
  message: string;
}

export interface RawQuote {
  symbol: string;
  /** Trading date of the quote's session, "YYYY-MM-DD". */
  datetime?: string;
  name?: string;
  exchange?: string;
  currency?: string;
  close: string;
  change?: string;
  percent_change?: string;
  previous_close?: string;
  volume?: string;
  average_volume?: string;
  is_market_open?: boolean;
}

export interface RawTimeSeries {
  status: "ok";
  meta?: { exchange_timezone?: string };
  values: { datetime: string; open: string; high: string; low: string; close: string; volume?: string }[];
}

/** One entry of /stocks or /etfs. /etfs entries have no `type`. */
export interface RawSymbol {
  symbol: string;
  name?: string;
  exchange?: string;
  type?: string;
}

export interface RawSymbolList {
  data: RawSymbol[];
}
