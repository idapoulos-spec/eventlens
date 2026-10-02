import { describe, expect, it } from "vitest";
import { tQuantile, tTwoSidedP } from "./t-distribution";

// Expected values from scipy.stats.t (scipy 1.13).
describe("tTwoSidedP", () => {
  it.each([
    [2.0, 10, 0.07338803477074039],
    [1.5, 3, 0.23058386524482283],
    [0.3, 1, 0.8144528418445154],
    [4.2, 57, 9.480457453535576e-5],
    [-2.5, 397, 0.012821904182690158],
    [0, 5, 1],
  ])("P(|T| ≥ |%d|) with %i df", (t, df, p) => {
    expect(tTwoSidedP(t, df)!).toBeCloseTo(p, 12);
  });

  it("is null for an undefined statistic or no degrees of freedom", () => {
    expect(tTwoSidedP(Number.NaN, 5)).toBeNull();
    expect(tTwoSidedP(Infinity, 5)).toBeNull();
    expect(tTwoSidedP(1, 0)).toBeNull();
  });
});

describe("tQuantile", () => {
  it.each([
    [1, 12.706204736432095],
    [5, 2.570581835636314],
    [30, 2.0422724563012373],
    [397, 1.9659574279667493],
  ])("97.5th percentile with %i df", (df, q) => {
    expect(tQuantile(0.975, df)!).toBeCloseTo(q, 9);
  });

  it("is null outside [0.5, 1)", () => {
    expect(tQuantile(0.3, 5)).toBeNull();
    expect(tQuantile(1, 5)).toBeNull();
  });
});
