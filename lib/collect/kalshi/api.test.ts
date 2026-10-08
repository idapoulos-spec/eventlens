import { afterEach, describe, expect, it, vi } from "vitest";
import { createKalshiApi, MIN_REQUEST_GAP_MS, RETRY_DELAYS_MS } from "./api";
import { fakeKalshi, fakeTime, HOUR_MS, type FakeMarket } from "./test-kalshi";

// server-only throws outside React's server environment; the Kalshi client only uses it as a marker.
vi.mock("server-only", () => ({}));

const NOW = Date.UTC(2026, 9, 7, 23, 42);
const MARKETS: FakeMarket[] = [
  {
    ticker: "KXFEDDECISION-26OCT-H0",
    eventTicker: "KXFEDDECISION-26OCT",
    seriesTicker: "KXFEDDECISION",
    source: "live",
    status: "active",
    openTime: Date.UTC(2025, 9, 1, 14),
    closeTime: Date.UTC(2026, 9, 28, 17, 59),
  },
  {
    ticker: "KXFEDDECISION-26OCT-H25",
    eventTicker: "KXFEDDECISION-26OCT",
    seriesTicker: "KXFEDDECISION",
    source: "live",
    status: "active",
    openTime: Date.UTC(2025, 9, 1, 14),
    closeTime: Date.UTC(2026, 9, 28, 17, 59),
  },
  {
    ticker: "FEDDECISION-23JUL-H>25",
    eventTicker: "FEDDECISION-23JUL",
    seriesTicker: "KXFEDDECISION",
    source: "historical",
    status: "finalized",
    openTime: Date.UTC(2023, 5, 1, 14),
    closeTime: Date.UTC(2023, 6, 26, 17, 55),
    settlementTs: Date.UTC(2023, 6, 26, 18, 30),
  },
];

function setup() {
  const kalshi = fakeKalshi(MARKETS, NOW);
  const t = fakeTime(NOW);
  return { kalshi, t, api: createKalshiApi({ sleep: t.sleep, clock: t.clock }) };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("listMarkets", () => {
  it("lists a series on each side, following the cursor page by page", async () => {
    const { kalshi, api } = setup();
    kalshi.pageSize = 1;
    const live = await api.listMarkets("live", { series_ticker: "KXFEDDECISION" });
    expect(live.ok && live.data.map((m) => m.ticker)).toEqual(["KXFEDDECISION-26OCT-H0", "KXFEDDECISION-26OCT-H25"]);
    const archived = await api.listMarkets("historical", { series_ticker: "KXFEDDECISION" });
    expect(archived.ok && archived.data.map((m) => m.ticker)).toEqual(["FEDDECISION-23JUL-H>25"]);

    const lists = kalshi.requests.map((u) => [u.pathname.replace("/trade-api/v2", ""), u.searchParams.get("cursor")]);
    expect(lists).toEqual([
      ["/markets", null],
      ["/markets", "1"],
      ["/historical/markets", null],
    ]);
    expect(kalshi.requests[0].searchParams.get("limit")).toBe("1000");
    expect(api.requests).toBe(3);
  });

  it("lists an event", async () => {
    const { api } = setup();
    const result = await api.listMarkets("live", { event_ticker: "KXFEDDECISION-26OCT" });
    expect(result.ok && result.data).toHaveLength(2);
  });
});

describe("getMarket", () => {
  it("says not_found when that side doesn't have the market", async () => {
    const { api } = setup();
    expect(await api.getMarket("live", "FEDDECISION-23JUL-H>25")).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await api.getMarket("historical", "FEDDECISION-23JUL-H>25")).toMatchObject({ ok: true, data: { status: "finalized" } });
  });
});

describe("getCandles", () => {
  const window = { from: NOW - 6 * HOUR_MS - 42 * 60_000, to: NOW - 42 * 60_000 }; // 17:00 to 23:00

  it("returns the candles ending in [from, to), leaving the one at `to` to the next window", async () => {
    const { kalshi, api } = setup();
    const result = await api.getCandles("live", "KXFEDDECISION-26OCT-H0", "60", window);
    expect(result.ok && result.data.map((c) => (c.endTs - window.from) / HOUR_MS)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(result.ok && result.data[0]).toMatchObject({ yesBid: { close: 450000 }, volume: 1000, openInterest: 500 });
    expect(Object.fromEntries(kalshi.requests[0].searchParams)).toEqual({
      market_tickers: "KXFEDDECISION-26OCT-H0",
      start_ts: String(window.from / 1000),
      end_ts: String(window.to / 1000),
      period_interval: "60",
    });
  });

  it("reads the archive's candle shape the same way", async () => {
    const { api } = setup();
    const from = Date.UTC(2023, 6, 26, 12);
    const result = await api.getCandles("historical", "FEDDECISION-23JUL-H>25", "60", { from, to: from + 3 * HOUR_MS });
    expect(result.ok && result.data.map((c) => [c.endTs, c.yesBid.close, c.price.close, c.volume])).toEqual([
      [from, 450000, null, 1000],
      [from + HOUR_MS, 450000, null, 1000],
      [from + 2 * HOUR_MS, 450000, null, 1000],
    ]);
  });

  it("tells a market moved to the archive from a window without candles", async () => {
    const { kalshi, api } = setup();
    kalshi.price = () => null;
    expect(await api.getCandles("live", "KXFEDDECISION-26OCT-H0", "60", window)).toEqual({ ok: true, data: [] });
    kalshi.archive("KXFEDDECISION-26OCT-H0");
    expect(await api.getCandles("live", "KXFEDDECISION-26OCT-H0", "60", window)).toMatchObject({ ok: false, error: { code: "archived" } });
  });
});

describe("pacing and retries", () => {
  it("waits at least 250 ms between requests", async () => {
    const { kalshi, t, api } = setup();
    const starts: number[] = [];
    kalshi.failWith = () => {
      starts.push(t.clock());
      return undefined;
    };
    for (let i = 0; i < 4; i++) await api.getMarket("live", "KXFEDDECISION-26OCT-H0");
    expect(starts.slice(1).map((s, i) => s - starts[i])).toEqual([MIN_REQUEST_GAP_MS, MIN_REQUEST_GAP_MS, MIN_REQUEST_GAP_MS]);
  });

  it("retries when Kalshi limits requests, and counts every attempt", async () => {
    const { kalshi, t, api } = setup();
    let failures = 2;
    kalshi.failWith = () => (failures-- > 0 ? 429 : undefined);
    expect(await api.getMarket("live", "KXFEDDECISION-26OCT-H0")).toMatchObject({ ok: true });
    expect(api.requests).toBe(3);
    expect(t.time.sleeps.filter((ms) => ms > MIN_REQUEST_GAP_MS)).toEqual(RETRY_DELAYS_MS.rate_limited.slice(0, 2));
  });

  it("gives up after the last retry, and doesn't retry what can't succeed", async () => {
    const { kalshi, api } = setup();
    kalshi.failWith = () => 429;
    expect(await api.getMarket("live", "KXFEDDECISION-26OCT-H0")).toMatchObject({ ok: false, error: { code: "rate_limited" } });
    expect(api.requests).toBe(1 + RETRY_DELAYS_MS.rate_limited.length);

    kalshi.failWith = () => 500;
    expect(await api.listMarkets("live", { series_ticker: "KXFEDDECISION" })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(api.requests).toBe(1 + RETRY_DELAYS_MS.rate_limited.length + 2);

    kalshi.failWith = () => undefined;
    const before = api.requests;
    await api.getMarket("live", "KXNOPE-1");
    expect(api.requests).toBe(before + 1);
  });
});
