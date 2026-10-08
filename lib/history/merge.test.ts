import { afterEach, describe, expect, it, vi } from "vitest";
import { toKalshiCandles } from "@/lib/kalshi/candles";
import { getHourlyHistory } from "@/lib/kalshi/client";
import { candlePoints, coveragePlan, mergeByTime } from "./merge";

// server-only throws outside React's server environment; the client only uses it as a marker.
vi.mock("server-only", () => ({}));

afterEach(() => {
  vi.unstubAllGlobals();
});

const range = (from: number, to: number) => ({ from, to });

describe("coveragePlan", () => {
  const need = range(100, 200);

  it("reads only the store when nothing in the window is missing", () => {
    expect(coveragePlan([], need)).toEqual({ kind: "stored" });
  });

  it("fetches a live tail when only the end is missing", () => {
    expect(coveragePlan([range(180, 200)], need)).toEqual({ kind: "tail", from: 180 });
    // Coverage that stops before the window's end, with the gap running past it.
    expect(coveragePlan([range(190, 260)], need)).toEqual({ kind: "tail", from: 190 });
  });

  it("ignores what's missing before the market opened or after it closed", () => {
    // The caller narrows `need` to the market's life; gaps outside it don't count.
    expect(coveragePlan([range(0, 100), range(200, 300)], need)).toEqual({ kind: "stored" });
    expect(coveragePlan([range(0, 120)], range(120, 200))).toEqual({ kind: "stored" });
  });

  it("goes live for the whole window when its start or middle is missing, or nothing is stored", () => {
    expect(coveragePlan([range(100, 120)], need)).toEqual({ kind: "live" });
    expect(coveragePlan([range(140, 150)], need)).toEqual({ kind: "live" });
    expect(coveragePlan([range(140, 150), range(190, 200)], need)).toEqual({ kind: "live" });
    expect(coveragePlan([range(0, 300)], need)).toEqual({ kind: "live" });
  });
});

describe("mergeByTime", () => {
  it("keeps both series' points in time order, live winning where both have one", () => {
    const stored = [
      { t: 1, v: "stored" },
      { t: 2, v: "stored" },
      { t: 3, v: "stored" },
    ];
    const live = [
      { t: 3, v: "live" },
      { t: 4, v: "live" },
    ];
    expect(mergeByTime(stored, live)).toEqual([
      { t: 1, v: "stored" },
      { t: 2, v: "stored" },
      { t: 3, v: "live" },
      { t: 4, v: "live" },
    ]);
  });
});

describe("candlePoints", () => {
  const T = Date.UTC(2025, 11, 1, 15);
  const HOUR = 60 * 60 * 1000;
  // A two-sided book, a one-sided book with a trade, a one-sided book with only an earlier
  // trade, and a candle with nothing to price from (left out).
  const candles = [
    { t: T, bid: "0.4500", ask: "0.4700", close: "0.4600", previous: "0.4400" },
    { t: T + HOUR, bid: null, ask: "0.5000", close: "0.4900", previous: "0.4600" },
    { t: T + 2 * HOUR, bid: null, ask: "0.5200", close: null, previous: "0.4900" },
    { t: T + 3 * HOUR, bid: null, ask: null, close: null, previous: null },
  ];

  const live = candles.map((c) => ({
    end_period_ts: c.t / 1000,
    yes_bid: { close_dollars: c.bid },
    yes_ask: { close_dollars: c.ask },
    price: c.close === null && c.previous === null ? {} : { close_dollars: c.close ?? undefined, previous_dollars: c.previous ?? undefined },
    volume_fp: "10.00",
    open_interest_fp: "100.00",
  }));
  const historical = candles.map((c) => ({
    end_period_ts: c.t / 1000,
    yes_bid: { close: c.bid },
    yes_ask: { close: c.ask },
    price: { close: c.close, previous: c.previous },
    volume: "10.00",
    open_interest: "100.00",
  }));

  it("estimates probabilities exactly as the live client does, from either candle shape", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ markets: [{ market_ticker: "KXTEST-25DEC-H0", candlesticks: live }] }));
    const fromLive = await getHourlyHistory("KXTEST-25DEC-H0", T / 1000 - 3600, T / 1000 + 4 * 3600);
    if (!fromLive.ok) throw new Error("expected live points");

    expect(fromLive.data).toHaveLength(3);
    expect(candlePoints(toKalshiCandles(live))).toEqual(fromLive.data);
    expect(candlePoints(toKalshiCandles(historical))).toEqual(fromLive.data);
    expect(fromLive.data.map((p) => p.source)).toEqual(["midpoint", "last_price", "last_price"]);
  });
});
