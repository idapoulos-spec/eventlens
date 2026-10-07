import { afterEach, describe, expect, it, vi } from "vitest";
import { getHistoricalCandles, getHistoricalCutoff, getHistoricalMarket, MAX_CANDLES_PER_REQUEST } from "./historical";

// server-only throws outside React's server environment; the client only uses it as a marker.
vi.mock("server-only", () => ({}));

const BASE = "https://api.elections.kalshi.com/trade-api/v2";
const TICKER = "KXFEDDECISION-25DEC-H0";

/** Answers every request with `body` (or `status`), recording the URLs asked for. */
function stubFetch(body: unknown, status = 200) {
  const urls: string[] = [];
  vi.stubGlobal("fetch", async (input: string | URL) => {
    urls.push(String(input));
    return Response.json(body, { status });
  });
  return urls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getHistoricalCutoff", () => {
  it("reads when markets move to the archive", async () => {
    const urls = stubFetch({
      market_positions_last_updated_ts: "2026-08-08T00:00:00Z",
      market_settled_ts: "2026-08-08T00:00:00Z",
      orders_updated_ts: "2026-09-23T00:00:00Z",
      trades_created_ts: "2026-08-08T00:00:00Z",
    });
    expect(await getHistoricalCutoff()).toEqual({ ok: true, data: { marketSettledBefore: Date.UTC(2026, 7, 8) } });
    expect(urls).toEqual([`${BASE}/historical/cutoff`]);
  });

  it("fails on a cutoff it can't read", async () => {
    stubFetch({ market_settled_ts: "soon" });
    expect(await getHistoricalCutoff()).toMatchObject({ ok: false, error: { code: "invalid_data" } });
  });
});

describe("getHistoricalMarket", () => {
  it("returns the market as Kalshi sent it", async () => {
    const market = { ticker: TICKER, event_ticker: "KXFEDDECISION-25DEC", status: "finalized", result: "no", settlement_ts: "2025-12-10T19:08:51.628715Z" };
    const urls = stubFetch({ market });
    expect(await getHistoricalMarket(TICKER)).toEqual({ ok: true, data: market });
    expect(urls).toEqual([`${BASE}/historical/markets/${TICKER}`]);
  });

  it("says when the archive doesn't have the market, or Kalshi is limiting requests", async () => {
    stubFetch({ error: "not found" }, 404);
    expect(await getHistoricalMarket("KXNOPE")).toMatchObject({ ok: false, error: { code: "not_found" } });
    stubFetch({ error: "slow down" }, 429);
    expect(await getHistoricalMarket(TICKER)).toMatchObject({ ok: false, error: { code: "rate_limited" } });
  });

  it("encodes legacy tickers with '>' in them", async () => {
    const urls = stubFetch({ market: { ticker: "FEDDECISION-23JUL-H>25" } });
    await getHistoricalMarket("FEDDECISION-23JUL-H>25");
    expect(urls[0]).toBe(`${BASE}/historical/markets/FEDDECISION-23JUL-H%3E25`);
  });
});

describe("getHistoricalCandles", () => {
  const window = { startSec: 1754006400, endSec: 1765756800, periodMinutes: 60 } as const;

  it("asks for one window and normalizes the archive's candle shape, oldest first", async () => {
    const urls = stubFetch({
      candlesticks: [
        { end_period_ts: 1754956800, price: { close: null, previous: "0.3300" }, yes_bid: { close: "0.3000" }, volume: "0.00" },
        { end_period_ts: 1754953200, price: { close: "0.3300" }, yes_bid: { close: "0.3000" }, volume: "100.00" },
      ],
    });
    const result = await getHistoricalCandles(TICKER, window);
    expect(result.ok && result.data.map((c) => [c.endTs, c.price.close, c.price.previous, c.volume])).toEqual([
      [1754953200_000, 330000, null, 10000],
      [1754956800_000, null, 330000, 0],
    ]);
    const url = new URL(urls[0]);
    expect(url.pathname).toBe(`/trade-api/v2/historical/markets/${TICKER}/candlesticks`);
    expect(Object.fromEntries(url.searchParams)).toEqual({ start_ts: "1754006400", end_ts: "1765756800", period_interval: "60" });
  });

  it("treats a missing candle list as no candles", async () => {
    stubFetch({});
    expect(await getHistoricalCandles(TICKER, window)).toEqual({ ok: true, data: [] });
  });

  it("fails rather than store a price outside $0–$1", async () => {
    stubFetch({ candlesticks: [{ end_period_ts: 1754953200, yes_bid: { close: "4.2000" } }] });
    expect(await getHistoricalCandles(TICKER, window)).toMatchObject({ ok: false, error: { code: "invalid_data" } });
  });

  it("refuses a window Kalshi would reject, before asking", async () => {
    const urls = stubFetch({});
    const tooLong = { startSec: 0, endSec: (MAX_CANDLES_PER_REQUEST + 1) * 3600, periodMinutes: 60 } as const;
    await expect(getHistoricalCandles(TICKER, tooLong)).rejects.toThrow(RangeError);
    await expect(getHistoricalCandles(TICKER, { ...window, endSec: window.startSec })).rejects.toThrow(RangeError);
    expect(urls).toEqual([]);
  });
});
