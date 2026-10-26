import "server-only";

import { realizedVolatility, relativeVolume } from "@/lib/analytics";
import { LIVE } from "@/lib/fetch-cache";
import { readStoredStockWindow } from "@/lib/history/stocks";
import { readStore } from "@/lib/history/store";
import type { ResearchBars, ResearchWindow } from "@/lib/history/types";
import { LIVE_WINDOW, longHistoryStart, STOCK_HISTORY_MS, stockHistoryStart } from "@/lib/history/window";
import { isTimeout, REQUEST_TIMEOUT_MS } from "@/lib/request-timeout";
import { fail, ok, type Result } from "@/lib/result";
import { memoryCache } from "./memory-cache";
import { adjustIntradayForSplits, barCloseTime, sessionCloseTimes, toHourlyBars, tradingDayClose } from "./session";
import type { RawError, RawQuote, RawTimeSeries, StockBar, StockOverview, StockQuote } from "./types";

const TWELVE_DATA_BASE_URL = "https://api.twelvedata.com";
const HALF_HOUR_MS = 30 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const VOL_WINDOW_DAYS = 30;
// A time series costs one API credit whatever its length (up to MAX_BARS), so a stock's 30-minute
// and daily bars reach back as far as Research's longer windows need (stockHistoryStart).
// Hourly bars for the 7-day comparison chart: about 10 sessions, as before.
const HOURLY_BARS = 70;
/** Daily bars on the stock panel's chart. */
export const DAILY_BARS = 90;
/** The daily request reaches back at least this far, so the panel always has its DAILY_BARS. */
const PANEL_DAILY_MS = 140 * DAY_MS;
/** The most bars one time series request returns; still one credit. */
export const MAX_BARS = 5000;
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

/** Dates bounding a time series request, "YYYY-MM-DD": the latest `outputsize` bars between them. */
export interface SeriesDates {
  startDate?: string;
  endDate?: string;
}

/** The UTC date of a time, as start_date and end_date take it. */
export const utcDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Dates around a research window ending at `end` whose bars start at `from`: to the day after the
 * end, so whichever time zone Twelve Data reads them in, every bar up to `end` is included.
 */
export function windowDates(end: number, from: number): SeriesDates {
  return { startDate: utcDate(from), endDate: utcDate(end + DAY_MS) };
}

/** 00:00 UTC of the date `startDate` names. */
const dateStart = (ms: number) => Date.parse(`${utcDate(ms)}T00:00:00Z`);

/**
 * One symbol's bars, oldest first, intraday bars stamped at their close. One API credit
 * whatever the length. Never from Next.js's data cache: callers keep bars in memory along
 * with when they were fetched (see memoryCache), since which bars are final depends on it.
 */
