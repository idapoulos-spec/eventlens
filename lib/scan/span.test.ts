import { describe, expect, it } from "vitest";
import { LONG_HISTORY_MS, STOCK_HISTORY_MS } from "@/lib/history/window";
import { benchmarkFromCache, halfHourlyRequests, MAX_PRICE_REQUESTS, priceCredits, priceSpan } from "./span";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 21, 18);

describe("priceSpan", () => {
  const open = { end: null, start: Date.UTC(2025, 0, 6) };
  const settled = { end: Date.UTC(2025, 11, 10, 19), start: Date.UTC(2025, 2, 3) };

  it("reaches 100 days before each end for the 7, 30, and 90-day windows", () => {
    expect(priceSpan([open], 90, NOW)).toEqual({ from: NOW - STOCK_HISTORY_MS, to: NOW, live: true });
    expect(priceSpan([settled], 30, NOW)).toEqual({ from: settled.end - STOCK_HISTORY_MS, to: settled.end, live: false });
    expect(priceSpan([open, settled], 7, NOW)).toEqual({ from: settled.end - STOCK_HISTORY_MS, to: NOW, live: true });
  });

  it("reaches back to each candidate's open, at most 540 days, for the longer windows", () => {
    expect(priceSpan([open], 365, NOW)!.from).toBe(NOW - LONG_HISTORY_MS);
    expect(priceSpan([settled], "all", NOW)!.from).toBe(settled.start);
    expect(priceSpan([{ end: null, start: NOW - 30 * DAY }], 180, NOW)!.from).toBe(NOW - STOCK_HISTORY_MS);
  });

  it("is null without candidates", () => {
    expect(priceSpan([], 90, NOW)).toBeNull();
  });
});

describe("halfHourlyRequests and priceCredits", () => {
  it("asks for the latest bars from the span's start when it fits one request, as the pages do", () => {
    const span = { from: NOW - 100 * DAY, to: NOW, live: true };
    expect(halfHourlyRequests(span)).toEqual([{ startDate: "2026-07-13" }]);
    // Stock and SPY: one 30-minute and one daily request each. A single analysis also fetches a quote (5).
    expect(priceCredits(span)).toBe(4);
    expect(benchmarkFromCache(span, NOW)).toBe(true);
  });

  it("splits a longer span into 540-day requests, each to the day after its end", () => {
    const span = { from: Date.UTC(2023, 0, 2), to: Date.UTC(2025, 11, 10, 19), live: false };
    // 1,073 days: two requests, overlapping by a day (bars on the shared date are kept once).
    expect(halfHourlyRequests(span)).toEqual([
      { startDate: "2023-01-02", endDate: "2024-06-26" },
      { startDate: "2024-06-25", endDate: "2025-12-11" },
    ]);
    expect(priceCredits(span)).toBe(6);
    expect(benchmarkFromCache(span, NOW)).toBe(false);
  });

  it("refuses nothing itself, but a span of over three requests costs more than one scan may", () => {
    const span = { from: Date.UTC(2021, 0, 4), to: NOW, live: true };
    expect(priceCredits(span)).toBeGreaterThan(MAX_PRICE_REQUESTS);
  });
});
