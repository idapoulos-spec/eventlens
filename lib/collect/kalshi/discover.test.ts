import { afterEach, describe, expect, it, vi } from "vitest";
import type { WatchItem } from "@/lib/store/watchlist";
import { createKalshiApi } from "./api";
import { discoverMarkets } from "./discover";
import { fakeKalshi, fakeTime, type FakeMarket } from "./test-kalshi";

vi.mock("server-only", () => ({}));

const NOW = Date.UTC(2026, 9, 7, 23, 42);

function market(ticker: string, source: FakeMarket["source"], seriesTicker = "KXFEDDECISION"): FakeMarket {
  return {
    ticker,
    eventTicker: ticker.split("-").slice(0, 2).join("-"),
    seriesTicker,
    source,
    status: source === "live" ? "active" : "finalized",
    openTime: Date.UTC(2025, 8, 29, 14),
    closeTime: Date.UTC(2026, 6, 29, 17, 59),
    settlementTs: source === "historical" ? Date.UTC(2026, 6, 29, 18, 7, 36, 155) : undefined,
  };
}

const MARKETS = [
  market("KXFEDDECISION-26OCT-H0", "live"),
  market("KXFEDDECISION-26JUL-H0", "historical"),
  market("FEDDECISION-24JAN-H0", "historical"),
  market("KXCPI-26OCT-T3", "live", "KXCPI"),
];

function item(kind: WatchItem["kind"], key: string, intervals = ["60", "1440"], active = true): WatchItem {
  return { id: 0, kind, key, intervals, active, note: null, addedAt: 0, updatedAt: 0 };
}

function setup() {
  const kalshi = fakeKalshi(MARKETS, NOW);
  const t = fakeTime(NOW);
  return { kalshi, api: createKalshiApi({ sleep: t.sleep, clock: t.clock }) };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("discoverMarkets", () => {
  it("finds a series' markets on both sides, with the endpoint that serves each one's candles", async () => {
    const { api } = setup();
    const result = await discoverMarkets(api, [item("kalshi_series", "KXFEDDECISION")]);
    expect(result.ok && result.data.markets.map((m) => [m.ticker, m.source, m.seriesTicker, m.periods])).toEqual([
      ["FEDDECISION-24JAN-H0", "historical", "KXFEDDECISION", ["60", "1440"]],
      ["KXFEDDECISION-26JUL-H0", "historical", "KXFEDDECISION", ["60", "1440"]],
      ["KXFEDDECISION-26OCT-H0", "live", "KXFEDDECISION", ["60", "1440"]],
    ]);
    expect(result.ok && result.data.markets[0]).toMatchObject({
      eventTicker: "FEDDECISION-24JAN",
      openTime: Date.UTC(2025, 8, 29, 14),
      closeTime: Date.UTC(2026, 6, 29, 17, 59),
      settlementTs: Date.UTC(2026, 6, 29, 18, 7, 36, 155),
      raw: { ticker: "FEDDECISION-24JAN-H0", status: "finalized" },
    });
  });

  it("joins the periods of every item that names a market, and files it under the series", async () => {
    const { api } = setup();
    const result = await discoverMarkets(api, [
      item("kalshi_market", "KXFEDDECISION-26OCT-H0", ["1440"]),
      item("kalshi_event", "KXCPI-26OCT", ["60"]),
      item("kalshi_series", "KXFEDDECISION", ["60"]),
    ]);
    const byTicker = new Map(result.ok ? result.data.markets.map((m) => [m.ticker, m]) : []);
    expect(byTicker.get("KXFEDDECISION-26OCT-H0")).toMatchObject({ seriesTicker: "KXFEDDECISION", periods: ["60", "1440"] });
    expect(byTicker.get("KXFEDDECISION-26JUL-H0")?.periods).toEqual(["60"]);
    // Watched by event only: the series is the event ticker's prefix.
    expect(byTicker.get("KXCPI-26OCT-T3")).toMatchObject({ seriesTicker: "KXCPI", source: "live", periods: ["60"] });
  });

  it("looks a single market up in the archive when the live endpoint doesn't have it", async () => {
    const { kalshi, api } = setup();
    const result = await discoverMarkets(api, [item("kalshi_market", "FEDDECISION-24JAN-H0")]);
    expect(result.ok && result.data.markets.map((m) => [m.ticker, m.source, m.seriesTicker])).toEqual([
      ["FEDDECISION-24JAN-H0", "historical", "FEDDECISION"],
    ]);
    expect(kalshi.requests.map((u) => u.pathname.replace("/trade-api/v2", ""))).toEqual([
      "/markets/FEDDECISION-24JAN-H0",
      "/historical/markets/FEDDECISION-24JAN-H0",
    ]);
  });

  it("prefers the archive for a market listed on both sides mid-move", async () => {
    const { kalshi, api } = setup();
    kalshi.markets.push({ ...MARKETS[0], source: "historical", status: "finalized" });
    const result = await discoverMarkets(api, [item("kalshi_series", "KXFEDDECISION")]);
    expect(result.ok && result.data.markets.find((m) => m.ticker === "KXFEDDECISION-26OCT-H0")).toMatchObject({
      source: "historical",
      raw: { status: "finalized" },
    });
  });

  it("ignores inactive and stock items, and reports items that match nothing", async () => {
    const { kalshi, api } = setup();
    const result = await discoverMarkets(api, [
      item("kalshi_series", "KXFEDDECISION", ["60"], false),
      item("stock", "SPY", ["30min"]),
      item("kalshi_series", "KXNOPE"),
      item("kalshi_market", "KXNOPE-26OCT-X"),
    ]);
    expect(result).toEqual({ ok: true, data: { markets: [], unmatched: ["kalshi_series KXNOPE", "kalshi_market KXNOPE-26OCT-X"] } });
    expect(kalshi.requests.some((u) => u.searchParams.get("series_ticker") === "KXFEDDECISION")).toBe(false);
  });

  it("fails rather than return a partial list", async () => {
    const { kalshi, api } = setup();
    kalshi.failWith = (url) => (url.pathname.includes("/historical/") ? 500 : undefined);
    expect(await discoverMarkets(api, [item("kalshi_series", "KXFEDDECISION")])).toMatchObject({ ok: false, error: { code: "unavailable" } });
  });
});
