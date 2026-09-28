import "server-only";

import {
  HOUR_MS,
  impliedProbability,
  mergeSeries,
  probabilityChange,
  uncertaintyScore,
  type TimePoint,
} from "@/lib/analytics";
import { cachedFor, LIVE } from "@/lib/fetch-cache";
import { isTimeout, timeoutSignal } from "@/lib/request-timeout";
import { fail, ok, type Result } from "@/lib/result";
import { marketPhase } from "./status";
import type { KalshiChange, KalshiMarket, KalshiOverview, RawCandlestick, RawEvent, RawMarket } from "./types";

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
    signal: timeoutSignal(),
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
    result: raw.result || null,
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

/** Each series is null if it failed to load, so callers can tell failure from an empty history. */
interface ProbabilityHistory {
  /** Hourly points covering the last HISTORY_DAYS days. */
  hourly: TimePoint[] | null;
  /** Minute points covering the last RECENT_HOURS hours. */
  recent: TimePoint[] | null;
}

export async function getProbabilityHistory(market: KalshiMarket, asOf: number): Promise<ProbabilityHistory> {
  let series: string;
  try {
    series = await getSeriesTicker(market.eventTicker);
  } catch {
    return { hourly: null, recent: null };
  }
  // Align the window to the start of the current minute so identical requests within a
  // minute share one cache entry, instead of writing a new, never-reused entry to the
  // (shared, on Vercel) fetch cache every time. Candles end on minute boundaries and
  // Kalshi includes a candle ending exactly at end_ts, so no completed candle is lost.
  const end = Math.floor(asOf / 60_000) * 60;
  const [hourly, recent] = await Promise.allSettled([
    getCandles(series, market.ticker, end - HISTORY_DAYS * 24 * 60 * 60, end, HOURLY),
    getCandles(series, market.ticker, end - RECENT_HOURS * 60 * 60, end, MINUTE),
  ]);
  return {
    hourly: hourly.status === "fulfilled" ? hourly.value : null,
    recent: recent.status === "fulfilled" ? recent.value : null,
  };
}

/** A probability change, or the reason there isn't one. */
function changeOver(
  history: TimePoint[] | null,
  current: number | null,
  lookbackMs: number,
  asOf: number,
  live: boolean,
): KalshiChange {
  const none = { pp: null, from: null };
  if (!live) return { ...none, unavailable: "market_not_live" };
  if (current === null) return { ...none, unavailable: "no_probability" };
  if (history === null) return { ...none, unavailable: "history_failed" };
  const change = probabilityChange(history, current, lookbackMs, asOf);
  return { ...change, unavailable: change.pp === null ? "not_enough_history" : null };
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
    if (isTimeout(err)) {
      return fail("timeout", "Kalshi didn't respond in time. Please try again shortly.");
    }
    return fail("unavailable", "Could not reach the Kalshi API. Please try again shortly.");
  }

  const fetchedAt = Date.now();
  const phase = marketPhase(market.status);
  // Only an open market has live quotes. Once trading stops, the last trade is a
  // historical price, not a probability, so no live metrics are derived from it.
  const live = phase === "open";

  // History is optional: show the snapshot even if candlesticks fail to load.
  const history = await getProbabilityHistory(market, fetchedAt);

  const { value: probability, source } = live
    ? impliedProbability(market.yesBid, market.yesAsk, market.lastPrice)
    : { value: null, source: "unavailable" as const };

  // Hourly candles alone would compare against a point up to 2 hours old, so the
  // 1h change uses minute candles, merged onto the hourly series in case the market
  // was quiet for the whole minute window. Without minute data, show no 1h change
  // rather than an imprecise one.
  const recent = history.recent === null ? null : mergeSeries(history.hourly ?? [], history.recent);

  return ok({
    market,
    phase,
    closePassed: market.closeTime !== null && Date.parse(market.closeTime) <= fetchedAt,
    probability,
    probabilitySource: source,
    change1h: changeOver(recent, probability, HOUR_MS, fetchedAt, live),
    change24h: changeOver(history.hourly, probability, 24 * HOUR_MS, fetchedAt, live),
    uncertainty: live ? uncertaintyScore(probability) : null,
    history: history.hourly,
    fetchedAt,
  });
}
