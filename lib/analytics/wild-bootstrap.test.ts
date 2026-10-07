import { describe, expect, it } from "vitest";
import { lagCorrelationTests } from "./correlation-test";
import { mulberry32 } from "./random";
import { neweyWestLags, ols } from "./regression";
import { normal, simulateDaily, simulateHourly } from "./test-helpers";
import { bootstrapTs, drawWeights, frame } from "./wild-bootstrap";

/**
 * Twelve sessions of six hourly intervals: the stock moves 1.2× with a benchmark that
 * Kalshi partly tracks, so the market model absorbs part of Kalshi's changes. The window is
 * the last six sessions.
 */
function sample() {
  const changes = simulateHourly({ sessions: 12, seed: 5, sharedVolatility: true });
  const rng = mulberry32(6);
  const m = changes.map((c) => 0.0015 * normal(rng) + 0.0004 * c.probChangePp);
  const r = changes.map((c, i) => c.logReturn + 1.2 * m[i] + 0.0002);
  const block = Int32Array.from(changes, (_, i) => Math.floor(i / 6));
  const window = changes.map((_, i) => i).filter((i) => i >= 36);
  return { changes, m, r, block, window };
}

const fitOn = (X: number[][], y: number[], steps?: number[]) => ols(X, y, { steps, lags: steps ? neweyWestLags(y.length) : 0 })!;

/** y minus its OLS fit on X. */
const residuals = (X: number[][], y: number[]) => {
  const fit = fitOn(X, y);
  return y.map((v, i) => v - X[i].reduce((s, x, k) => s + x * fit.coef[k], 0));
};

describe("the closed form", () => {
  const { changes, m, r, block, window } = sample();
  const weights = drawWeights(12, 30, mulberry32(7));
  const x = window.map((i) => changes[i].probChangePp);
  const steps = window.map((i) => changes[i].step);
  const Z = m.map((v) => [1, v]);

  it("matches refitting the market model and the correlation in every draw", () => {
    const f = frame({ r, m, block }, { index: Int32Array.from(window), x, steps, market: false })!;
    // Kalshi tracks the benchmark here, so the market model absorbs a visible share of it.
    expect(f.kappa).toBeLessThan(0.99);
    const xMean = x.reduce((a, b) => a + b, 0) / x.length;
    const u = r.map(() => 0);
    window.forEach((i, p) => (u[i] = x[p] - xMean));
    const secondStage = (rs: number[], theta0: number) => {
      const abnormal = residuals(Z, rs);
      const fit = fitOn(
        x.map((v) => [1, v]),
        window.map((i) => abnormal[i]),
        steps,
      );
      return (fit.coef[1] - theta0) / fit.se[1]!;
    };
    for (const theta0 of [0, f.slope / 2, -0.001]) {
      const { observed, draws } = bootstrapTs(f, weights, theta0);
      expect(observed).toBeCloseTo(secondStage(r, theta0), 9);
      // The restricted model: the market model plus the null effect γ₀·u, γ₀ = θ₀/κ.
      const g = theta0 / f.kappa;
      const restricted = r.map((v, t) => v - g * u[t]);
      const e = residuals(Z, restricted);
      const fitted = restricted.map((v, t) => v - e[t] + g * u[t]);
      weights.forEach((w, d) => {
        const rs = fitted.map((v, t) => v + e[t] * w[block[t]]);
        expect(draws[d]).toBeCloseTo(secondStage(rs, theta0), 8);
      });
    }
  });

  it("matches refitting the whole regression in every draw, the benchmark included", () => {
    const rw = window.map((i) => r[i]);
    const mw = window.map((i) => m[i]);
    const bw = Int32Array.from(window, (i) => block[i] - 6);
    const f = frame({ r: rw, m: mw, block: bw }, { index: Int32Array.from(window, (_, p) => p), x, steps, market: true })!;
    const X = x.map((v, p) => [1, mw[p], v]);
    const full = (ys: number[], theta0: number) => {
      const fit = fitOn(X, ys, steps);
      return (fit.coef[2] - theta0) / fit.se[2]!;
    };
    expect(f.kappa).toBeCloseTo(1, 12);
    for (const theta0 of [0, f.slope / 2, 0.002]) {
      const { observed, draws } = bootstrapTs(f, weights.slice(0, 20), theta0);
      expect(observed).toBeCloseTo(full(rw, theta0), 9);
      const restricted = rw.map((v, p) => v - theta0 * x[p]);
      const e = residuals(
        mw.map((v) => [1, v]),
        restricted,
      );
      weights.slice(0, 20).forEach((w, d) => {
        const ys = rw.map((v, p) => v - e[p] + e[p] * w[bw[p]]);
        expect(draws[d]).toBeCloseTo(full(ys, theta0), 8);
      });
    }
  });
});

describe("raw-returns correlation tests", () => {
  // Recorded from the previous implementation (before alpha and beta were refitted in every
  // draw), which an independent Python reimplementation reproduced exactly: raw returns
  // must give the same numbers.
  const before = [
    { lag: -1, n: 105, r: -0.0031379833079827483, p: 0.965, ci: [-0.21563209171302755, 0.11163006095145897] },
    { lag: 0, n: 126, r: 0.2792683642012382, p: 0.08, ci: [-0.027617374459507744, 0.5715441183221651] },
    { lag: 2, n: 84, r: 0.06648876351544138, p: 0.235, ci: [-0.019651870447710752, 0.27441300429571536] },
    { lag: 0, n: 62, r: -0.023717380806707933, p: 0.884, ci: [-0.4165670095111228, 0.4192321888725063] },
    { lag: 1, n: 61, r: 0.009201119858481061, p: 0.927, ci: [-0.16358359968104955, 0.1838675030671417] },
  ];

  it("are unchanged, hourly and daily", () => {
    const hourly = lagCorrelationTests(simulateHourly({ sessions: 21, seed: 11, beta: 0.3, sharedVolatility: true }), [-1, 0, 2], "hourly", { draws: 199 });
    const daily = lagCorrelationTests(simulateDaily({ sessions: 62, seed: 12, beta: 0.2, sharedVolatility: true }), [0, 1], "daily");
    [...hourly, ...daily].forEach((l, i) => {
      // r to 12 places: the last bits of floating-point results can differ between machines.
      expect(l).toMatchObject({ lag: before[i].lag, n: before[i].n });
      expect(l.r).toBeCloseTo(before[i].r, 12);
      expect(l.test.p).toBe(before[i].p);
      expect(l.test.ci![0]).toBeCloseTo(before[i].ci[0], 9);
      expect(l.test.ci![1]).toBeCloseTo(before[i].ci[1], 9);
      expect(l.test.resampling).toMatchObject({ units: 21, refit: null });
    });
  });
});
