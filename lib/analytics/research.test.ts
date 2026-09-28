import { describe, expect, it } from "vitest";
import { HOUR_MS } from "./probability";
import { buildResearchRows, rowsSince, topOfHourCloses, type SourcedPoint } from "./research";
import type { TimePoint } from "./types";

// Mon, Sep 28, 2026 (EDT): 10:00 AM New York is 14:00 UTC.
const at = (utcHour: number, minute = 0) => Date.UTC(2026, 8, 28, utcHour, minute);
const stock = (...pairs: [number, number][]): TimePoint[] => pairs.map(([t, value]) => ({ t, value }));
const mid = (t: number, value: number): SourcedPoint => ({ t, value, source: "midpoint" });

describe("buildResearchRows", () => {
  it("reads the Kalshi quote in effect at each stock close, including hours with no candle", () => {
    const rows = buildResearchRows({
      stock: stock([at(14), 100], [at(15), 101], [at(16), 102]),
      // No candle ends at 14:00 or 16:00: nothing changed in those hours.
      kalshi: [mid(at(13), 0.4), mid(at(15), 0.45)],
      closeTime: null,
      resolution: "hourly",
    });
    expect(rows.map((r) => [r.probability, r.kalshiAsOf, r.exclusion])).toEqual([
      [0.4, at(13), null],
      [0.45, at(15), null],
      [0.45, at(15), null],
    ]);
  });

  it("uses a candle that ends exactly at the stock close", () => {
    const rows = buildResearchRows({ stock: stock([at(14), 100]), kalshi: [mid(at(14), 0.5)], closeTime: null, resolution: "hourly" });
    expect(rows[0]).toMatchObject({ probability: 0.5, kalshiAsOf: at(14), exclusion: null });
  });

  it("flags rows before the first candle, after the market closed, and from last-trade estimates", () => {
    const rows = buildResearchRows({
      stock: stock([at(14), 100], [at(15), 100], [at(16), 100], [at(17), 100]),
      kalshi: [mid(at(15), 0.5), { t: at(16), value: 0.55, source: "last_price" }, mid(at(16, 30), 0.6)],
      closeTime: at(16, 45),
      resolution: "hourly",
    });
    expect(rows.map((r) => r.exclusion)).toEqual(["before_kalshi", null, "kalshi_last_price", "market_closed"]);
    expect(rows[0]).toMatchObject({ probability: null, kalshiSource: null, kalshiAsOf: null });
    expect(rows[3]).toMatchObject({ probability: 0.6, kalshiAsOf: at(16, 30) });
  });

  it("numbers hourly rows by hour and daily rows by trading day", () => {
    const kalshi = [mid(at(0), 0.5)];
    const hourly = buildResearchRows({ stock: stock([at(14), 1], [at(15), 1], [at(20) + 24 * HOUR_MS, 1]), kalshi, closeTime: null, resolution: "hourly" });
    expect(hourly.map((r) => r.step - hourly[0].step)).toEqual([0, 1, 30]);
    // A weekend between two sessions is still one step for daily rows.
    const daily = buildResearchRows({ stock: stock([at(20), 1], [at(20) + 3 * 24 * HOUR_MS, 1]), kalshi, closeTime: null, resolution: "daily" });
    expect(daily.map((r) => r.step)).toEqual([0, 1]);
  });

  it("sorts its input and drops stock prices that aren't positive", () => {
    const rows = buildResearchRows({
      stock: stock([at(16), 102], [at(14), 100], [at(15), 0], [at(17), Number.NaN]),
      kalshi: [mid(at(15), 0.5), mid(at(13), 0.4)],
      closeTime: null,
      resolution: "hourly",
    });
    expect(rows.map((r) => [r.t, r.stockClose, r.probability])).toEqual([
      [at(14), 100, 0.4],
      [at(16), 102, 0.5],
    ]);
  });
});

describe("topOfHourCloses", () => {
  const bars = stock([at(14), 1], [at(14, 30), 2], [at(15), 3], [at(15, 30), 4], [at(16), 5]);

  it("keeps closes on the hour, which line up with Kalshi's hourly candles", () => {
    expect(topOfHourCloses(bars, at(17)).map((b) => b.value)).toEqual([1, 3, 5]);
  });

  it("leaves out bars that are still forming or closed moments ago", () => {
    expect(topOfHourCloses(bars, at(15, 50)).map((b) => b.value)).toEqual([1, 3]);
    expect(topOfHourCloses(bars, at(16, 2)).map((b) => b.value)).toEqual([1, 3]);
    expect(topOfHourCloses(bars, at(16, 5)).map((b) => b.value)).toEqual([1, 3, 5]);
  });
});

describe("rowsSince", () => {
  it("keeps rows after the cutoff", () => {
    const rows = buildResearchRows({ stock: stock([at(14), 1], [at(15), 1], [at(16), 1]), kalshi: [], closeTime: null, resolution: "hourly" });
    expect(rowsSince(rows, at(14)).map((r) => r.t)).toEqual([at(15), at(16)]);
  });
});
