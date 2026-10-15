// Types of the app's read path: the data store first, the live APIs for what it doesn't cover.
// New types live here rather than in lib/kalshi/types.ts or lib/market-data/types.ts, which the
// dashboard shares.

import type { KalshiMarket, KalshiPoint } from "@/lib/kalshi/types";
import type { StockBar } from "@/lib/market-data/types";

/** A Kalshi market, and whether it came from the live endpoints. */
export interface FoundMarket {
  market: KalshiMarket;
  /**
   * Settled before Kalshi's archive cutoff: the live endpoints answer 404, so the market came
   * from the store or the archive, and its candles are only on /historical.
   */
  archived: boolean;
}

/** Where Research's window ends, and where its longer windows can start. */
export interface ResearchWindow {
  /** A closed market's close time (ms): Research ends there. Null: Research ends now. */
  end: number | null;
  archived: boolean;
  /**
   * When the market opened (for an event, its first outcome), ms; null if unknown. Research's
   * longer windows start no earlier: nothing before it is the market's.
   */
  start: number | null;
}

/** Where Research's Kalshi history came from, for the Sources note. */
export interface Provenance {
  /** Stored candles cover the window up to this time (ms); null if none were used. */
  storedThrough: number | null;
  /** Live candles were fetched from this time on (ms); null if none were. */
  liveFrom: number | null;
  /** The live candles after `storedThrough` failed to load, so the history ends there. */
  liveFailed: boolean;
}

/** Research's hourly Kalshi probabilities, oldest first, and where they came from. */
export interface ResearchHistory {
  points: KalshiPoint[];
  provenance: Provenance;
}

/** The stock bars Research lines Kalshi up with. */
export interface ResearchBars {
  /** Where Research's window ends (ms), or null for now. */
  end: number | null;
  /** Close-stamped 30-minute bars, oldest first. */
  halfHourly: StockBar[];
  /** Daily bars stamped at 00:00 UTC of their trading date, oldest first: those the 7, 30, and 90-day windows read. */
  daily: StockBar[];
  /** Every daily bar since `longStart`, for the longer windows; the 30-minute bars reach back as far. */
  longDaily: StockBar[];
  /** Where the bars for the longer windows start (ms): see longHistoryStart. */
  longStart: number;
}

/** Research's hourly Kalshi points for its longer windows, and where those windows can start. */
export interface LongHistory {
  /** From a week before `start`, so the probability in effect at `start` is known. */
  points: KalshiPoint[];
  /** The longer windows start here (ms): the market's open, or LONG_HISTORY_MS before the window's end. */
  start: number;
  provenance: Provenance;
}
