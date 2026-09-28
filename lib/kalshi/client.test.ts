import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOUR_MS } from "@/lib/analytics";
import { getKalshiOverview } from "./client";

// server-only throws outside React's server environment; the client only uses it as a marker.
vi.mock("server-only", () => ({}));

const TICKER = "KXTEST-26OCT-T1";
const MINUTE_MS = 60_000;
// 12:40:30 PM New York. History windows end at the start of the current minute, 16:40 UTC.
const NOW = Date.UTC(2026, 8, 28, 16, 40, 30);
const END = Date.UTC(2026, 8, 28, 16, 40);
const DAY_AGO_SEC = END / 1000 - 24 * 60 * 60;

type Candle = { t: number; bid: number; ask: number; close?: number; previous?: number };

const dollars = (v: number | undefined) => (v === undefined ? undefined : v.toFixed(4));

/** Raw candlestick; omitted prices are left out of the JSON, as Kalshi does. */
function rawCandle({ t, bid, ask, close, previous }: Candle) {
  return {
    end_period_ts: t / 1000,
    yes_bid: { close_dollars: dollars(bid) },
    yes_ask: { close_dollars: dollars(ask) },
    price: { close_dollars: dollars(close), previous_dollars: dollars(previous) },
  };
}

interface Upstream {
  market?: { bid: number; ask: number; last: number };
  lastTrade?: string;
  hourly?: Candle[];
  recent?: Candle[];
  dayAgo?: Candle[];
  /** Requests that respond with HTTP 500. */
  failing?: ("trades" | "hourly" | "recent" | "dayAgo")[];
}

/** Fakes Kalshi's API and records the order requests were made in. */
function stubKalshi(upstream: Upstream) {
  const calls: string[] = [];
  const { market = { bid: 0.5, ask: 0.52, last: 0.51 }, failing = [] } = upstream;

  vi.stubGlobal("fetch", async (input: string | URL) => {
    const url = new URL(String(input));
    const path = url.pathname.replace("/trade-api/v2", "");
    const q = url.searchParams;
    let name: string;
    let body: unknown;

    if (path === `/markets/${TICKER}`) {
      name = "market";
      body = {
        market: {
          ticker: TICKER,
          event_ticker: "KXTEST-26OCT",
          title: "Test market",
          status: "active",
          yes_bid_dollars: dollars(market.bid),
          yes_ask_dollars: dollars(market.ask),
          last_price_dollars: dollars(market.last),
        },
      };
    } else if (path === "/markets/trades") {
      name = "trades";
      body = { trades: upstream.lastTrade ? [{ created_time: upstream.lastTrade }] : [] };
    } else if (path === "/markets/candlesticks") {
      expect(q.get("market_tickers")).toBe(TICKER);
      const endTs = Number(q.get("end_ts"));
      name = q.get("period_interval") === "60" ? "hourly" : endTs === DAY_AGO_SEC ? "dayAgo" : "recent";
      const candles = (upstream[name as "hourly" | "recent" | "dayAgo"] ?? []).map(rawCandle);
      body = { markets: [{ market_ticker: TICKER, candlesticks: candles }] };
    } else {
      throw new Error(`Unexpected request: ${url}`);
    }

    calls.push(name);
    const status = (failing as string[]).includes(name) ? 500 : 200;
    return Response.json(status === 200 ? body : { error: "boom" }, { status });
  });
  return calls;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function overview() {
  const result = await getKalshiOverview(TICKER);
  if (!result.ok) throw new Error(`Expected data, got ${result.error.code}`);
  return result.data;
}

describe("getKalshiOverview", () => {
  it("compares the 24h change against the minute in effect 24 hours ago, not the hourly candle before it", async () => {
    const dayAgo = DAY_AGO_SEC * 1000;
    stubKalshi({
      hourly: [
        { t: dayAgo - 40 * MINUTE_MS, bid: 0.3, ask: 0.32 }, // 16:00 UTC the day before
        { t: dayAgo + 20 * MINUTE_MS, bid: 0.4, ask: 0.42 },
      ],
      dayAgo: [{ t: dayAgo - 15 * MINUTE_MS, bid: 0.35, ask: 0.37 }],
      recent: [{ t: END - 70 * MINUTE_MS, bid: 0.45, ask: 0.47 }],
    });
    const data = await overview();

    expect(data.probability).toBeCloseTo(0.51, 12);
    expect(data.change24h.from).toBe(dayAgo - 15 * MINUTE_MS);
    expect(data.change24h.pp).toBeCloseTo(15, 10); // 51% now vs. 36% then
    expect(data.change24h.fromSource).toBe("midpoint");
    expect(data.change1h.pp).toBeCloseTo(5, 10);
    expect(data.change1h.from).toBeLessThanOrEqual(NOW - HOUR_MS);
  });

  it("estimates a no-trade candle with a one-sided book from the previous trade, and flags the method change", async () => {
    const dayAgo = DAY_AGO_SEC * 1000;
    stubKalshi({
      hourly: [
        { t: dayAgo - 40 * MINUTE_MS, bid: 0, ask: 0.4, previous: 0.33 },
        { t: END - 40 * MINUTE_MS, bid: 0, ask: 1, close: 0.49 },
      ],
      dayAgo: [{ t: dayAgo - 15 * MINUTE_MS, bid: 0, ask: 0.4, previous: 0.38 }],
      recent: [],
    });
    const data = await overview();

    expect(data.change24h.fromSource).toBe("last_price");
    expect(data.change24h.pp).toBeCloseTo(13, 10); // 51% midpoint now vs. a 38¢ trade then
    expect(data.probabilitySource).toBe("midpoint");
    // The chart history includes the fallback point, without the internal source field.
    expect(data.history).toEqual([
      { t: dayAgo - 40 * MINUTE_MS, value: 0.33 },
      { t: END - 40 * MINUTE_MS, value: 0.49 },
    ]);
  });

  it("reports the time of the last trade", async () => {
    stubKalshi({ lastTrade: "2026-09-28T15:12:05.5Z" });
    const data = await overview();
    expect(data.lastTradeAt).toBe(Date.parse("2026-09-28T15:12:05.5Z"));
  });

  it("keeps the rest of the overview when one history request or the last-trade lookup fails", async () => {
    stubKalshi({
      hourly: [{ t: END - 3 * HOUR_MS, bid: 0.4, ask: 0.42 }],
      recent: [{ t: END - 70 * MINUTE_MS, bid: 0.45, ask: 0.47 }],
      lastTrade: "2026-09-28T15:12:05Z",
      failing: ["dayAgo", "trades"],
    });
    const data = await overview();

    expect(data.change24h).toMatchObject({ pp: null, unavailable: "history_failed" });
    expect(data.change1h.pp).toBeCloseTo(5, 10);
    expect(data.history).toHaveLength(1);
    expect(data.lastTradeAt).toBeNull();
  });

  it("starts the history and last-trade requests without waiting for the market", async () => {
    const calls = stubKalshi({});
    await overview();
    expect(calls).toHaveLength(5);
    expect(calls.indexOf("market")).toBe(4);
  });
});
