import { describe, expect, it } from "vitest";
import { normalizeCandle, toKalshiCandles } from "./candles";

// Real candlesticks from KXFEDDECISION-26SEP-H0 (live /markets/candlesticks) and
// KXFEDDECISION-25DEC-H0 (/historical), fetched on 2026-10-07.
const LIVE = {
  trade: {
    end_period_ts: 1772805600,
    open_interest_fp: "10.00",
    price: {
      close_dollars: "0.6900",
      high_dollars: "0.7000",
      low_dollars: "0.6900",
      mean_dollars: "0.6967",
      open_dollars: "0.7000",
      previous_dollars: "0.6000",
    },
    volume_fp: "15.00",
    yes_ask: { close_dollars: "0.6800", high_dollars: "0.8300", low_dollars: "0.6800", open_dollars: "0.7000" },
    yes_bid: { close_dollars: "0.6100", high_dollars: "0.6600", low_dollars: "0.4600", open_dollars: "0.6000" },
  },
  previousOnly: {
    end_period_ts: 1772762400,
    open_interest_fp: "5.00",
    price: { previous_dollars: "0.6000" },
    volume_fp: "0.00",
    yes_ask: { close_dollars: "0.6800", high_dollars: "0.8300", low_dollars: "0.6600", open_dollars: "0.7000" },
    yes_bid: { close_dollars: "0.6200", high_dollars: "0.6200", low_dollars: "0.4600", open_dollars: "0.6100" },
  },
  noTrade: {
    end_period_ts: 1759165200,
    open_interest_fp: "0.00",
    price: {},
    volume_fp: "0.00",
    yes_ask: { close_dollars: "0.9900", high_dollars: "0.9900", low_dollars: "0.9900", open_dollars: "0.9900" },
    yes_bid: { close_dollars: "0.0000", high_dollars: "0.0000", low_dollars: "0.0000", open_dollars: "0.0000" },
  },
};

const HISTORICAL = {
  trade: {
    end_period_ts: 1754953200,
    open_interest: "100.00",
    price: { close: "0.3300", high: "0.3300", low: "0.3300", mean: "0.3300", open: "0.3300", previous: null },
    volume: "100.00",
    yes_ask: { close: "0.3400", high: "0.8300", low: "0.3300", open: "0.3300" },
    yes_bid: { close: "0.3000", high: "0.3200", low: "0.2600", open: "0.2600" },
  },
  previousOnly: {
    end_period_ts: 1754956800,
    open_interest: "100.00",
    price: { close: null, high: null, low: null, mean: null, open: null, previous: "0.3300" },
    volume: "0.00",
    yes_ask: { close: "0.3400", high: "0.3400", low: "0.3400", open: "0.3400" },
    yes_bid: { close: "0.3000", high: "0.3000", low: "0.3000", open: "0.3000" },
  },
};

const noTrade = { open: null, high: null, low: null, close: null, mean: null };

describe("normalizeCandle", () => {
  it("reads a live candle with a trade", () => {
    expect(normalizeCandle(LIVE.trade)).toEqual({
      endTs: 1772805600_000,
      yesBid: { open: 600000, high: 660000, low: 460000, close: 610000 },
      yesAsk: { open: 700000, high: 830000, low: 680000, close: 680000 },
      price: { open: 700000, high: 700000, low: 690000, close: 690000, mean: 696700, previous: 600000 },
      volume: 1500,
      openInterest: 1000,
    });
  });

  it("reads a historical candle, whose fields have no _dollars or _fp suffix", () => {
    expect(normalizeCandle(HISTORICAL.trade)).toEqual({
      endTs: 1754953200_000,
      yesBid: { open: 260000, high: 320000, low: 260000, close: 300000 },
      yesAsk: { open: 330000, high: 830000, low: 330000, close: 340000 },
      price: { open: 330000, high: 330000, low: 330000, close: 330000, mean: 330000, previous: null },
      volume: 10000,
      openInterest: 10000,
    });
  });

  it("reads periods without a trade the same way in both shapes", () => {
    expect(normalizeCandle(LIVE.previousOnly).price).toEqual({ ...noTrade, previous: 600000 });
    expect(normalizeCandle(HISTORICAL.previousOnly).price).toEqual({ ...noTrade, previous: 330000 });
    expect(normalizeCandle(LIVE.noTrade).price).toEqual({ ...noTrade, previous: null });
    // An empty side of the book comes as $0 bid or $1 ask, kept as Kalshi sent it.
    expect(normalizeCandle(LIVE.noTrade).yesBid.close).toBe(0);
    expect(normalizeCandle(LIVE.noTrade).volume).toBe(0);
  });

  it("leaves out what Kalshi left out", () => {
    expect(normalizeCandle({ end_period_ts: 1 })).toEqual({
      endTs: 1000,
      yesBid: { open: null, high: null, low: null, close: null },
      yesAsk: { open: null, high: null, low: null, close: null },
      price: { ...noTrade, previous: null },
      volume: null,
      openInterest: null,
    });
  });

  it("refuses a price outside $0–$1", () => {
    expect(() => normalizeCandle({ ...LIVE.trade, yes_bid: { close_dollars: "1.5000" } })).toThrow(RangeError);
  });
});

describe("toKalshiCandles", () => {
  it("returns candles oldest first", () => {
    expect(toKalshiCandles([LIVE.trade, LIVE.noTrade, LIVE.previousOnly]).map((c) => c.endTs / 1000)).toEqual([
      1759165200, 1772762400, 1772805600,
    ]);
  });
});
