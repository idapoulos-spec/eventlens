import "server-only";

import { HOUR_MS, impliedProbability, probabilityChange, uncertaintyScore } from "@/lib/analytics";
import { cachedFor, LIVE } from "@/lib/fetch-cache";
import { isTimeout, timeoutSignal } from "@/lib/request-timeout";
import { fail, ok, type Result } from "@/lib/result";
import { marketPhase } from "./status";
import type {
  KalshiChange,
  KalshiMarket,
  KalshiOverview,
  KalshiPoint,
  RawCandlestick,
  RawMarket,
  RawMarketCandlesticks,
  RawTrade,
} from "./types";

// Public, unauthenticated market-data endpoints of the Kalshi Trade API v2.
const KALSHI_BASE_URL = "https://api.elections.kalshi.com/trade-api/v2";
const HISTORY_DAYS = 7;
const RECENT_HOURS = 3;
const HOUR_SEC = 60 * 60;
const DAY_SEC = 24 * HOUR_SEC;
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

function normalizeCandles(candles: RawCandlestick[]): KalshiPoint[] {
  const points: KalshiPoint[] = [];
  for (const c of candles) {
    // Like the market's last price, fall back to the last trade before this period if
    // none happened in it, so history is estimated the same way as the current probability.
    const { value, source } = impliedProbability(
      toNumber(c.yes_bid?.close_dollars),
      toNumber(c.yes_ask?.close_dollars),
      toNumber(c.price?.close_dollars ?? c.price?.previous_dollars),
    );
    if (value !== null && source !== "unavailable") points.push({ t: c.end_period_ts * 1000, value, source });
  }
  return points.sort((a, b) => a.t - b.t);
}

/** Merge point series chronologically; on a shared timestamp the later series wins. */
function mergePoints(...series: KalshiPoint[][]): KalshiPoint[] {
  const byTime = new Map<number, KalshiPoint>();
  for (const s of series) for (const p of s) byTime.set(p.t, p);
  return Array.from(byTime.values()).sort((a, b) => a.t - b.t);
}

export async function getMarket(ticker: string): Promise<KalshiMarket> {
  const data = await kalshiGet<{ market: RawMarket }>(`/markets/${encodeURIComponent(ticker)}`, LIVE);
  return normalizeMarket(data.market);
}

/** When the market last traded (ms), or null if it never has. Trades are returned newest first. */
async function getLastTradeTime(ticker: string): Promise<number | null> {
  const query = new URLSearchParams({ ticker, limit: "1" });
  const { trades } = await kalshiGet<{ trades?: RawTrade[] }>(`/markets/trades?${query}`, LIVE);
  const time = trades?.length ? Date.parse(trades[0].created_time) : NaN;
  return Number.isFinite(time) ? time : null;
}

/**
 * Implied-probability points from candlesticks of `periodMinutes` (1, 60, or 1440).
 * Uses the batch endpoint, which is keyed by market ticker alone, so history can load
 * alongside the market instead of waiting for it to name its event and series.
 */
async function getCandles(ticker: string, startSec: number, endSec: number, periodMinutes: number): Promise<KalshiPoint[]> {
  const query = new URLSearchParams({
    market_tickers: ticker,
    start_ts: String(startSec),
    end_ts: String(endSec),
    period_interval: String(periodMinutes),
  });
  const data = await kalshiGet<{ markets?: RawMarketCandlesticks[] }>(`/markets/candlesticks?${query}`, cachedFor(60));
  return normalizeCandles(data.markets?.find((m) => m.market_ticker === ticker)?.candlesticks ?? []);
}

/** Each series is null if it failed to load, so callers can tell failure from an empty history. */
interface ProbabilityHistory {
  /** Hourly points covering the last HISTORY_DAYS days. */
  hourly: KalshiPoint[] | null;
  /** Minute points covering the last RECENT_HOURS hours. */
  recent: KalshiPoint[] | null;
  /** Minute points covering the hour that ends 24 hours ago. */
  dayAgo: KalshiPoint[] | null;
}

