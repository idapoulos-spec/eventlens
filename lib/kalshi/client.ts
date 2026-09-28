import "server-only";

import {
  HOUR_MS,
  impliedProbability,
  mergeSeries,
  probabilityChange,
  uncertaintyScore,
  type ProbabilityChange,
  type TimePoint,
} from "@/lib/analytics";
import { cachedFor, LIVE } from "@/lib/fetch-cache";
import { fail, ok, type Result } from "@/lib/result";
import type { KalshiMarket, KalshiOverview, RawCandlestick, RawEvent, RawMarket } from "./types";

// Public, unauthenticated market-data endpoints of the Kalshi Trade API v2.
const KALSHI_BASE_URL = "https://api.elections.kalshi.com/trade-api/v2";
const HISTORY_DAYS = 7;
const RECENT_HOURS = 3;
const HOURLY = 60;
const MINUTE = 1;

class KalshiHttpError extends Error {
  constructor(public status: number) {
    super(`Kalshi API responded with ${status}`);
  }
}

async function kalshiGet<T>(path: string, cache: RequestInit): Promise<T> {
  const res = await fetch(`${KALSHI_BASE_URL}${path}`, {
    ...cache,
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new KalshiHttpError(res.status);
  return res.json() as Promise<T>;
}

function toNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeMarket(raw: RawMarket): KalshiMarket {
  return {
    ticker: raw.ticker,
    eventTicker: raw.event_ticker,
    title: raw.title ?? raw.ticker,
    subtitle: raw.yes_sub_title || raw.subtitle || null,
    status: raw.status ?? "unknown",
    yesBid: toNumber(raw.yes_bid_dollars),
    yesAsk: toNumber(raw.yes_ask_dollars),
    lastPrice: toNumber(raw.last_price_dollars),
    volume24h: toNumber(raw.volume_24h_fp),
    openInterest: toNumber(raw.open_interest_fp),
    closeTime: raw.close_time ?? null,
  };
}

function normalizeCandles(candles: RawCandlestick[]): TimePoint[] {
  const points: TimePoint[] = [];
  for (const c of candles) {
    const { value } = impliedProbability(
      toNumber(c.yes_bid?.close_dollars),
      toNumber(c.yes_ask?.close_dollars),
      toNumber(c.price?.close_dollars),
    );
    if (value !== null) points.push({ t: c.end_period_ts * 1000, value });
  }
  return points.sort((a, b) => a.t - b.t);
}

export async function getMarket(ticker: string): Promise<KalshiMarket> {
  const data = await kalshiGet<{ market: RawMarket }>(`/markets/${encodeURIComponent(ticker)}`, LIVE);
  return normalizeMarket(data.market);
}

/** Candlesticks are keyed by series, so resolve the series via the market's event. */
async function getSeriesTicker(eventTicker: string): Promise<string> {
  const { event } = await kalshiGet<{ event: RawEvent }>(`/events/${encodeURIComponent(eventTicker)}`, cachedFor(3600));
  return event.series_ticker;
}

/** Implied-probability points from candlesticks of `periodMinutes` (1, 60, or 1440). */
async function getCandles(
  seriesTicker: string,
  marketTicker: string,
  startSec: number,
  endSec: number,
  periodMinutes: number,
): Promise<TimePoint[]> {
  const query = new URLSearchParams({
    start_ts: String(startSec),
    end_ts: String(endSec),
    period_interval: String(periodMinutes),
  });
  const data = await kalshiGet<{ candlesticks?: RawCandlestick[] }>(
    `/series/${encodeURIComponent(seriesTicker)}/markets/${encodeURIComponent(marketTicker)}/candlesticks?${query}`,
    cachedFor(60),
  );
  return normalizeCandles(data.candlesticks ?? []);
}

interface ProbabilityHistory {
  /** Hourly points covering the last HISTORY_DAYS days. */
  hourly: TimePoint[];
  /** Minute points covering the last RECENT_HOURS hours, or null if unavailable. */
  recent: TimePoint[] | null;
}

export async function getProbabilityHistory(market: KalshiMarket, asOf: number): Promise<ProbabilityHistory> {
  const series = await getSeriesTicker(market.eventTicker);
  const end = Math.floor(asOf / 1000);
  const [hourly, recent] = await Promise.allSettled([
    getCandles(series, market.ticker, end - HISTORY_DAYS * 24 * 60 * 60, end, HOURLY),
    getCandles(series, market.ticker, end - RECENT_HOURS * 60 * 60, end, MINUTE),
  ]);
  return {
    hourly: hourly.status === "fulfilled" ? hourly.value : [],
    recent: recent.status === "fulfilled" ? recent.value : null,
  };
}

/** Market snapshot, history, and derived metrics for one Kalshi market. */
export async function getKalshiOverview(ticker: string): Promise<Result<KalshiOverview>> {
  let market: KalshiMarket;
  try {
    market = await getMarket(ticker);
  } catch (err) {
    if (err instanceof KalshiHttpError && err.status === 404) {
      return fail("not_found", `No Kalshi market found with ticker "${ticker}". Use a market ticker, not an event or series ticker.`);
    }
    if (err instanceof KalshiHttpError && err.status === 429) {
      return fail("rate_limited", "Kalshi rate limit reached. Please wait a moment and try again.");
    }
    return fail("unavailable", "Could not reach the Kalshi API. Please try again shortly.");
  }

  const fetchedAt = Date.now();

  // History is optional: show the snapshot even if candlesticks are unavailable.
  let history: ProbabilityHistory = { hourly: [], recent: null };
  try {
    history = await getProbabilityHistory(market, fetchedAt);
  } catch {
    // Keep the empty history.
  }

  const { value: probability, source } = impliedProbability(market.yesBid, market.yesAsk, market.lastPrice);

  // Hourly candles alone would compare against a point up to 2 hours old, so the
  // 1h change uses minute candles, merged onto the hourly series in case the market
  // was quiet for the whole minute window. Without minute data, show no 1h change
  // rather than an imprecise one.
  const change1h: ProbabilityChange = history.recent
    ? probabilityChange(mergeSeries(history.hourly, history.recent), probability, HOUR_MS, fetchedAt)
    : { pp: null, from: null };

  return ok({
    market,
    probability,
    probabilitySource: source,
    change1h,
    change24h: probabilityChange(history.hourly, probability, 24 * HOUR_MS, fetchedAt),
    uncertainty: uncertaintyScore(probability),
    history: history.hourly,
    fetchedAt,
  });
}
