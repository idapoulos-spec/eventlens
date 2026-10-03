import { describe, expect, it } from "vitest";
import { adjustFamily, passes, type TestResult } from "./inference";
import { benjaminiHochberg, holm } from "./multiple-testing";

// Expected values from statsmodels 0.14: multipletests(p, method="holm" / "fdr_bh").
const P = [0.01, 0.04, 0.03, 0.005, 0.2, 0.04];
const HOLM = [0.05, 0.12, 0.12, 0.03, 0.2, 0.12];
const BH = [0.03, 0.048, 0.048, 0.03, 0.2, 0.048];

describe("holm", () => {
  it("matches statsmodels, ties included", () => {
    holm(P).forEach((v, i) => expect(v).toBeCloseTo(HOLM[i], 12));
  });

  it("skips tests that couldn't be run, without counting them", () => {
    expect(holm([0.01, null, 0.04])).toEqual([0.02, null, 0.04]);
    expect(holm([])).toEqual([]);
  });

  it("never exceeds 1 and never falls below the raw p-value", () => {
    const adjusted = holm([0.5, 0.6, 0.9]);
    adjusted.forEach((v, i) => expect(v).toBeGreaterThanOrEqual([0.5, 0.6, 0.9][i]));
    expect(Math.max(...(adjusted as number[]))).toBe(1);
  });
});

describe("benjaminiHochberg", () => {
  it("matches statsmodels, ties included", () => {
    benjaminiHochberg(P).forEach((v, i) => expect(v).toBeCloseTo(BH[i], 12));
  });

  it("skips tests that couldn't be run, without counting them", () => {
    expect(benjaminiHochberg([0.01, null, 0.04])).toEqual([0.02, null, 0.04]);
  });

  it("is never stricter than Holm", () => {
    const bh = benjaminiHochberg(P);
    holm(P).forEach((v, i) => expect(bh[i]!).toBeLessThanOrEqual(v! + 1e-15));
  });
});

describe("adjustFamily", () => {
  const result = (p: number | null): TestResult => ({
    estimate: 0.1,
    ci: null,
    p,
    holm: null,
    bh: null,
    role: "exploratory",
    family: null,
    method: "wild_bootstrap",
    interval: null,
    resampling: null,
    n: 50,
    nEffective: null,
    pUnavailable: null,
    ciUnavailable: null,
  });

  it("sets both adjustments and the family, and says which results pass", () => {
    const tests = adjustFamily([result(0.004), result(0.03), result(null)], "lead_lag");
    expect(tests.map((t) => [t.family, t.holm, t.bh])).toEqual([
      ["lead_lag", 0.008, 0.008],
      ["lead_lag", 0.03, 0.03],
      ["lead_lag", null, null],
    ]);
    expect(tests.map((t) => [passes(t, "raw"), passes(t, "holm"), passes(t, "bh")])).toEqual([
      [true, true, true],
      [true, true, true],
      [false, false, false],
    ]);
    expect(passes(adjustFamily([result(0.03), result(0.04)], "lead_lag")[0], "holm")).toBe(false);
  });
});