/** Never rejects: a series that fails to load is null. */
export async function getProbabilityHistory(ticker: string, asOf: number): Promise<ProbabilityHistory> {
  // Align the window to the start of the current minute so identical requests within a
  // minute share one cache entry, instead of writing a new, never-reused entry to the
  // (shared, on Vercel) fetch cache every time. Candles end on minute boundaries and
  // Kalshi includes a candle ending exactly at end_ts, so no completed candle is lost.
  const end = Math.floor(asOf / 60_000) * 60;
  const dayAgo = end - DAY_SEC;
  const [hourly, recent, dayAgoMinutes] = await Promise.allSettled([
    getCandles(ticker, end - HISTORY_DAYS * DAY_SEC, end, HOURLY),
    getCandles(ticker, end - RECENT_HOURS * HOUR_SEC, end, MINUTE),
    // An hour of minute candles reaches back past the last hourly candle before the
    // 24h mark, so together they give the probability in effect at that exact minute.
    getCandles(ticker, dayAgo - HOUR_SEC, dayAgo, MINUTE),
  ]);
  return {
    hourly: hourly.status === "fulfilled" ? hourly.value : null,
    recent: recent.status === "fulfilled" ? recent.value : null,
    dayAgo: dayAgoMinutes.status === "fulfilled" ? dayAgoMinutes.value : null,
  };
}

/** A probability change, or the reason there isn't one. */
function changeOver(
  history: KalshiPoint[] | null,
  current: number | null,
  lookbackMs: number,
  asOf: number,
  live: boolean,
): KalshiChange {
  const none = { pp: null, from: null, fromSource: null };
  if (!live) return { ...none, unavailable: "market_not_live" };
  if (current === null) return { ...none, unavailable: "no_probability" };
  if (history === null) return { ...none, unavailable: "history_failed" };
  const change = probabilityChange(history, current, lookbackMs, asOf);
  const reference = history.find((p) => p.t === change.from);
  return {
    ...change,
    fromSource: reference?.source ?? null,
    unavailable: change.pp === null ? "not_enough_history" : null,
  };
}

/**
 * Hourly candles alone would compare against a point up to an hour older than the
 * lookback, so each change also uses minute candles around its reference time, merged
 * onto the hourly series in case the market was quiet for the whole minute window.
 * Without those minute candles, show no change rather than an imprecise one.
 */
function withMinutes(hourly: KalshiPoint[] | null, minutes: KalshiPoint[] | null): KalshiPoint[] | null {
  return minutes === null ? null : mergePoints(hourly ?? [], minutes);
}

/** Market snapshot, history, and derived metrics for one Kalshi market. */
export async function getKalshiOverview(ticker: string): Promise<Result<KalshiOverview>> {
  const fetchedAt = Date.now();
  // None of these depend on each other, so start them all at once: the worst case is one
  // request timeout, not several in a row. History and the last trade are optional and
  // never reject, so they are safe to abandon if the market lookup fails.
  const historyRequest = getProbabilityHistory(ticker, fetchedAt);
  const lastTradeRequest = getLastTradeTime(ticker).catch(() => null);

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

  const phase = marketPhase(market.status);
  // Only an open market has live quotes. Once trading stops, the last trade is a
  // historical price, not a probability, so no live metrics are derived from it.
  const live = phase === "open";

  // History is optional: show the snapshot even if candlesticks fail to load.
  const [history, lastTradeAt] = await Promise.all([historyRequest, lastTradeRequest]);

  const { value: probability, source } = live
    ? impliedProbability(market.yesBid, market.yesAsk, market.lastPrice)
    : { value: null, source: "unavailable" as const };

  return ok({
    market,
    phase,
    closePassed: market.closeTime !== null && Date.parse(market.closeTime) <= fetchedAt,
    probability,
    probabilitySource: source,
    lastTradeAt,
    change1h: changeOver(withMinutes(history.hourly, history.recent), probability, HOUR_MS, fetchedAt, live),
    change24h: changeOver(withMinutes(history.hourly, history.dayAgo), probability, 24 * HOUR_MS, fetchedAt, live),
    uncertainty: live ? uncertaintyScore(probability) : null,
    history: history.hourly?.map(({ t, value }) => ({ t, value })) ?? null,
    fetchedAt,
  });
}
