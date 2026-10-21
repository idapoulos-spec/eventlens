import { describe, expect, it } from "vitest";
import { adjustIntradayForSplits, sessionClosePoints, sessionCloseTimes, toHourlyBars, tradingDayClose } from "./session";
import type { StockBar } from "./types";

const HALF_HOUR_MS = 30 * 60 * 1000;
const NY = "America/New_York";

/** Close-stamped 30-minute bars from `open` (UTC ISO) for `count` bars, with closes 1, 2, 3, … */
function halfHourBars(open: string, count: number, firstClose = 1): StockBar[] {
  const start = Date.parse(open);
  return Array.from({ length: count }, (_, i) => {
    const close = firstClose + i;
    return { t: start + (i + 1) * HALF_HOUR_MS, open: close - 0.5, high: close + 1, low: close - 1, close, volume: 100 };
  });
}

const nyTime = (bar: StockBar) =>
  new Intl.DateTimeFormat("en-US", { timeZone: NY, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(bar.t);

describe("toHourlyBars", () => {
  // Fri, Sep 25 and Mon, Sep 28, 2026: 09:30–16:00 New York (13:30–20:00 UTC), 13 bars each.
  const bars = [...halfHourBars("2026-09-25T13:30:00Z", 13), ...halfHourBars("2026-09-28T13:30:00Z", 13, 101)];

  it("matches Twelve Data's hourly bars: from 9:30 on the half hour, with 15:30–16:00 on its own", () => {
    const hourly = toHourlyBars(bars, HALF_HOUR_MS, NY);
    expect(hourly.map(nyTime)).toEqual([
      ...["10:30 AM", "11:30 AM", "12:30 PM", "1:30 PM", "2:30 PM", "3:30 PM", "4:00 PM"].map((t) => `Sep 25, ${t}`),
      ...["10:30 AM", "11:30 AM", "12:30 PM", "1:30 PM", "2:30 PM", "3:30 PM", "4:00 PM"].map((t) => `Sep 28, ${t}`),
    ]);
  });

  it("combines open, high, low, close, and volume", () => {
    const [first] = toHourlyBars(bars, HALF_HOUR_MS, NY);
    expect(first).toMatchObject({ open: 0.5, high: 3, low: 0, close: 2, volume: 200 });
    expect(toHourlyBars(bars, HALF_HOUR_MS, NY)[6]).toMatchObject({ open: 12.5, close: 13, volume: 100 });
  });

  it("keeps the volume known when only one half hour reports it", () => {
    const partial = halfHourBars("2026-09-25T13:30:00Z", 2).map((b, i) => ({ ...b, volume: i === 0 ? null : 50 }));
    expect(toHourlyBars(partial, HALF_HOUR_MS, NY)[0].volume).toBe(50);
  });

  it("returns nothing for no bars", () => {
    expect(toHourlyBars([], HALF_HOUR_MS, NY)).toEqual([]);
  });
});

describe("tradingDayClose", () => {
  it("stamps a daily bar at 4:00 PM New York on its trading date", () => {
    expect(tradingDayClose(Date.parse("2026-09-25T00:00:00Z"))).toBe(Date.parse("2026-09-25T20:00:00Z")); // EDT
    expect(tradingDayClose(Date.parse("2026-11-02T00:00:00Z"))).toBe(Date.parse("2026-11-02T21:00:00Z")); // EST
  });
});

describe("sessionCloseTimes", () => {
  it("finds each session's actual close, including early closes", () => {
    const bars = [
      ...halfHourBars("2026-11-25T14:30:00Z", 13), // Wed, Nov 25: full session, closes 4:00 PM EST
      ...halfHourBars("2026-11-27T14:30:00Z", 7), // Fri, Nov 27: closes early at 1:00 PM EST
    ];
    const closes = sessionCloseTimes(bars);
    expect([...closes.entries()]).toEqual([
      [Date.parse("2026-11-25T00:00:00Z"), Date.parse("2026-11-25T21:00:00Z")],
      [Date.parse("2026-11-27T00:00:00Z"), Date.parse("2026-11-27T18:00:00Z")],
    ]);
  });
});

describe("sessionClosePoints", () => {
  it("stamps each daily close at its session's end, or 4:00 PM where the 30-minute bars don't reach", () => {
    // Fri, Nov 27, 2026 closes early at 1:00 PM (18:00 UTC); Mon, Nov 30 has no 30-minute bars.
    const bars = halfHourBars("2026-11-27T14:30:00Z", 7);
    const day = (date: string, close: number): StockBar => ({ t: Date.parse(`${date}T00:00:00Z`), open: close, high: close, low: close, close, volume: 1 });
    expect(sessionClosePoints([day("2026-11-27", 10), day("2026-11-30", 11)], bars)).toEqual([
      { t: Date.parse("2026-11-27T18:00:00Z"), value: 10 },
      { t: Date.parse("2026-11-30T21:00:00Z"), value: 11 },
    ]);
  });
});

describe("adjustIntradayForSplits", () => {
  // Four December sessions (New York is UTC−5): 9:30 AM–4:00 PM is 14:30–21:00 UTC.
  const days = [Date.UTC(2025, 11, 8), Date.UTC(2025, 11, 9), Date.UTC(2025, 11, 10), Date.UTC(2025, 11, 11)];
  const session = (date: number, base: number) =>
    Array.from({ length: 13 }, (_, i) => ({ t: date + 15 * 3_600_000 + i * 1_800_000, open: base + i, high: base + i, low: base + i, close: base + i, volume: 100 }));
  const daily = (closes: number[]) => days.map((t, i) => ({ t, open: closes[i], high: closes[i], low: closes[i], close: closes[i], volume: 1000 }));

  it("leaves bars alone when the daily closes agree with the last half hour's", () => {
    const halfHourly = days.flatMap((d, i) => session(d, 100 + i));
    // A closing auction a little off the last trade is not a split.
    const bars = adjustIntradayForSplits(halfHourly, daily([112.3, 112.8, 114.1, 115.0]));
    expect(bars).toBe(halfHourly);
  });

  it("scales the sessions before a 10-for-1 split onto the adjusted daily basis, keeping returns within each session", () => {
    // As traded: about 1,000 before the split (the first two sessions), about 100 after.
    const halfHourly = [...session(days[0], 1000), ...session(days[1], 1010), ...session(days[2], 101), ...session(days[3], 102)];
    // Split-adjusted daily closes: the pre-split ones divided by 10 (with an auction a hair off).
    const bars = adjustIntradayForSplits(halfHourly, daily([101.25, 102.18, 113, 114]));
    expect(bars.slice(0, 13).map((b) => b.close)).toEqual(session(days[0], 1000).map((b) => expect.closeTo(b.close / 10, 10)));
    expect(bars[13].volume).toBe(1000);
    expect(bars.slice(26)).toEqual(halfHourly.slice(26));
    expect(Math.log(bars[12].close / bars[0].close)).toBeCloseTo(Math.log(1012 / 1000), 12);
  });

  it("uses each split's own factor, as a simple fraction", () => {
    // A 3-for-2 split after the first session, then a 2-for-1 after the third.
    const halfHourly = [...session(days[0], 300), ...session(days[1], 200), ...session(days[2], 201), ...session(days[3], 100)];
    const bars = adjustIntradayForSplits(halfHourly, daily([312 / 3, 212 / 2, 213 / 2, 112]));
    expect(bars[0].close).toBeCloseTo(300 / 3, 10);
    expect(bars[13].close).toBeCloseTo(200 / 2, 10);
    expect(bars[39].close).toBe(100);
  });
});

