import { describe, expect, it } from "vitest";
import { topOfHourCloses } from "@/lib/analytics/research";
import type { KalshiMarket } from "@/lib/kalshi/types";
import { sessionClosePoints } from "@/lib/market-data/session";
import type { StockBar } from "@/lib/market-data/types";
import { LIVE_WINDOW, parseWindowEnd, provenanceNote, researchStockPoints, windowFor } from "./window";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const bar = (t: number, close: number): StockBar => ({ t, open: close, high: close, low: close, close, volume: 100 });

describe("windowFor", () => {
  const NOW = Date.UTC(2026, 9, 7, 16);
  const market = (closeTime: string | null) => ({ closeTime }) as KalshiMarket;

  it("ends Research at the market's close once that has passed", () => {
    expect(windowFor({ market: market("2025-12-10T19:00:00Z"), archived: true }, NOW)).toEqual({
      end: Date.UTC(2025, 11, 10, 19),
      archived: true,
    });
    expect(windowFor({ market: market(new Date(NOW).toISOString()), archived: false }, NOW).end).toBe(NOW);
  });

  it("ends Research now while the market is open or its close is unknown", () => {
    expect(windowFor({ market: market("2026-12-09T19:00:00Z"), archived: false }, NOW)).toEqual(LIVE_WINDOW);
    expect(windowFor({ market: market(null), archived: false }, NOW)).toEqual(LIVE_WINDOW);
    expect(windowFor({ market: market("soon"), archived: false }, NOW)).toEqual(LIVE_WINDOW);
  });
});

describe("researchStockPoints", () => {
  // Two New York sessions in December (UTC−5): 9:30 AM–4:00 PM is 14:30–21:00 UTC.
  const day1 = Date.UTC(2025, 11, 9);
  const day2 = Date.UTC(2025, 11, 10);
  const session = (date: number, base: number) =>
    Array.from({ length: 13 }, (_, i) => bar(date + 15 * HOUR + i * 30 * 60 * 1000, base + i));
  const halfHourly = [...session(day1, 100), ...session(day2, 200)];
  const daily = [bar(day1, 112), bar(day2, 212)];
  const fetchedAt = day2 + 2 * DAY;

  it("matches what Research has always read when the window ends now", () => {
    expect(researchStockPoints({ halfHourly, daily, fetchedAt, end: null })).toEqual({
      hourly: topOfHourCloses(
        halfHourly.map((b) => ({ t: b.t, value: b.close })),
        fetchedAt,
      ),
      daily: sessionClosePoints(daily, halfHourly),
    });
  });

  it("keeps what came up to a past window's end, including a bar closing at that moment", () => {
    // The market closed at 2:00 PM New York on the second day.
    const end = day2 + 19 * HOUR;
    const { hourly, daily: closes } = researchStockPoints({ halfHourly, daily, fetchedAt, end });
    expect(hourly.at(-1)).toEqual({ t: end, value: 208 });
    expect(hourly.every((p) => p.t <= end)).toBe(true);
    // The second day's session closed after the market did, so only the first day's close counts.
    expect(closes).toEqual([{ t: day1 + 21 * HOUR, value: 112 }]);
  });
});

describe("parseWindowEnd", () => {
  const NOW = Date.UTC(2026, 9, 7);

  it("accepts no end, or a past time in milliseconds", () => {
    expect(parseWindowEnd(null, NOW)).toEqual({ ok: true, data: null });
    expect(parseWindowEnd(String(Date.UTC(2025, 11, 10, 19)), NOW)).toEqual({ ok: true, data: Date.UTC(2025, 11, 10, 19) });
  });

  it("rejects anything else", () => {
    for (const value of ["", "soon", "1.5", "-1", String(NOW + 1), String(Date.UTC(2014, 11, 31)), "9".repeat(16)]) {
      expect(parseWindowEnd(value, NOW)).toMatchObject({ ok: false, error: { code: "invalid_end" } });
    }
  });
});

describe("provenanceNote", () => {
  const through = Date.UTC(2026, 9, 7, 16);

  it("says nothing when no stored candles were used", () => {
    expect(provenanceNote({ storedThrough: null, liveFrom: Date.UTC(2026, 6, 1), liveFailed: false })).toBeNull();
  });

  it("says how far the stored history reaches, and what came after it", () => {
    expect(provenanceNote({ storedThrough: through, liveFrom: null, liveFailed: false })).toBe(
      "Kalshi research history stored through Oct 7, 2026, 12:00 PM EDT.",
    );
    expect(provenanceNote({ storedThrough: through, liveFrom: through - 2 * HOUR, liveFailed: false })).toBe(
      "Kalshi research history stored through Oct 7, 2026, 12:00 PM EDT, live after that.",
    );
    expect(provenanceNote({ storedThrough: through, liveFrom: null, liveFailed: true })).toBe(
      "Kalshi research history stored through Oct 7, 2026, 12:00 PM EDT; later candles couldn't be loaded.",
    );
  });
});
