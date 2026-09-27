import type { ProbabilitySource, TimePoint } from "@/lib/analytics";

/** Normalized Kalshi market. Prices are in dollars (0–1), i.e. probability units. */
export interface KalshiMarket {
  ticker: string;
  eventTicker: string;
  title: string;
  subtitle: string | null;
  status: string;
  yesBid: number | null;
  yesAsk: number | null;
  lastPrice: number | null;
  volume24h: number | null;
  openInterest: number | null;
  closeTime: string | null;
}

export interface KalshiOverview {
  market: KalshiMarket;
  probability: number | null;
  probabilitySource: ProbabilitySource;
  change1hPp: number | null;
  change24hPp: number | null;
  uncertainty: number | null;
  /** Hourly implied probability history (0–1), oldest first. */
  history: TimePoint[];
  fetchedAt: number;
}

// ---- Raw API shapes (only the fields we read) ----

export interface RawMarket {
  ticker: string;
  event_ticker: string;
  title?: string;
  yes_sub_title?: string;
  subtitle?: string;
  status?: string;
  yes_bid_dollars?: string | null;
  yes_ask_dollars?: string | null;
  last_price_dollars?: string | null;
  volume_24h_fp?: string | null;
  open_interest_fp?: string | null;
  close_time?: string | null;
}

export interface RawEvent {
  event_ticker: string;
  series_ticker: string;
  title?: string;
}

interface RawOhlc {
  close_dollars?: string | null;
}

export interface RawCandlestick {
  end_period_ts: number;
  yes_bid?: RawOhlc;
  yes_ask?: RawOhlc;
  price?: RawOhlc;
}
