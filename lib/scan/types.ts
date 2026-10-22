// What the scan's routes hand the page. Plain data, compact where it's large (bars and Kalshi
// histories), since a scan moves one stock's bars once and many candidates' histories.

import type { ExpectedPoint } from "@/lib/analytics/research";
import type { KalshiPoint } from "@/lib/kalshi/types";
import type { BenchmarkSeries } from "@/lib/market-data/types";
import type { DataError } from "@/lib/result";

export const SCAN_CANDIDATES_PATH = "/api/scan/candidates";
export const SCAN_PRICES_PATH = "/api/scan/prices";
export const SCAN_CANDIDATE_PATH = "/api/scan/candidate";

/** One thing a scan tests: an event's expected value, or one market's probability. */
export interface ScanCandidate {
  /** What's tested: the event (expected value) or the market. */
  ticker: string;
  kind: "event" | "market";
  /** The event it belongs to (for a market), or itself. */
  event: string;
  series: string | null;
  /** The event's title, or the market's. */
  title: string;
  /** For a market: its outcome label (e.g. "Above 3.5%"). */
  label: string | null;
  /**
   * The market stands in for an event with several outcomes and no expected value: the outcome
   * with the highest lifetime volume, picked from the listing before any stock data loads.
   */
  picked: { outcomes: number } | null;
  /** Research ends here (ms): its close, once that has passed; null while it's open (Research ends now). */
  end: number | null;
  /** When it opened (ms; an event's first outcome), or null if unknown: no window reaches further back. */
  start: number | null;
  /** In the data store (its history reads from there first). */
  stored: boolean;
}

/** Bars as parallel arrays: times (ms, close-stamped for 30-minute bars) and closes. */
export interface CompactBars {
  t: number[];
  close: number[];
}

/** GET /api/scan/prices: the stock's bars and the benchmark's closes over the scan's span, once. */
export interface ScanPrices {
  symbol: string;
  /** Split-adjusted like the pages' (adjustIntradayForSplits). */
  halfHourly: CompactBars;
  daily: CompactBars;
  /** When the stock's bars were fetched: bars that hadn't settled by then are left out. */
  fetchedAt: number;
  benchmark: BenchmarkSeries;
  /** Twelve Data requests this call made (1 credit each); 0 when everything was in memory. */
  requests: number;
}

/** GET /api/scan/candidate: one candidate's Kalshi side, read as its own page reads it. */
export type ScanKalshi =
  | {
      kind: "market";
      /** Hourly probabilities for the 7, 30, and 90-day windows (97 days to the window's end). */
      points: KalshiPoint[];
      closeTime: number | null;
      /** For 180D, 1Y, and All: null when the market is no older than 90 days. */
      long: { points: KalshiPoint[]; start: number } | null;
      end: number | null;
      start: number | null;
    }
  | {
      kind: "event";
      marks: ExpectedPoint[];
      long: { marks: ExpectedPoint[]; start: number } | null;
      end: number | null;
      start: number | null;
    };

export interface ScanErrorResponse {
  error: DataError;
}
