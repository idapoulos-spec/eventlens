import { describe, expect, it } from "vitest";
import { logReturns, realizedVolatility, sampleStdDev, TRADING_DAYS_PER_YEAR } from "./volatility";

describe("TRADING_DAYS_PER_YEAR", () => {
  it("is 252", () => {
    expect(TRADING_DAYS_PER_YEAR).toBe(252);
  });
});

describe("logReturns", () => {
  it("returns ln(p[i] / p[i-1]) for consecutive prices", () => {
    const returns = logReturns([100, 110, 99]);
    expect(returns).toHaveLength(2);
    expect(returns[0]).toBeCloseTo(Math.log(1.1), 12);
    expect(returns[1]).toBeCloseTo(Math.log(0.9), 12);
  });

  it("returns an empty array for empty data or a single price", () => {
    expect(logReturns([])).toEqual([]);
    expect(logReturns([100])).toEqual([]);
  });

  it("returns 0 for an unchanged price", () => {
    expect(logReturns([50, 50])).toEqual([0]);
  });

  it("skips pairs involving a zero or negative price", () => {
    expect(logReturns([100, 0, 110])).toEqual([]);
    const returns = logReturns([100, -5, 100, 110]);
    expect(returns).toHaveLength(1);
    expect(returns[0]).toBeCloseTo(Math.log(1.1), 12);
  });

  it("skips pairs involving a non-finite price", () => {
    expect(logReturns([100, Number.NaN, 110])).toEqual([]);
    expect(logReturns([100, Number.POSITIVE_INFINITY, 110])).toEqual([]);
  });
});

describe("sampleStdDev", () => {
  it("uses the n - 1 denominator", () => {
    // Mean 5, sum of squared deviations 32, so the sample variance is 32 / 7.
    expect(sampleStdDev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(Math.sqrt(32 / 7), 12);
    expect(sampleStdDev([1, 3])).toBeCloseTo(Math.SQRT2, 12);
  });

  it("is 0 for constant values", () => {
    expect(sampleStdDev([0.01, 0.01, 0.01])).toBe(0);
  });

  it("returns null for fewer than 2 values", () => {
    expect(sampleStdDev([])).toBeNull();
    expect(sampleStdDev([5])).toBeNull();
  });
});

describe("realizedVolatility", () => {
  it("annualizes the sample standard deviation of log returns, in percent", () => {
    const prices = [100, 102, 99, 101];
    const returns = [Math.log(102 / 100), Math.log(99 / 102), Math.log(101 / 99)];
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const sd = Math.sqrt(returns.reduce((a, r) => a + (r - mean) ** 2, 0) / (returns.length - 1));
    expect(realizedVolatility(prices)).toBeCloseTo(sd * Math.sqrt(252) * 100, 10);
  });

  it("works with exactly 3 prices (2 returns)", () => {
    // Returns +r and -r have a sample standard deviation of r·√2.
    const r = 0.01;
    const vol = realizedVolatility([100, 100 * Math.exp(r), 100]);
    expect(vol).toBeCloseTo(r * Math.SQRT2 * Math.sqrt(252) * 100, 10);
  });

  it("scales with the square root of periods per year", () => {
    const prices = [100, 102, 99, 101];
    const daily = realizedVolatility(prices)!;
    expect(realizedVolatility(prices, 252 * 4)).toBeCloseTo(daily * 2, 10);
  });

  it("is 0 for constant prices", () => {
    expect(realizedVolatility([100, 100, 100, 100])).toBe(0);
  });

  it("returns null for empty data", () => {
    expect(realizedVolatility([])).toBeNull();
  });

  it("returns null for fewer than 3 prices", () => {
    expect(realizedVolatility([100])).toBeNull();
    expect(realizedVolatility([100, 101])).toBeNull();
  });

  it("returns null when invalid prices leave fewer than 2 returns", () => {
    expect(realizedVolatility([100, 0, 101])).toBeNull();
  });

  it("ignores returns across a non-finite price instead of returning NaN", () => {
    const withGap = realizedVolatility([100, 101, Number.POSITIVE_INFINITY, 102, 103]);
    const returns = [Math.log(101 / 100), Math.log(103 / 102)];
    const sd = Math.abs(returns[0] - returns[1]) / Math.SQRT2;
    expect(withGap).toBeCloseTo(sd * Math.sqrt(252) * 100, 10);
  });
});
