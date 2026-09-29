// Shared contract between the search API routes and the search components.
// Parallel branches build against these types, so change them only by agreement
// (see "Working in parallel" in AGENTS.md).

import type { MarketPhase } from "@/lib/kalshi/status";
import type { DataError } from "@/lib/result";

/** One instrument matching a stock search, e.g. { symbol: "NVDA", name: "NVIDIA Corp", exchange: "NASDAQ", type: "Common Stock" }. */
export interface StockSearchResult {
  /** Ticker to analyze; passes validateStockTicker. */
  symbol: string;
  name: string;
  exchange: string;
  /** Instrument type as the provider names it, e.g. "Common Stock" or "ETF". */
  type: string;
}

/** One Kalshi market matching a search. */
export interface KalshiSearchResult {
  /** Market ticker to analyze (not an event or series ticker); passes validateKalshiTicker. */
  ticker: string;
  /** The market's own title, e.g. "Will the Fed hike 25bps?". */
  title: string;
  /** Title of the event the market belongs to. */
  eventTitle: string;
  /** Kalshi's category for the event, e.g. "Economics". */
  category: string;
  /** Normalized with marketPhase() from lib/kalshi/status. */
  status: MarketPhase;
  /** ISO 8601 time trading closes or closed; null if Kalshi didn't provide one. */
  closeTime: string | null;
  /**
   * Current implied probability (0–1), estimated like the dashboard's headline
   * probability. Null unless the market is open and has a quote or trade.
   */
  probability: number | null;
}

/**
 * 200 response of GET /api/search/stocks?q=… and GET /api/search/kalshi?q=….
 * `query` echoes the validated query, so a client can ignore out-of-order responses.
 */
export interface SearchResponse<T> {
  query: string;
  results: T[];
}

export type StockSearchResponse = SearchResponse<StockSearchResult>;
export type KalshiSearchResponse = SearchResponse<KalshiSearchResult>;

/** Error response of both routes: 400 invalid_query, 429 rate_limited (with Retry-After), 5xx upstream failures. */
export interface SearchErrorResponse {
  error: DataError;
}

// ---- Component props (fixed: TickerForm renders both components with exactly these) ----

interface SearchFieldProps<T> {
  /** The field's text, owned by TickerForm. */
  value: string;
  /**
   * Called with the field's new ticker text whenever it changes: on every edit with
   * `result` null (a typed ticker stays valid input), and with the result's ticker
   * and the result itself when the user picks one.
   */
  onSelect: (ticker: string, result: T | null) => void;
}

export type StockSearchProps = SearchFieldProps<StockSearchResult>;
export type KalshiSearchProps = SearchFieldProps<KalshiSearchResult>;
