// Kalshi requests for the collector: market lists, markets, and candles, from the live endpoints
// or the archive (markets settled before Kalshi's cutoff). Requests go one at a time, at most
// 4 a second, and are retried when Kalshi limits them or doesn't answer. Every attempt is counted
// for collection_runs.requests. Failures are fixed codes, never an upstream message or a URL,
// because collector logs are public.

import { LIVE } from "@/lib/fetch-cache";
import { toKalshiCandles, type KalshiCandle } from "@/lib/kalshi/candles";
import { KalshiHttpError, kalshiGet } from "@/lib/kalshi/client";
import { CANDLES_TIMEOUT_MS, getHistoricalCandles, getHistoricalMarket, type CandlePeriod } from "@/lib/kalshi/historical";
import type { RawMarket, RawMarketCandlesticks } from "@/lib/kalshi/types";
import { isTimeout } from "@/lib/request-timeout";
import { fail, ok, type Result } from "@/lib/result";
import type { TimeRange } from "@/lib/store/runs";
import type { KalshiPeriod, KalshiSource } from "@/lib/store/schema";

/** Kalshi's Basic tier allows 20 reads a second; the collector uses at most 4. */
export const MIN_REQUEST_GAP_MS = 250;
/** The wait before each retry, by error code. Other errors (not_found, invalid_data, archived) aren't retried. */
export const RETRY_DELAYS_MS: Readonly<Record<string, readonly number[]>> = {
  rate_limited: [2_000, 5_000, 10_000],
  timeout: [2_000],
  unavailable: [2_000],
};
const PAGE_SIZE = 1000;
/** Guards against a cursor that never ends. KXFEDDECISION fits on one page. */
const MAX_PAGES = 100;

function failure(err: unknown): Result<never> {
  if (err instanceof KalshiHttpError && err.status === 404) return fail("not_found", "Kalshi has no such market.");
  if (err instanceof KalshiHttpError && err.status === 429) return fail("rate_limited", "Kalshi rate limit reached.");
  if (isTimeout(err)) return fail("timeout", "Kalshi didn't respond in time.");
  if (err instanceof RangeError) return fail("invalid_data", "Kalshi returned a price or count outside its valid range.");
  return fail("unavailable", "Could not reach the Kalshi API.");
}

/** Lists markets by series or by event. */
export type MarketFilter = { series_ticker: string } | { event_ticker: string };

export interface KalshiApi {
  /** Requests sent so far, retries included. */
  readonly requests: number;
  listMarkets(source: KalshiSource, filter: MarketFilter): Promise<Result<RawMarket[]>>;
  /** One market; fails with `not_found` if that endpoint doesn't have it. */
  getMarket(source: KalshiSource, ticker: string): Promise<Result<RawMarket>>;
  /**
   * A market's candles ending in `window` ([from, to), whole seconds), oldest first. From the live
   * endpoint, fails with `archived` if Kalshi has moved the market to its archive.
   */
  getCandles(source: KalshiSource, ticker: string, period: KalshiPeriod, window: TimeRange): Promise<Result<KalshiCandle[]>>;
}

export interface KalshiApiOptions {
  /** Injected so tests don't wait. */
  sleep?: (ms: number) => Promise<void>;
  clock?: () => number;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createKalshiApi({ sleep = wait, clock = Date.now }: KalshiApiOptions = {}): KalshiApi {
  let requests = 0;
  let lastStart = -Infinity;

  /** Sends a request, paced, and retries it as RETRY_DELAYS_MS says. */
  async function send<T>(request: () => Promise<Result<T>>): Promise<Result<T>> {
    for (let retries = 0; ; retries++) {
      const pause = lastStart + MIN_REQUEST_GAP_MS - clock();
      if (pause > 0) await sleep(pause);
      lastStart = clock();
      requests++;
      const result = await request();
      const delay = result.ok ? undefined : RETRY_DELAYS_MS[result.error.code]?.[retries];
      if (delay === undefined) return result;
      await sleep(delay);
    }
  }

  function get<T>(path: string, timeoutMs?: number): Promise<Result<T>> {
    return send(async () => {
      try {
        return ok(await kalshiGet<T>(path, LIVE, timeoutMs));
      } catch (err) {
        return failure(err);
      }
    });
  }

  function liveCandles(ticker: string, period: KalshiPeriod, startSec: number, endSec: number): Promise<Result<KalshiCandle[]>> {
    const query = new URLSearchParams({
      market_tickers: ticker,
      start_ts: String(startSec),
      end_ts: String(endSec),
      period_interval: period,
    });
    return send(async () => {
      try {
        const data = await kalshiGet<{ markets?: RawMarketCandlesticks[] }>(`/markets/candlesticks?${query}`, LIVE, CANDLES_TIMEOUT_MS);
        // For a window without candles the market is listed with none; for a market moved to the
        // archive it isn't listed at all.
        const market = data.markets?.find((m) => m.market_ticker === ticker);
        if (!market) return fail("archived", "Kalshi has moved this market to its archive.");
        return ok(toKalshiCandles(market.candlesticks ?? []));
      } catch (err) {
        return failure(err);
      }
    });
  }

  return {
    get requests() {
      return requests;
    },

    async listMarkets(source, filter) {
      const path = source === "live" ? "/markets" : "/historical/markets";
      const markets: RawMarket[] = [];
      let cursor = "";
      for (let page = 0; page < MAX_PAGES; page++) {
        const query = new URLSearchParams({ ...filter, limit: String(PAGE_SIZE), ...(cursor ? { cursor } : {}) });
        const result = await get<{ markets?: RawMarket[]; cursor?: string }>(`${path}?${query}`);
        if (!result.ok) return result;
        markets.push(...(result.data.markets ?? []));
        cursor = result.data.cursor ?? "";
        if (!cursor) return ok(markets);
      }
      return fail("unavailable", "Kalshi's market list didn't end.");
    },

    async getMarket(source, ticker) {
      if (source === "historical") return send(() => getHistoricalMarket(ticker));
      const result = await get<{ market: RawMarket }>(`/markets/${encodeURIComponent(ticker)}`);
      return result.ok ? ok(result.data.market) : result;
    },

    async getCandles(source, ticker, period, window) {
      const startSec = Math.floor(window.from / 1000);
      const endSec = Math.floor(window.to / 1000);
      const result =
        source === "historical"
          ? await send(() => getHistoricalCandles(ticker, { startSec, endSec, periodMinutes: Number(period) as CandlePeriod }))
          : await liveCandles(ticker, period, startSec, endSec);
      // Kalshi includes a candle ending exactly at end_ts; it belongs to the next window.
      return result.ok ? ok(result.data.filter((c) => c.endTs >= window.from && c.endTs < window.to)) : result;
    },
  };
}
