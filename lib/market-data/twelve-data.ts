import "server-only";

import { realizedVolatility } from "@/lib/analytics";
import { fail, ok, type Result } from "@/lib/result";
import type { RawError, RawQuote, RawTimeSeries, StockBar, StockOverview, StockQuote } from "./types";

const TWELVE_DATA_BASE_URL = "https://api.twelvedata.com";
const HOUR_MS = 60 * 60 * 1000;
const VOL_WINDOW_DAYS = 30;

type Interval = "1h" | "1day";

class TwelveDataError extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(message);
  }
}

function getApiKey(): string | null {
  const key = process.env.TWELVE_DATA_API_KEY?.trim();
  return key ? key : null;
}

async function twelveGet<T>(path: string, params: Record<string, string>, apiKey: string): Promise<T> {
  const query = new URLSearchParams({ ...params, apikey: apiKey });
  const res = await fetch(`${TWELVE_DATA_BASE_URL}${path}?${query}`, { next: { revalidate: 60 } });
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

/** Twelve Data returns bar open times, newest first. Convert to close times, oldest first. */
function normalizeSeries(raw: RawTimeSeries, interval: Interval): StockBar[] {
  const barMs = interval === "1h" ? HOUR_MS : 0;
  return raw.values
    .map((v) => {
      // Requested with timezone=UTC, so datetimes are UTC ("YYYY-MM-DD" or "YYYY-MM-DD HH:mm:ss").
      const iso = v.datetime.length > 10 ? `${v.datetime.replace(" ", "T")}Z` : `${v.datetime}T00:00:00Z`;
      return {
        t: Date.parse(iso) + barMs,
        open: Number(v.open),
        high: Number(v.high),
        low: Number(v.low),
        close: Number(v.close),
        volume: num(v.volume),
      };
    })
    .filter((b) => Number.isFinite(b.t) && Number.isFinite(b.close))
    .sort((a, b) => a.t - b.t);
}

function getTimeSeries(symbol: string, interval: Interval, outputsize: number, apiKey: string) {
  return twelveGet<RawTimeSeries>(
    "/time_series",
    { symbol, interval, outputsize: String(outputsize), timezone: "UTC" },
    apiKey,
  ).then((raw) => normalizeSeries(raw, interval));
}

function describeError(err: unknown, symbol: string): Result<never> {
  if (err instanceof TwelveDataError) {
    if (err.code === 401 || err.code === 403) {
      return fail("auth", `Twelve Data rejected the request: ${err.message.replace(/\*\*/g, "")}`);
    }
    if (err.code === 404 || (err.code === 400 && /symbol/i.test(err.message))) {
      return fail("not_found", `Twelve Data has no data for "${symbol}". Check the ticker symbol.`);
    }
    if (err.code === 429) {
      return fail("rate_limited", "Twelve Data rate limit reached (the free plan allows 8 requests per minute). Try again in a minute.");
    }
    return fail("upstream", `Twelve Data error: ${err.message}`);
  }
  return fail("unavailable", "Could not reach Twelve Data. Please try again shortly.");
}

/** Quote, intraday and daily history, and realized volatility for one stock. */
export async function getStockOverview(symbol: string): Promise<Result<StockOverview>> {
  const apiKey = getApiKey();
  if (!apiKey) {
    return fail(
      "missing_key",
      "Stock data is disabled because TWELVE_DATA_API_KEY is not set. Add it to .env.local and restart the dev server.",
    );
  }

  try {
    const [rawQuote, intraday, daily] = await Promise.all([
      twelveGet<RawQuote>("/quote", { symbol }, apiKey),
      getTimeSeries(symbol, "1h", 70, apiKey),
      getTimeSeries(symbol, "1day", 90, apiKey),
    ]);

    const volWindow = daily.slice(-(VOL_WINDOW_DAYS + 1)).map((b) => b.close);

    return ok({
      quote: normalizeQuote(rawQuote),
      intraday,
      daily,
      realizedVol30d: realizedVolatility(volWindow),
      fetchedAt: Date.now(),
    });
  } catch (err) {
    return describeError(err, symbol);
  }
}
