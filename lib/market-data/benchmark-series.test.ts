import { describe, expect, it } from "vitest";
import { benchmarkExpiry, benchmarkPoints } from "./benchmark-series";
import type { StockBar } from "./types";

const HALF_HOUR_MS = 30 * 60 * 1000;
const at = (iso: string) => Date.parse(iso);

/** Close-stamped 30-minute bars from `open` (UTC ISO), with closes 1, 2, 3, … */
function halfHourBars(open: string, count: number): StockBar[] {
  return Array.from({ length: count }, (_, i) => {
    const close = i + 1;
    return { t: at(open) + (i + 1) * HALF_HOUR_MS, open: close, high: close, low: close, close, volume: 100 };
  });
}

const dailyBar = (date: string, close: number): StockBar => ({ t: at(`${date}T00:00:00Z`), open: close, high: close, low: close, close, volume: 1 });

// Fri, Sep 25, 2026 (a full session, 9:30 AM–4:00 PM New York = 13:30–20:00 UTC), and Mon,
// Sep 28 up to its still-forming 11:30 AM–12:00 PM bar.
const halfHourly = [...halfHourBars("2026-09-25T13:30:00Z", 13), ...halfHourBars("2026-09-28T13:30:00Z", 5)];
const daily = [dailyBar("2026-09-25", 500), dailyBar("2026-09-28", 505)];

describe("benchmarkPoints", () => {
  it("keeps settled top-of-hour closes and completed sessions, stamped like the stock's", () => {
    // Fetched at 11:57 AM New York on Sep 28.
    const series = benchmarkPoints("SPY", halfHourly, daily, at("2026-09-28T15:57:00Z"));
    expect(series.symbol).toBe("SPY");
    expect(series.hourly.map((p) => new Date(p.t).toISOString().slice(5, 16))).toEqual([
      ...["14", "15", "16", "17", "18", "19", "20"].map((h) => `09-25T${h}:00`),
      "09-28T14:00",
      "09-28T15:00",
    ]);
    expect(series.daily).toEqual([{ t: at("2026-09-25T20:00:00Z"), value: 500 }]);
  });

  it("leaves out the day's bar while the session is under way, even if its last 30-minute bar has settled", () => {
    // Fetched at 11:40 AM, before Twelve Data shows the 11:30–12:00 bar.
    const series = benchmarkPoints("SPY", halfHourly.slice(0, -1), daily, at("2026-09-28T15:40:00Z"));
    expect(series.daily.map((p) => p.value)).toEqual([500]);
  });

  it("includes the session once it has closed and settled", () => {
    const full = [...halfHourBars("2026-09-25T13:30:00Z", 13), ...halfHourBars("2026-09-28T13:30:00Z", 13)];
    expect(benchmarkPoints("SPY", full, daily, at("2026-09-28T20:04:00Z")).daily).toHaveLength(1);
    expect(benchmarkPoints("SPY", full, daily, at("2026-09-28T20:05:00Z")).daily).toEqual([
      { t: at("2026-09-25T20:00:00Z"), value: 500 },
      { t: at("2026-09-28T20:00:00Z"), value: 505 },
    ]);
  });
});

describe("benchmarkExpiry", () => {
  it("lasts until the next 30-minute bar has settled", () => {
    expect(benchmarkExpiry(at("2026-09-28T15:04:00Z"))).toBe(at("2026-09-28T15:05:00Z"));
    expect(benchmarkExpiry(at("2026-09-28T15:05:00Z"))).toBe(at("2026-09-28T15:35:00Z"));
    expect(benchmarkExpiry(at("2026-09-28T15:20:00Z"))).toBe(at("2026-09-28T15:35:00Z"));
  });
});
