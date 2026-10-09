import { describe, expect, it } from "vitest";
import { incrementalRange, MAX_PERIODS_PER_WINDOW, OVERLAP_PERIODS, periodMs, SETTLE_MS, splitWindows, targetRange } from "./ranges";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const utc = (iso: string) => Date.parse(iso);

describe("targetRange", () => {
  const now = utc("2026-10-07T23:42:30Z");

  it("runs an open market from its open to five minutes ago, on whole minutes", () => {
    const market = { openTime: utc("2025-09-29T14:00:00Z"), closeTime: utc("2028-01-26T18:59:00Z"), settlementTs: null };
    expect(targetRange(market, "60", now)).toEqual({ from: market.openTime, to: utc("2026-10-07T23:37:00Z") });
    expect(SETTLE_MS).toBe(5 * 60 * 1000);
  });

  it("ends a settled market one period after its close or settlement, whichever is later", () => {
    // FEDDECISION-24JAN-H0 closed on Jan 26, but its only candle ends on Jan 31, before it settled on Feb 1.
    const market = {
      openTime: utc("2023-12-13T18:00:00Z"),
      closeTime: utc("2024-01-26T18:55:00Z"),
      settlementTs: utc("2024-02-01T09:11:00.205Z"),
    };
    expect(targetRange(market, "60", now)).toEqual({ from: market.openTime, to: utc("2024-02-01T10:11:00Z") });
    expect(targetRange(market, "1440", now)?.to).toBe(utc("2024-02-02T09:11:00Z"));
    // Without a settlement time, the close decides: the 17:59 close's candle ends at 18:00.
    const closed = { ...market, closeTime: utc("2026-09-16T17:59:00Z"), settlementTs: null };
    expect(targetRange(closed, "60", now)?.to).toBe(utc("2026-09-16T18:59:00Z"));
  });

  it("has nothing for a market that hasn't opened, or has no open time", () => {
    expect(targetRange({ openTime: now, closeTime: now + DAY, settlementTs: null }, "60", now)).toBeNull();
    expect(targetRange({ openTime: null, closeTime: now, settlementTs: null }, "60", now)).toBeNull();
  });
});

describe("incrementalRange", () => {
  const target = { from: 0, to: 100 * HOUR };

  it("fetches everything when nothing was, and nothing when it's covered through the end", () => {
    expect(incrementalRange(target, null, "60")).toEqual(target);
    expect(incrementalRange(target, 100 * HOUR, "60")).toBeNull();
  });

  it("starts a few periods before the end of what's covered, never before the open", () => {
    expect(OVERLAP_PERIODS).toBe(2);
    expect(incrementalRange(target, 90 * HOUR, "60")).toEqual({ from: 88 * HOUR, to: 100 * HOUR });
    expect(incrementalRange(target, 90 * HOUR, "1440")).toEqual({ from: 42 * HOUR, to: 100 * HOUR });
    expect(incrementalRange(target, 30 * HOUR, "1440")).toEqual(target);
  });
});

describe("splitWindows", () => {
  it("keeps every window within the archive's 5,000 candles, consecutive and oldest first", () => {
    const range = { from: 0, to: 842 * DAY };
    const windows = splitWindows(range, "60");
    expect(windows).toHaveLength(5);
    expect(windows[0]).toEqual({ from: 0, to: MAX_PERIODS_PER_WINDOW * HOUR });
    expect(windows.at(-1)?.to).toBe(range.to);
    for (const [i, w] of windows.entries()) {
      expect((w.to - w.from) / periodMs("60")).toBeLessThanOrEqual(MAX_PERIODS_PER_WINDOW);
      expect(MAX_PERIODS_PER_WINDOW).toBeLessThanOrEqual(5_000);
      if (i > 0) expect(w.from).toBe(windows[i - 1].to);
    }
    expect(splitWindows(range, "1440")).toEqual([range]);
  });

  it("returns a short range whole", () => {
    expect(splitWindows({ from: 5, to: 10 }, "60")).toEqual([{ from: 5, to: 10 }]);
  });
});
