import "server-only";

import { LIVE } from "@/lib/fetch-cache";
import { isTimeout } from "@/lib/request-timeout";
import { fail, ok, type Result } from "@/lib/result";
import { toKalshiCandles, type KalshiCandle } from "./candles";
import { KalshiHttpError, kalshiGet } from "./client";
import type { RawHistoricalCandlestick, RawHistoricalCutoff, RawMarket } from "./types";

// Kalshi's archive. Markets settled before the cutoff (GET /historical/cutoff), and their candles,
// are only served by /historical: /markets/{ticker} answers 404 and /markets/candlesticks returns
// nothing for them. The cutoff moves forward over time, so a settled market moves from the live
// endpoints to these. Public and unauthenticated, like the live market-data endpoints.
//
// Responses are never cached by Next.js: a full response is about 2 MB, its limit for a cached
// response, and settled data doesn't change, so callers store it instead.

/**
 * The archive answers 400 ("max candlesticks: 5000") when a request spans more periods than this
 * (the span divided by the period), though the live endpoint allows 10,000.
 */
export const MAX_CANDLES_PER_REQUEST = 5_000;
/** A full 5,000-candle response is about 2 MB, so it gets longer than the usual 6 seconds. */
export const CANDLES_TIMEOUT_MS = 20_000;

export type CandlePeriod = 1 | 60 | 1440;

function describeError(err: unknown, ticker: string | null): Result<never> {
  if (err instanceof KalshiHttpError && err.status === 404) {
    return fail("not_found", `Kalshi's archive has no market with ticker "${ticker}".`);
  }
  if (err instanceof KalshiHttpError && err.status === 429) {
    return fail("rate_limited", "Kalshi rate limit reached. Please wait a moment and try again.");
  }
  if (isTimeout(err)) return fail("timeout", "Kalshi didn't respond in time. Please try again shortly.");
  if (err instanceof RangeError) return fail("invalid_data", "Kalshi returned a price or count outside its valid range.");
  return fail("unavailable", "Could not reach the Kalshi API. Please try again shortly.");
}

export interface HistoricalCutoff {
  /** Markets that settled before this (ms) are only on /historical. */
  marketSettledBefore: number;
}

export async function getHistoricalCutoff(): Promise<Result<HistoricalCutoff>> {
  try {
    const raw = await kalshiGet<RawHistoricalCutoff>("/historical/cutoff", LIVE);
    const marketSettledBefore = Date.parse(raw.market_settled_ts);
    if (!Number.isFinite(marketSettledBefore)) return fail("invalid_data", "Kalshi returned an unreadable archive cutoff.");
    return ok({ marketSettledBefore });
  } catch (err) {
    return describeError(err, null);
  }
}

/** A settled market from the archive, as Kalshi returned it (the same fields as a live market, plus settlement_ts). */
export async function getHistoricalMarket(ticker: string): Promise<Result<RawMarket>> {
  try {
    const { market } = await kalshiGet<{ market: RawMarket }>(`/historical/markets/${encodeURIComponent(ticker)}`, LIVE);
    return ok(market);
  } catch (err) {
    return describeError(err, ticker);
  }
}

export interface CandleWindow {
  /** Candles ending at or after this (Unix seconds). */
  startSec: number;
  /** Candles ending at or before this (Unix seconds). */
  endSec: number;
  periodMinutes: CandlePeriod;
}

/** A settled market's candles in one window, oldest first. The window may hold at most MAX_CANDLES_PER_REQUEST periods. */
export async function getHistoricalCandles(
  ticker: string,
  { startSec, endSec, periodMinutes }: CandleWindow,
): Promise<Result<KalshiCandle[]>> {
  const periods = (endSec - startSec) / (periodMinutes * 60);
  if (!(endSec > startSec) || periods > MAX_CANDLES_PER_REQUEST) {
    throw new RangeError(`A candle window must be 1 to ${MAX_CANDLES_PER_REQUEST} periods long, not ${periods}.`);
  }
  const query = new URLSearchParams({
    start_ts: String(startSec),
    end_ts: String(endSec),
    period_interval: String(periodMinutes),
  });
  try {
    const data = await kalshiGet<{ candlesticks?: RawHistoricalCandlestick[] }>(
      `/historical/markets/${encodeURIComponent(ticker)}/candlesticks?${query}`,
      LIVE,
      CANDLES_TIMEOUT_MS,
    );
    return ok(toKalshiCandles(data.candlesticks ?? []));
  } catch (err) {
    return describeError(err, ticker);
  }
}
