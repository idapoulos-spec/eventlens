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

/** OHLCV bar. `t` is the bar's close time as a Unix timestamp in milliseconds. */
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
  /** Daily bars covering roughly the last three months, oldest first. */
  daily: StockBar[];
  /** Annualized 30-trading-day realized volatility, in percent. */
  realizedVol30d: number | null;
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
  values: { datetime: string; open: string; high: string; low: string; close: string; volume?: string }[];
}
