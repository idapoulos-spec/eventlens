import { describe, expect, it } from "vitest";
import { formatAxisTick, formatTradingDate, timeTicks, tradingDayClose } from "./time";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Points every `stepMs` from `start` through `start + spanMs`. */
function series(start: number, spanMs: number, stepMs: number): { t: number }[] {
  return Array.from({ length: Math.floor(spanMs / stepMs) + 1 }, (_, i) => ({ t: start + i * stepMs }));
}

const labels = (ticks: number[] | undefined) => (ticks ?? []).map(formatAxisTick);

describe("tradingDayClose", () => {
  it("moves a daily bar from 00:00 UTC to the 4:00 PM New York close of its trading date", () => {
    expect(tradingDayClose(Date.parse("2026-09-25T00:00:00Z"))).toBe(Date.parse("2026-09-25T20:00:00Z")); // EDT
    expect(tradingDayClose(Date.parse("2026-11-02T00:00:00Z"))).toBe(Date.parse("2026-11-02T21:00:00Z")); // EST
    expect(formatTradingDate(tradingDayClose(Date.parse("2026-09-25T00:00:00Z")))).toBe("Fri, Sep 25, 2026");
  });
});

describe("timeTicks", () => {
  it("puts one tick at each New York midnight over a week", () => {
    const ticks = timeTicks(series(Date.parse("2026-09-21T16:00:00Z"), 7 * DAY_MS, HOUR_MS));
    expect(labels(ticks)).toEqual(["Sep 22", "Sep 23", "Sep 24", "Sep 25", "Sep 26", "Sep 27", "Sep 28"]);
  });

  it("keeps New York midnights across a daylight-saving change", () => {
    const ticks = timeTicks(series(Date.parse("2026-10-29T16:00:00Z"), 7 * DAY_MS, HOUR_MS));
    expect(labels(ticks)).toEqual(["Oct 30", "Oct 31", "Nov 1", "Nov 2", "Nov 3", "Nov 4", "Nov 5"]);
  });

  it("uses Mondays for about three months of daily closes", () => {
    const first = tradingDayClose(Date.parse("2026-05-29T00:00:00Z")); // a Friday
    const ticks = timeTicks(series(first, 122 * DAY_MS, DAY_MS))!;
    expect(ticks.length).toBeLessThanOrEqual(8);
    expect(labels(ticks)[0]).toBe("Jun 1");
    for (const t of ticks) expect(new Date(t - 4 * HOUR_MS).getUTCDay()).toBe(1);
  });

  it("keeps the dates when thinning 6-hour ticks that start at 6 AM", () => {
    // Exactly 48 hours from 6 AM New York gives nine 6-hour ticks, so every other one is
    // dropped; counting from the first tick would keep only 6 AM and 6 PM.
    const ticks = timeTicks(series(Date.parse("2026-09-26T10:00:00Z"), 2 * DAY_MS, HOUR_MS));
    expect(labels(ticks)).toEqual(["12 PM", "Sep 27", "12 PM", "Sep 28"]);
  });

  it("never returns more than maxTicks", () => {
    for (let startHour = 0; startHour < 24; startHour++) {
      for (const spanHours of [30, 47, 48, 72, 24 * 21, 24 * 60, 24 * 200]) {
        const ticks = timeTicks(series(Date.UTC(2026, 8, 1, startHour), spanHours * HOUR_MS, HOUR_MS)) ?? [];
        expect(ticks.length).toBeLessThanOrEqual(8);
      }
    }
  });
});
