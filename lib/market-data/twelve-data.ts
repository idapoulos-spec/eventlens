import "server-only";

import { realizedVolatility, relativeVolume } from "@/lib/analytics";
import { LIVE } from "@/lib/fetch-cache";
import { isTimeout, REQUEST_TIMEOUT_MS } from "@/lib/request-timeout";
import { fail, ok, type Result } from "@/lib/result";
import { memoryCache } from "./memory-cache";
import { barCloseTime, sessionCloseTimes, toHourlyBars, tradingDayClose } from "./session";
import type { RawError, RawQuote, RawTimeSeries, StockBar, StockOverview, StockQuote } from "./types";

const TWELVE_DATA_BASE_URL = "https://api.twelvedata.com";
const HALF_HOUR_MS = 30 * 60 * 1000;
const VOL_WINDOW_DAYS = 30;
// 900 half-hour bars is about 70 sessions (13 a day), enough for the 90-day research window.
// A time series costs one API credit whatever its length.
export const HALF_HOURLY_BARS = 900;
// Hourly bars for the 7-day comparison chart: about 10 sessions, as before.
const HOURLY_BARS = 70;
export const DAILY_BARS = 90;
/**
 * Price history is kept in this server instance's memory for this long after it was
 * fetched, so analyzing the same stock again within a minute costs only the quote.
 */
export const STOCK_HISTORY_TTL_MS = 60 * 1000;

export type Interval = "30min" | "1day";

export class TwelveDataError extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(message);
  }
}

let warnedMissingKey = false;

export function getApiKey(): string | null {
  const key = process.env.TWELVE_DATA_API_KEY?.trim();
  if (!key && !warnedMissingKey) {
    // Setup instructions are for whoever runs the site, so they go to the server log, not the page.
    console.warn(
      "[twelve-data] TWELVE_DATA_API_KEY is not set, so stock data is disabled. Add it to .env.local when " +
        "running locally, or to the project's Environment Variables on Vercel, then restart or redeploy.",
    );
    warnedMissingKey = true;
  }
  return key ? key : null;
}

