// A fake Kalshi for the collector's tests, behind a stubbed fetch: market lists and markets from
// the live endpoints and the archive, and candles in each one's shape. Like Kalshi, it lists a
// market on exactly one side, writes a candle only for periods that have ended, answers the live
// candle endpoint with no entry for an archived market, and includes a candle ending exactly at end_ts.

import { vi } from "vitest";
import type { RawCandlestick, RawHistoricalCandlestick } from "@/lib/kalshi/types";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** Daily candles end at midnight New York time; the fake keeps summer's 04:00 UTC. */
const DAILY_END_OFFSET_MS = 4 * HOUR_MS;

export interface FakeMarket {
  ticker: string;
  eventTicker: string;
  seriesTicker: string;
  source: "live" | "historical";
  status: string;
  openTime: number;
  closeTime: number;
  settlementTs?: number;
}

export interface FakeKalshi {
  markets: FakeMarket[];
  /** Kalshi's clock: candles exist only for periods that ended by then. */
  now: number;
  /** The YES bid close of the candle ending at `endTs`, in dollars; null leaves the candle out. */
  price: (ticker: string, periodMin: number, endTs: number) => string | null;
  /** Answers a request with this HTTP status instead, if it returns one. */
  failWith: (url: URL) => number | undefined;
  /** Market list page size, to exercise cursors. */
  pageSize: number;
  /** Every request, in order. */
  requests: URL[];
  /** Moves a market to the archive, as Kalshi's cutoff does once it settled. */
  archive(ticker: string): void;
}

const iso = (ms: number | undefined) => (ms === undefined ? undefined : new Date(ms).toISOString());

function rawMarket(m: FakeMarket) {
  return {
    ticker: m.ticker,
    event_ticker: m.eventTicker,
    title: `Fed decision ${m.eventTicker}`,
    yes_sub_title: m.ticker.split("-").at(-1),
    status: m.status,
    result: m.status === "finalized" ? "no" : "",
    open_time: iso(m.openTime),
    close_time: iso(m.closeTime),
    yes_bid_dollars: "0.4500",
    ...(m.source === "historical" ? { settlement_ts: iso(m.settlementTs) } : {}),
  };
}

function candleEnds(kalshi: FakeKalshi, m: FakeMarket, periodMin: number, startSec: number, endSec: number): number[] {
  const period = periodMin * 60_000;
  const offset = periodMin === 1440 ? DAILY_END_OFFSET_MS : 0;
  const last = Math.min(endSec * 1000, kalshi.now, Math.max(m.closeTime, m.settlementTs ?? 0) + period);
  const first = Math.max(startSec * 1000, m.openTime);
  const ends: number[] = [];
  for (let t = Math.ceil((first - offset) / period) * period + offset; t <= last; t += period) ends.push(t);
  return ends;
}

function candles(kalshi: FakeKalshi, m: FakeMarket, url: URL, live: boolean): (RawCandlestick | RawHistoricalCandlestick)[] {
  const q = url.searchParams;
  const periodMin = Number(q.get("period_interval"));
  const ends = candleEnds(kalshi, m, periodMin, Number(q.get("start_ts")), Number(q.get("end_ts")));
  return ends.flatMap((endTs): (RawCandlestick | RawHistoricalCandlestick)[] => {
    const close = kalshi.price(m.ticker, periodMin, endTs);
    if (close === null) return [];
    return live
      ? [{ end_period_ts: endTs / 1000, yes_bid: { close_dollars: close }, price: {}, volume_fp: "10.00", open_interest_fp: "5.00" }]
      : [{ end_period_ts: endTs / 1000, yes_bid: { close }, price: { close: null }, volume: "10.00", open_interest: "5.00" }];
  });
}

function respond(kalshi: FakeKalshi, url: URL): Response {
  const path = url.pathname.replace("/trade-api/v2", "");
  const archive = path.startsWith("/historical/");
  const source = archive ? "historical" : "live";
  const rest = archive ? path.slice("/historical".length) : path;
  const q = url.searchParams;
  const onSide = kalshi.markets.filter((m) => m.source === source);
  const byTicker = (ticker: string) => onSide.find((m) => m.ticker === decodeURIComponent(ticker));
  const notFound = () => Response.json({ error: { code: "not_found" } }, { status: 404 });

  if (rest === "/markets/candlesticks" && !archive) {
    const m = byTicker(q.get("market_tickers") ?? "");
    return Response.json({ markets: m ? [{ market_ticker: m.ticker, candlesticks: candles(kalshi, m, url, true) }] : [] });
  }
  const candleMatch = rest.match(/^\/markets\/([^/]+)\/candlesticks$/);
  if (candleMatch && archive) {
    const m = byTicker(candleMatch[1]);
    return m ? Response.json({ ticker: m.ticker, candlesticks: candles(kalshi, m, url, false) }) : notFound();
  }
  const marketMatch = rest.match(/^\/markets\/([^/]+)$/);
  if (marketMatch) {
    const m = byTicker(marketMatch[1]);
    return m ? Response.json({ market: rawMarket(m) }) : notFound();
  }
  if (rest === "/markets") {
    const series = q.get("series_ticker");
    const event = q.get("event_ticker");
    const matching = onSide.filter((m) => (series ? m.seriesTicker === series : m.eventTicker === event));
    const start = Number(q.get("cursor") || 0);
    const page = matching.slice(start, start + kalshi.pageSize);
    const next = start + kalshi.pageSize < matching.length ? String(start + kalshi.pageSize) : "";
    return Response.json({ markets: page.map(rawMarket), cursor: next });
  }
  return notFound();
}

/** Stubs fetch with a fake Kalshi serving `markets`. Undo with vi.unstubAllGlobals(). */
export function fakeKalshi(markets: FakeMarket[], now: number): FakeKalshi {
  const kalshi: FakeKalshi = {
    markets: markets.map((m) => ({ ...m })),
    now,
    price: () => "0.4500",
    failWith: () => undefined,
    pageSize: 1000,
    requests: [],
    archive(ticker) {
      const m = kalshi.markets.find((x) => x.ticker === ticker);
      if (m) Object.assign(m, { source: "historical", status: "finalized", settlementTs: m.settlementTs ?? m.closeTime });
    },
  };
  vi.stubGlobal("fetch", async (input: string | URL) => {
    const url = new URL(String(input));
    kalshi.requests.push(url);
    const status = kalshi.failWith(url);
    return status ? Response.json({ error: "fake failure" }, { status }) : respond(kalshi, url);
  });
  return kalshi;
}

/** A clock that only moves when the code under test sleeps, so pacing and retries take no time. */
export function fakeTime(start: number) {
  const time = { now: start, sleeps: [] as number[] };
  return {
    time,
    clock: () => time.now,
    sleep: async (ms: number) => {
      time.sleeps.push(ms);
      time.now += ms;
    },
  };
}

export { DAY_MS, HOUR_MS };
