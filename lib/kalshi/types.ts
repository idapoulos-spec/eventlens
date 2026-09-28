import type { ProbabilityChange, ProbabilitySource, TimePoint } from "@/lib/analytics";
import type { MarketPhase } from "./status";

/** Normalized Kalshi market. Prices are in dollars (0–1), i.e. probability units. */
export interface KalshiMarket {
  ticker: string;
  eventTicker: string;
  title: string;
  subtitle: string | null;
  status: string;
  /** Settlement result ("yes", "no", ...) once known, otherwise null. */
  result: string | null;
  yesBid: number | null;
  yesAsk: number | null;
  lastPrice: number | null;
  volume24h: number | null;
  openInterest: number | null;
  closeTime: string | null;
}

/** Why a probability change could not be computed. */
export type ChangeUnavailable = "market_not_live" | "no_probability" | "history_failed" | "not_enough_history";

export interface KalshiChange extends ProbabilityChange {
  unavailable: ChangeUnavailable | null;
}

export interface KalshiOverview {
  market: KalshiMarket;
  phase: MarketPhase;
  /** Whether the market's close time has passed. */
  closePassed: boolean;
  /** Live implied probability; null unless the market is open. */
  probability: number | null;
  probabilitySource: ProbabilitySource;
  /** Compared against minute-level history. */
  change1h: KalshiChange;
  /** Compared against hourly history, so the reference point is 24–25 hours old. */
  change24h: KalshiChange;
  /** Null unless the market is open. */
  uncertainty: number | null;
  /** Hourly implied probability history (0–1), oldest first; null if it failed to load. */
  history: TimePoint[] | null;
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
  result?: string | null;
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
