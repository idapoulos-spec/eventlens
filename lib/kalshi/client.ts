import "server-only";

import {
  impliedProbability,
  probabilityChange1hPp,
  probabilityChange24hPp,
  uncertaintyScore,
  type TimePoint,
} from "@/lib/analytics";
import { fail, ok, type Result } from "@/lib/result";
import type { KalshiMarket, KalshiOverview, RawCandlestick, RawEvent, RawMarket } from "./types";

// Public, unauthenticated market-data endpoints of the Kalshi Trade API v2.
const KALSHI_BASE_URL = "https://api.elections.kalshi.com/trade-api/v2";
const HISTORY_DAYS = 7;
const HOURLY = 60;

class KalshiHttpError extends Error {
  constructor(public status: number) {
    super(`Kalshi API responded with ${status}`);
  }
}

async function kalshiGet<T>(path: string, revalidateSeconds: number): Promise<T> {
  const res = await fetch(`${KALSHI_BASE_URL}${path}`, {
    headers: { Accept: "application/json" },
    next: { revalidate: revalidateSeconds },
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
  const data = await kalshiGet<{ market: RawMarket }>(`/markets/${encodeURIComponent(ticker)}`, 30);
  return normalizeMarket(data.market);
}

/** Hourly implied-probability history. Candlesticks are keyed by series, so resolve it via the event. */
export async function getProbabilityHistory(market: KalshiMarket, days = HISTORY_DAYS): Promise<TimePoint[]> {
  const { event } = await kalshiGet<{ event: RawEvent }>(
    `/events/${encodeURIComponent(market.eventTicker)}`,
    3600,
  );
  const end = Math.floor(Date.now() / 1000);
  const start = end - days * 24 * 60 * 60;
  const query = new URLSearchParams({
    start_ts: String(start),
    end_ts: String(end),
    period_interval: String(HOURLY),
  });
  const data = await kalshiGet<{ candlesticks?: RawCandlestick[] }>(
    `/series/${encodeURIComponent(event.series_ticker)}/markets/${encodeURIComponent(market.ticker)}/candlesticks?${query}`,
    60,
  );
  return normalizeCandles(data.candlesticks ?? []);
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

  // History is optional: show the snapshot even if candlesticks are unavailable.
  let history: TimePoint[] = [];
  try {
    history = await getProbabilityHistory(market);
  } catch {
    history = [];
  }

  const fetchedAt = Date.now();
  const { value: probability, source } = impliedProbability(market.yesBid, market.yesAsk, market.lastPrice);

  return ok({
    market,
    probability,
    probabilitySource: source,
    change1hPp: probabilityChange1hPp(history, probability, fetchedAt),
    change24hPp: probabilityChange24hPp(history, probability, fetchedAt),
    uncertainty: uncertaintyScore(probability),
    history,
    fetchedAt,
  });
}
