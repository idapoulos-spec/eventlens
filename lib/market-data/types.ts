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
  /** Hourly bars covering roughly the last week, oldest first. */
  intraday: StockBar[];
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
