import { describe, expect, it } from "vitest";
import type { ChangePoint } from "./changes";
import { crossCorrelation } from "./lead-lag";

/** Deterministic pseudo-random numbers in [−1, 1). */
function noise(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2 ** 31;
    return (s / 2 ** 31) * 2 - 1;
  };
}

const change = (step: number, probChangePp: number, logReturn: number): ChangePoint => ({ t: step * 1000, step, probChangePp, logReturn });

describe("crossCorrelation", () => {
  it("peaks at a positive lag when the stock moves after Kalshi", () => {
    const next = noise(7);
    const kalshi = Array.from({ length: 200 }, () => next());
    // The stock return in slot s repeats the Kalshi change from slot s − 2.
    const changes = kalshi.map((x, s) => change(s, x, s >= 2 ? kalshi[s - 2] / 100 : 0));
    const lags = crossCorrelation(changes, 3, "daily");

    expect(lags.map((l) => l.lag)).toEqual([-3, -2, -1, 0, 1, 2, 3]);
    const best = lags.reduce((a, b) => (Math.abs(b.r ?? 0) > Math.abs(a.r ?? 0) ? b : a));
    expect(best.lag).toBe(2);
    expect(best.r).toBeCloseTo(1, 10);
    expect(best.n).toBe(198);
    for (const l of lags) if (l.lag !== 2) expect(Math.abs(l.r!)).toBeLessThan(0.3);
  });

  it("peaks at a negative lag when the stock moves first", () => {
    const next = noise(11);
    const stock = Array.from({ length: 200 }, () => next());
    const changes = stock.map((y, s) => change(s, s >= 1 ? stock[s - 1] * 100 : 0, y));
    const best = crossCorrelation(changes, 3, "daily").reduce((a, b) => (Math.abs(b.r ?? 0) > Math.abs(a.r ?? 0) ? b : a));
    expect(best.lag).toBe(-1);
  });

  it("never pairs slots across a gap, such as overnight", () => {
    // Two sessions of six hourly changes each, 18 hours apart.
    const next = noise(3);
    const changes = [10, 11, 12, 13, 14, 15, 34, 35, 36, 37, 38, 39].map((s) => change(s, next(), next()));
    const lags = crossCorrelation(changes, 3, "daily");
    expect(lags.map((l) => l.n)).toEqual([6, 8, 10, 12, 10, 8, 6]);
  });

  it("returns empty stats with no changes", () => {
    expect(crossCorrelation([], 1, "daily").map((l) => [l.lag, l.n, l.r])).toEqual([
      [-1, 0, null],
      [0, 0, null],
      [1, 0, null],
    ]);
  });
});
