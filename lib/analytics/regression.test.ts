import { describe, expect, it } from "vitest";
import { confidenceInterval95, neweyWestLags, ols } from "./regression";

// 24 intervals in two runs (a gap between steps 21 and 40), with the Kalshi change (pp)
// zero in all but six. Expected values from statsmodels 0.14 (OLS with HC0, HC3, and HAC
// without the small-sample correction) and, for the gap-aware leverage-corrected version,
// numpy with the scores zero-padded across the gap.
const rm = [0, 0.12, -0.11, -0.36, -0.18, -0.4, 0.02, 0.54, -0.2, -0.25, 0.2, 0.14, 0.04, -0.37, -0.01, 0.28, -0.54, -0.18, -0.76, -0.52, -0.74, -0.09, -0.51, 0.11];
const dp = [0, 0, 0, 1.5, -0.5, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, -1, 0.5, 0, 0, 0, 0, 3, 0, 0];
const y = [0.1, 0.15, -0.85, -0.46, -0.24, -0.44, -0.38, 0.61, -0.5, -0.36, 0.63, -0.01, 0.09, -0.17, -0.14, 0.3, -0.58, -0.16, -1.31, -0.6, -0.5, -0.29, -0.36, 0.23];
const steps = [...Array.from({ length: 12 }, (_, i) => 10 + i), ...Array.from({ length: 12 }, (_, i) => 40 + i)];
const X = rm.map((m, i) => [1, m, dp[i]]);

const COEF = [-0.036535780197561825, 1.1057865426923734, -0.035332001692412476];

function expectClose(actual: (number | null)[], expected: number[], digits = 12) {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((v, i) => expect(v!).toBeCloseTo(expected[i], digits));
}

describe("ols", () => {
  it("matches statsmodels' coefficients and R²", () => {
    const fit = ols(X, y)!;
    expectClose(fit.coef, COEF);
    expect(fit.r2).toBeCloseTo(0.6844342659394393, 12);
    expect(fit).toMatchObject({ n: 24, df: 21, lags: 0 });
  });

  it("gives HC0 errors without lags or the leverage correction", () => {
    expectClose(ols(X, y, { leverageAdjust: false })!.se, [0.0532739058900929, 0.16907050690237657, 0.023996821245925146]);
  });

  it("gives HC3 errors and t(n − k) p-values with the leverage correction and no lags", () => {
    const fit = ols(X, y)!;
    expectClose(fit.se, [0.0572426156887619, 0.2051042855319381, 0.03308065432918968]);
    expectClose(fit.p, [0.5302027165479045, 2.393385512771418e-5, 0.2976197284817589], 10);
    expectClose(confidenceInterval95(fit, 2)!, [-0.10412698842804542, 0.03346298504322047], 9);
  });

  it("matches Newey–West HAC for consecutive observations", () => {
    expectClose(ols(X, y, { lags: 2, leverageAdjust: false })!.se, [0.045141931670104635, 0.14828962230994153, 0.02713330572429092]);
  });

  it("pairs lags only by step, so they never reach across a gap", () => {
    const fit = ols(X, y, { steps, lags: 2 })!;
    expectClose(fit.se, [0.04788068926407017, 0.18029859374276308, 0.0395802464499957]);
    expectClose(fit.p, [0.4539155845267179, 4.377272414238547e-6, 0.3821507829245918], 10);
  });

  it("is null when a regressor never varies or there are too few observations", () => {
    expect(ols(rm.map((m) => [1, m, 0]), y)).toBeNull();
    expect(ols([[1, 0.1], [1, 0.2]], [1, 2])).toBeNull();
  });

  it("has no leverage-corrected errors when one observation alone determines a coefficient", () => {
    // Only one non-zero Kalshi change: it's fitted exactly (leverage 1), so HC3 is undefined.
    const single = rm.map((m, i) => [1, m, i === 9 ? 2 : 0]);
    const fit = ols(single, y)!;
    expect(fit.se).toEqual([null, null, null]);
    expect(fit.p).toEqual([null, null, null]);
    expect(ols(single, y, { leverageAdjust: false })!.se.every((v) => v !== null)).toBe(true);
  });
});

describe("neweyWestLags", () => {
  it("grows slowly with the sample", () => {
    expect([10, 30, 120, 400].map(neweyWestLags)).toEqual([2, 3, 4, 5]);
  });
});
