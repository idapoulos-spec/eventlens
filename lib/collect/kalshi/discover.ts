// Turns the watchlist's Kalshi items into the markets to collect. A series or event is listed from
// both the live endpoints and the archive, because Kalshi moves markets settled before its cutoff
// to the archive (lib/kalshi/historical.ts). The list a market came from says which endpoint
// serves its candles.

import type { RawMarket } from "@/lib/kalshi/types";
import { ok, type Result } from "@/lib/result";
import type { KalshiPeriod, KalshiSource, WatchKind } from "@/lib/store/schema";
import type { WatchItem } from "@/lib/store/watchlist";
import type { KalshiApi } from "./api";
import { KALSHI_PERIODS, type MarketTimes } from "./ranges";

export interface DiscoveredMarket extends MarketTimes {
  ticker: string;
  eventTicker: string;
  /**
   * The watchlist series that lists the market, so legacy FEDDECISION-… markets file under
   * KXFEDDECISION. Markets watched only by event or ticker take their event ticker's prefix.
   */
  seriesTicker: string;
  /** Which endpoint serves the market's candles. */
  source: KalshiSource;
  /** Every candle period a watchlist item naming the market asks for. */
  periods: KalshiPeriod[];
  /** The market as Kalshi returned it. */
  raw: RawMarket;
}

export interface Discovery {
  /** By ticker. */
  markets: DiscoveredMarket[];
  /** Watchlist items no market matched on either endpoint, as "kind key". */
  unmatched: string[];
}

/** Series first, so a market listed by a series and by an event files under the series. */
const KIND_ORDER: Partial<Record<WatchKind, number>> = { kalshi_series: 0, kalshi_event: 1, kalshi_market: 2 };
const SOURCES: readonly KalshiSource[] = ["live", "historical"];

function time(value: string | null | undefined): number | null {
  const ms = value ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

interface Found {
  market: RawMarket;
  source: KalshiSource;
}

async function marketsFor(api: KalshiApi, item: WatchItem): Promise<Result<Found[]>> {
  if (item.kind === "kalshi_market") {
    for (const source of SOURCES) {
      const result = await api.getMarket(source, item.key);
      if (result.ok) return ok([{ market: result.data, source }]);
      if (result.error.code !== "not_found") return result;
    }
    return ok([]);
  }
  const filter = item.kind === "kalshi_series" ? { series_ticker: item.key } : { event_ticker: item.key };
  const found: Found[] = [];
  for (const source of SOURCES) {
    const result = await api.listMarkets(source, filter);
    if (!result.ok) return result;
    found.push(...result.data.map((market) => ({ market, source })));
  }
  return ok(found);
}

/** Every market the active Kalshi items name. Fails if any request fails, so a run never works from a partial list. */
export async function discoverMarkets(api: KalshiApi, watchlist: WatchItem[]): Promise<Result<Discovery>> {
  const rank = (item: WatchItem) => KIND_ORDER[item.kind] ?? Infinity;
  const items = watchlist
    .filter((item) => item.active && rank(item) !== Infinity)
    .sort((a, b) => rank(a) - rank(b) || a.key.localeCompare(b.key));
  const byTicker = new Map<string, DiscoveredMarket>();
  const unmatched: string[] = [];

  for (const item of items) {
    const found = await marketsFor(api, item);
    if (!found.ok) return found;
    if (!found.data.length) unmatched.push(`${item.kind} ${item.key}`);

    for (const { market, source } of found.data) {
      const known = byTicker.get(market.ticker);
      const periods = KALSHI_PERIODS.filter((p) => item.intervals.includes(p) || known?.periods.includes(p));
      // A market on both lists is mid-move to the archive, which then serves all of its candles.
      if (known && !(source === "historical" && known.source === "live")) {
        known.periods = periods;
        continue;
      }
      byTicker.set(market.ticker, {
        ticker: market.ticker,
        eventTicker: market.event_ticker,
        seriesTicker: known?.seriesTicker ?? (item.kind === "kalshi_series" ? item.key : market.event_ticker.split("-")[0]),
        source,
        periods,
        openTime: time(market.open_time),
        closeTime: time(market.close_time),
        settlementTs: time(market.settlement_ts),
        raw: market,
      });
    }
  }
  const markets = [...byTicker.values()].sort((a, b) => a.ticker.localeCompare(b.ticker));
  return ok({ markets, unmatched });
}