export function getTimeSeries(symbol: string, interval: Interval, outputsize: number, apiKey: string, dates: SeriesDates = {}) {
  return twelveGet<RawTimeSeries>(
    "/time_series",
    {
      symbol,
      interval,
      outputsize: String(outputsize),
      timezone: "UTC",
      ...(dates.startDate && { start_date: dates.startDate }),
      ...(dates.endDate && { end_date: dates.endDate }),
    },
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
  /** Every daily bar since the bars' start: the latest ones serve the panel. */
  daily: Series;
  /** The daily bars the 7, 30, and 90-day windows read when they aren't the panel's: a past window's. */
  researchDaily: StockBar[] | null;
  /** When the bars were requested (ms): bars that hadn't closed by then may still have been forming. */
  fetchedAt: number;
  /** Where the bars start (ms): they serve any request whose history starts no earlier. */
  from: number;
}

const historyCache = memoryCache<StockHistory>(50);

/** Intraday bars on the daily bars' split-adjusted basis (see adjustIntradayForSplits). */
const splitAdjusted = (halfHourly: Series, daily: Series): Series => ({ ...halfHourly, bars: adjustIntradayForSplits(halfHourly.bars, daily.bars) });

/**
 * A stock's 30-minute and daily bars: from memory if fetched within STOCK_HISTORY_TTL_MS and
 * reaching back far enough, otherwise 2 credits. They start where Research's longer windows need
 * them (stockHistoryStart: the market's open, at most LONG_HISTORY_MS back, at least
 * STOCK_HISTORY_MS); for Research ending in the past (`end`, a closed market's close), the
 * 30-minute bars end there, and the daily bars reach today, so the panel and Research still share
 * 2 credits. Stored bars replace the requests whose window the store covers completely.
 */
function getStockHistory(symbol: string, apiKey: string, { end, start }: Pick<ResearchWindow, "end" | "start">): Promise<Result<StockHistory>> {
  const load =
    end === null
      ? async () => {
          const fetchedAt = Date.now();
          const from = stockHistoryStart(start, fetchedAt);
          try {
            const [halfHourly, daily] = await Promise.all([
              getTimeSeries(symbol, "30min", MAX_BARS, apiKey, { startDate: utcDate(from) }),
              getTimeSeries(symbol, "1day", MAX_BARS, apiKey, { startDate: utcDate(Math.min(from, fetchedAt - PANEL_DAILY_MS)) }),
            ]);
            return ok({ halfHourly: splitAdjusted(halfHourly, daily), daily, researchDaily: null, fetchedAt, from });
          } catch (err) {
            return describeError(err, symbol, apiKey);
          }
        }
      : () => getWindowHistory(symbol, apiKey, end, stockHistoryStart(start, end));
  return historyCache(
    end === null ? symbol : `${symbol}@${end}`,
    load,
    (history) => history.fetchedAt + STOCK_HISTORY_TTL_MS,
    (history) => history.from <= stockHistoryStart(start, end ?? Date.now()),
  );
}

async function getWindowHistory(symbol: string, apiKey: string, end: number, from: number): Promise<Result<StockHistory>> {
  const range = { from, to: end + 1 };
  const [storedHalfHourly, storedDaily] =
    (await readStore("stock bars", (sql) =>
      Promise.all([readStoredStockWindow(sql, symbol, "30min", range), readStoredStockWindow(sql, symbol, "1day", range)]),
    )) ?? [null, null];
  const fetchedAt = Date.now();
  try {
    const [halfHourly, daily] = await Promise.all([
      storedHalfHourly ?? getTimeSeries(symbol, "30min", MAX_BARS, apiKey, windowDates(end, from)),
      storedDaily
        ? getTimeSeries(symbol, "1day", DAILY_BARS, apiKey)
        : getTimeSeries(symbol, "1day", MAX_BARS, apiKey, { startDate: utcDate(from) }),
    ]);
    const allDaily = storedDaily ?? daily;
    // The 7, 30, and 90-day windows read the daily bars from STOCK_HISTORY_MS before the end, as they always have.
    const researchDaily = allDaily.bars.filter((b) => b.t >= dateStart(end - STOCK_HISTORY_MS));
    return ok({ halfHourly: splitAdjusted(halfHourly, allDaily), daily, researchDaily, fetchedAt, from });
  } catch (err) {
    return describeError(err, symbol, apiKey);
  }
}

/** The overview, plus the bars Research reads. */
export interface StockAnalysis extends StockOverview {
  research: ResearchBars;
}

/**
 * Quote, intraday and daily history, and realized volatility for one stock. The quote is
 * requested at once; the history waits for `researchWindow`, which says whether Research ends
 * now or at a closed market's close (it resolves at once without the store).
 */
export async function getStockOverview(
  symbol: string,
  researchWindow: ResearchWindow | Promise<ResearchWindow> = LIVE_WINDOW,
): Promise<Result<StockAnalysis>> {
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
    const [rawQuote, { end, start, frozen, history }] = await Promise.all([
      twelveGet<RawQuote>("/quote", { symbol }, apiKey, LIVE),
      Promise.resolve(researchWindow).then(async ({ end, start, frozen }) => ({ end, start, frozen, history: await getStockHistory(symbol, apiKey, { end, start }) })),
    ]);
    if (!history.ok) return history;
    const { halfHourly, daily: allDaily, researchDaily, fetchedAt: historyFetchedAt, from } = history.data;

    const quote = normalizeQuote(rawQuote);
    // A day's bar is still forming until its session ends, and its close is just the latest
    // price, so daily history (the close chart and volatility) uses completed sessions only:
    // not the quote's session while the market is open, nor a session that hadn't ended
    // when the bars were fetched (bars in memory from just before the close).
    const session = rawQuote.datetime ? parseDatetime(rawQuote.datetime) : null;
    const closes = sessionCloseTimes(halfHourly.bars);
    const completed = (b: StockBar) => !(quote.isMarketOpen && b.t === session) && (closes.get(b.t) ?? tradingDayClose(b.t)) <= historyFetchedAt;
    const daily = allDaily.bars.slice(-DAILY_BARS).filter(completed);
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
      research: {
        end,
        ...(frozen && { frozen }),
        halfHourly: halfHourly.bars,
        daily: researchDaily ?? daily,
        // A past window's bars after its end are left out later (researchStockPoints); a live one's forming session now.
        longDaily: end === null ? allDaily.bars.filter((b) => b.t >= dateStart(from) && completed(b)) : allDaily.bars,
        longStart: longHistoryStart(start, end ?? historyFetchedAt),
      },
    });
  } catch (err) {
    return describeError(err, symbol, apiKey);
  }
}
