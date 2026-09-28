import { describe, expect, it } from "vitest";
import { correlationStats, pearson } from "./correlation";
import { sampleFlag } from "./sample";

const pairs = (xs: number[], ys: number[]) => xs.map((x, i) => ({ x, y: ys[i] }));
const range = (n: number) => Array.from({ length: n }, (_, i) => i);

describe("pearson", () => {
  it("matches a hand-computed value", () => {
    // sxy = 6, sxx = 10, syy = 6 → r = 6 / √60
    expect(pearson([1, 2, 3, 4, 5], [2, 4, 5, 4, 5])).toBeCloseTo(6 / Math.sqrt(60), 12);
  });

  it("is ±1 for a perfect linear relationship", () => {
    expect(pearson([1, 2, 3], [10, 20, 30])).toBe(1);
    expect(pearson([1, 2, 3], [3, 2, 1])).toBe(-1);
  });

  it("is null when a series doesn't vary, or the input is too short or mismatched", () => {
    expect(pearson([0, 0, 0], [1, 2, 3])).toBeNull();
    expect(pearson([1, 2, 3], [5, 5, 5])).toBeNull();
    expect(pearson([1], [1])).toBeNull();
    expect(pearson([1, 2], [1, 2, 3])).toBeNull();
  });
});

describe("sampleFlag", () => {
  it("is insufficient below 10, small below 30, and ok from 30", () => {
    expect([0, 9, 10, 29, 30].map((n) => sampleFlag(n))).toEqual(["insufficient", "insufficient", "small", "small", "ok"]);
  });
});

describe("correlationStats", () => {
  it("reports no correlation below 10 pairs", () => {
    const stats = correlationStats(pairs(range(9), range(9)));
    expect(stats).toMatchObject({ r: null, n: 9, band: null, flag: "insufficient", noVariation: false });
  });

  it("reports r with a 1.96/√n band, flagged as small below 30 pairs", () => {
    const stats = correlationStats(pairs(range(12), range(12)));
    expect(stats).toMatchObject({ r: 1, n: 12, flag: "small" });
    expect(stats.band).toBeCloseTo(1.96 / Math.sqrt(12), 12);
    expect(correlationStats(pairs(range(30), range(30))).flag).toBe("ok");
  });

  it("counts non-zero Kalshi changes and flags when there are few", () => {
    const xs = range(40).map((i) => (i % 8 === 0 ? 1 : 0));
    const stats = correlationStats(pairs(xs, range(40)));
    expect(stats.kalshiMoves).toBe(5);
    expect(stats.fewKalshiMoves).toBe(true);
  });

  it("flags when Kalshi never moved, so r is undefined", () => {
    const stats = correlationStats(pairs(Array(20).fill(0), range(20)));
    expect(stats).toMatchObject({ r: null, n: 20, noVariation: true, kalshiMoves: 0 });
  });
});