export async function twelveGet<T>(
  path: string,
  params: Record<string, string>,
  apiKey: string,
  cache: RequestInit,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<T> {
  // The key goes in a header, not the URL, so it never appears in cached URLs or logs.
  const res = await fetch(`${TWELVE_DATA_BASE_URL}${path}?${new URLSearchParams(params)}`, {
    ...cache,
    headers: { Authorization: `apikey ${apiKey}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = (await res.json().catch(() => null)) as T | RawError | null;
  if (!body) throw new TwelveDataError(res.status, "Invalid response from Twelve Data");
  // Twelve Data reports errors in the body, sometimes with HTTP 200.
  if ((body as RawError).status === "error") {
    const err = body as RawError;
    throw new TwelveDataError(err.code, err.message);
  }
  if (!res.ok) throw new TwelveDataError(res.status, `Twelve Data responded with ${res.status}`);
  return body as T;
}

/** Twelve Data datetime ("YYYY-MM-DD" or "YYYY-MM-DD HH:mm:ss", read as UTC) in milliseconds. */
export function parseDatetime(datetime: string): number {
  return Date.parse(datetime.length > 10 ? `${datetime.replace(" ", "T")}Z` : `${datetime}T00:00:00Z`);
}

function num(value: string | undefined): number | null {
  if (value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeQuote(raw: RawQuote): StockQuote {
  return {
    symbol: raw.symbol,
    name: raw.name ?? raw.symbol,
    exchange: raw.exchange ?? "",
    currency: raw.currency ?? "USD",
    price: Number(raw.close),
    change: num(raw.change),
    percentChange: num(raw.percent_change),
    previousClose: num(raw.previous_close),
    volume: num(raw.volume),
    averageVolume: num(raw.average_volume),
    isMarketOpen: raw.is_market_open ?? false,
  };
}

export interface Series {
  bars: StockBar[];
  exchangeTimeZone: string | undefined;
}

/**
 * Twelve Data returns bar open times, newest first. Stamp intraday bars at their
 * close time (see barCloseTime) and return them oldest first.
 */
export function normalizeSeries(raw: RawTimeSeries, interval: Interval): Series {
  const exchangeTimeZone = raw.meta?.exchange_timezone;
  const bars = raw.values
    .map((v) => {
      // Requested with timezone=UTC, so datetimes are UTC.
      const open = parseDatetime(v.datetime);
      return {
        t: interval === "30min" ? barCloseTime(open, HALF_HOUR_MS, exchangeTimeZone) : open,
        open: Number(v.open),
        high: Number(v.high),
        low: Number(v.low),
        close: Number(v.close),
        volume: num(v.volume),
      };
    })
    .filter((b) => Number.isFinite(b.t) && Number.isFinite(b.close))
    .sort((a, b) => a.t - b.t);
  return { bars, exchangeTimeZone };
}

/**
 * One symbol's bars, oldest first, intraday bars stamped at their close. One API credit
 * whatever the length. Never from Next.js's data cache: callers keep bars in memory along
 * with when they were fetched (see memoryCache), since which bars are final depends on it.
 */
export function getTimeSeries(symbol: string, interval: Interval, outputsize: number, apiKey: string) {
  return twelveGet<RawTimeSeries>(
    "/time_series",
    { symbol, interval, outputsize: String(outputsize), timezone: "UTC" },
    apiKey,
    LIVE,
  ).then((raw) => normalizeSeries(raw, interval));
}

/**
 * Map a failure to fixed, user-facing wording. Twelve Data's own error text is
 * logged on the server only, with the key redacted, and never shown to users.
 */
export function describeError(err: unknown, symbol: string, apiKey: string): Result<never> {
  const status = err instanceof TwelveDataError ? err.code : "network";
  const detail = err instanceof Error ? err.message : String(err);
  console.error(`[twelve-data] ${symbol}: ${status} ${detail.replaceAll(apiKey, "[redacted]")}`);

  if (isTimeout(err)) {
    return fail("timeout", "Twelve Data didn't respond in time. Please try again shortly.");
  }
  if (!(err instanceof TwelveDataError)) {
    return fail("unavailable", "Could not reach Twelve Data. Please try again shortly.");
  }
  if (err.code === 401) {
    return fail("auth", "Twelve Data rejected this app's API key, so stock data is unavailable.");
  }
  if (err.code === 403) {
    return fail("plan", `"${symbol}" is not included in this app's Twelve Data plan.`);
  }
  if (err.code === 404 || (err.code === 400 && /symbol/i.test(err.message))) {
    return fail("not_found", `Twelve Data has no data for "${symbol}". Check the ticker symbol.`);
  }
  if (err.code === 429) {
    return fail("rate_limited", "Twelve Data rate limit reached (the free plan allows 8 requests per minute). Try again in a minute.");
  }
  return fail("upstream", "Twelve Data returned an error. Please try again later.");
}

interface StockHistory {
  halfHourly: Series;
  daily: Series;
  /** When the bars were requested (ms): bars that hadn't closed by then may still have been forming. */
  fetchedAt: number;
}

const historyCache = memoryCache<StockHistory>(50);

/** A stock's 30-minute and daily bars: from memory if fetched within STOCK_HISTORY_TTL_MS, otherwise 2 credits. */
function getStockHistory(symbol: string, apiKey: string): Promise<Result<StockHistory>> {
  return historyCache(
    symbol,
    async () => {
      const fetchedAt = Date.now();
      try {
        const [halfHourly, daily] = await Promise.all([
          getTimeSeries(symbol, "30min", HALF_HOURLY_BARS, apiKey),
          getTimeSeries(symbol, "1day", DAILY_BARS, apiKey),
        ]);
        return ok({ halfHourly, daily, fetchedAt });
      } catch (err) {
        return describeError(err, symbol, apiKey);
      }
    },
    (history) => history.fetchedAt + STOCK_HISTORY_TTL_MS,
  );
}

/** Quote, intraday and daily history, and realized volatility for one stock. */
export async function getStockOverview(symbol: string): Promise<Result<StockOverview>> {
  const apiKey = getApiKey();
  if (!apiKey) {
    return fail(
      "missing_key",
      "Stock prices aren't available because this site hasn't been set up with a market-data API key. Kalshi data still works.",
    );
  }

  try {
    // Half-hour bars serve both the hourly comparison chart (combined into Twelve Data's
    // hourly bars) and research, whose top-of-hour closes line up with Kalshi's hourly
    // candles, so research costs no extra API credit. The quote is always fetched fresh.
    const [rawQuote, history] = await Promise.all([
      twelveGet<RawQuote>("/quote", { symbol }, apiKey, LIVE),
      getStockHistory(symbol, apiKey),
    ]);
    if (!history.ok) return history;
    const { halfHourly, daily: allDaily, fetchedAt: historyFetchedAt } = history.data;

    const quote = normalizeQuote(rawQuote);
    // A day's bar is still forming until its session ends, and its close is just the latest
    // price, so daily history (the close chart and volatility) uses completed sessions only:
    // not the quote's session while the market is open, nor a session that hadn't ended
    // when the bars were fetched (bars in memory from just before the close).
    const session = rawQuote.datetime ? parseDatetime(rawQuote.datetime) : null;
    const closes = sessionCloseTimes(halfHourly.bars);
    const daily = allDaily.bars.filter(
      (b) => !(quote.isMarketOpen && b.t === session) && (closes.get(b.t) ?? tradingDayClose(b.t)) <= historyFetchedAt,
    );
    const volWindow = daily.slice(-(VOL_WINDOW_DAYS + 1)).map((b) => b.close);

    return ok({
      quote,
      intraday: toHourlyBars(halfHourly.bars, HALF_HOUR_MS, halfHourly.exchangeTimeZone).slice(-HOURLY_BARS),
      halfHourly: halfHourly.bars,
      daily,
      realizedVol30d: realizedVolatility(volWindow),
      // Today's volume isn't comparable with a full-day average until the session ends.
      relativeVolume: quote.isMarketOpen ? null : relativeVolume(quote.volume, quote.averageVolume),
      historyFetchedAt,
      fetchedAt: Date.now(),
    });
  } catch (err) {
    return describeError(err, symbol, apiKey);
  }
}
