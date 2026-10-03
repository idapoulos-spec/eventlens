import { describe, expect, it } from "vitest";
import type { ChangePoint } from "./changes";
import { blockLayout, effectiveN, lagCorrelationTests, robustSlopeT, runDays, weightPatterns } from "./correlation-test";
import { crossCorrelation } from "./lead-lag";
import { HOUR_MS } from "./probability";
import { neweyWestLags, ols } from "./regression";
import { MIN_BOOTSTRAP_BLOCKS } from "./sample";
import { simulateDaily, simulateHourly } from "./test-helpers";

// Simulations run hundreds of analyses; allow for slow CI machines.
const SIMULATION_TIMEOUT = 120_000;

// Small draw counts keep the simulations fast; the page uses WILD_DRAWS.
const DRAWS = 199;

/** Share of simulated datasets in which the lag-0 test rejects at 5%, and how many were testable. */
function rejectionRate(make: (seed: number) => ChangePoint[], resolution: "hourly" | "daily", reps: number) {
  let rejected = 0;
  let tested = 0;
  for (let s = 0; s < reps; s++) {
    const [{ test }] = lagCorrelationTests(make(2000 + s), [0], resolution, { draws: DRAWS });
    if (test.p === null) continue;
    tested++;
    if (test.p < 0.05) rejected++;
  }
  return { rate: rejected / tested, tested };
}

describe("robustSlopeT", () => {
  it("matches the slope's t from ols with Newey–West lags by step and the HC3 correction", () => {
    // Two runs of hourly changes with a gap, Kalshi zero in most.
    const x = [0, 0, 1.5, -0.5, 0, 0, 0, 2, 0, 0, 0, -1, 0.5, 0, 0, 0, 3, 0, 0, 0.5];
    const y = [0.1, -0.85, -0.46, -0.24, -0.44, -0.38, 0.61, -0.5, -0.36, 0.63, -0.01, 0.09, -0.17, -0.14, 0.3, -0.58, -0.16, -1.31, -0.6, -0.5];
    const steps = [...Array.from({ length: 10 }, (_, i) => 10 + i), ...Array.from({ length: 10 }, (_, i) => 40 + i)];
    const fit = ols(x.map((v) => [1, v]), y, { steps, lags: neweyWestLags(x.length) })!;
    expect(robustSlopeT(x, y, steps)).toBeCloseTo(fit.t[1]!, 10);
  });

  it("is null when Kalshi never moved or one interval alone decides the slope", () => {
    expect(robustSlopeT([0, 0, 0, 0], [1, 2, 3, 4], [1, 2, 3, 4])).toBeNull();
    expect(robustSlopeT([0, 0, 2, 0, 0], [1, 2, 3, 1, 2], [1, 2, 3, 4, 5])).toBeNull();
  });
});

describe("blockLayout", () => {
  it("groups hourly changes by New York trading date, across a daylight-saving switch", () => {
    // 3:00 PM New York on Fri Mar 6 (EST) and Mon Mar 9, 2026 (EDT), and 10:00 AM on Mar 9.
    const at = (utc: number, step: number): ChangePoint => ({ t: utc, step, probChangePp: 0, logReturn: 0 });
    const changes = [at(Date.UTC(2026, 2, 6, 20), 1), at(Date.UTC(2026, 2, 9, 14), 2), at(Date.UTC(2026, 2, 9, 19), 3)];
    expect(blockLayout(changes, "hourly")).toMatchObject({ unit: "session", blocks: 2, runDays: null });
    expect(Array.from(blockLayout(changes, "hourly").block)).toEqual([0, 1, 1]);
  });

  it("splits daily changes into runs of consecutive trading days, skipping empty runs", () => {
    const changes = [0, 1, 2, 3, 6, 7].map((step) => ({ t: step, step, probChangePp: 0, logReturn: 0 }));
    expect(runDays(6)).toBe(2);
    const layout = blockLayout(changes, "daily");
    expect(layout).toMatchObject({ unit: "day_run", blocks: 3, runDays: 2 });
    expect(Array.from(layout.block)).toEqual([0, 0, 1, 1, 2, 2]);
  });
});

describe("effectiveN", () => {
  it("shrinks n when both series are autocorrelated the same way, and never exceeds n", () => {
    const steps = Array.from({ length: 40 }, (_, i) => i);
    const smooth = Float64Array.from(steps, (i) => Math.sin(i / 3));
    expect(effectiveN(40, smooth, smooth, steps)).toBeLessThan(20);
    const alternating = Float64Array.from(steps, (i) => (i % 2 ? 1 : -1));
    expect(effectiveN(40, alternating, smooth, steps)).toBe(40);
  });
});

describe("lagCorrelationTests", () => {
  const changes = simulateHourly({ sessions: 21, seed: 1, beta: 0.6 });

  it("reports r with a wild bootstrap p-value and an interval that excludes zero exactly when p < 0.05", () => {
    const [lag0, lag2] = lagCorrelationTests(changes, [0, 2], "hourly", { draws: DRAWS });
    expect(lag0.test).toMatchObject({ method: "wild_bootstrap", interval: "wild_bootstrap", role: "exploratory", n: 126 });
    expect(lag0.test.estimate).toBe(lag0.r);
    expect(lag0.test.p).toBeLessThan(0.05);
    expect(lag0.test.ci![0]).toBeGreaterThan(0);
    expect(lag0.test.ci![0]).toBeLessThan(lag0.r!);
    expect(lag0.test.ci![1]).toBeGreaterThan(lag0.r!);
    expect(lag0.test.resampling).toMatchObject({ unit: "session", units: 21, draws: DRAWS, minP: 1 / (DRAWS + 1) });
    expect(lag0.test.nEffective).toBeGreaterThan(0);
    expect(lag0.test.nEffective).toBeLessThanOrEqual(126);
    // Lag 2 pairs only within a session: 4 per session.
    expect(lag2.n).toBe(84);
  });

  it("gives the same numbers every time, whatever other lags are tested alongside", () => {
    const alone = lagCorrelationTests(changes, [0], "hourly", { draws: DRAWS })[0].test;
    const together = lagCorrelationTests(changes, [-1, 0, 1], "hourly", { draws: DRAWS })[1].test;
    expect(together).toEqual(alone);
    expect(lagCorrelationTests(changes, [0], "hourly", { draws: DRAWS })[0].test).toEqual(alone);
  });

  it("withholds the p-value and interval with too few sessions, saying how many and the smallest possible p", () => {
    const week = simulateHourly({ sessions: 5, seed: 1, beta: 0.6 });
    const [{ test }] = lagCorrelationTests(week, [0], "hourly");
    expect(test).toMatchObject({ p: null, ci: null, pUnavailable: "too_few_blocks", ciUnavailable: "too_few_blocks" });
    expect(test.estimate).not.toBeNull();
    expect(test.resampling).toMatchObject({ unit: "session", units: 5, draws: 0, arrangements: weightPatterns(5), minP: 1 / weightPatterns(5)! });
    expect(MIN_BOOTSTRAP_BLOCKS).toBe(8);
  });

  it("reports nothing below 10 pairs, or when Kalshi never moved", () => {
    expect(lagCorrelationTests(changes.slice(0, 9), [0], "hourly")[0].test.pUnavailable).toBe("too_few_pairs");
    const flat = changes.map((c) => ({ ...c, probChangePp: 0 }));
    expect(lagCorrelationTests(flat, [0], "hourly")[0].test).toMatchObject({ estimate: null, p: null, pUnavailable: "no_variation" });
  });
});

describe("simulations: false positives on independent zero-heavy series", () => {
  // Kalshi zero in ~80% of hours, 0.5 pp steps, moves that continue; stock volatility
  // varying by day and hour. Seeds are fixed, so these results are the same on every run.
  it("rejects about 5% of the time at the 5% level, hourly, 21 sessions", () => {
    const { rate, tested } = rejectionRate((seed) => simulateHourly({ sessions: 21, seed }), "hourly", 400);
    expect(tested).toBe(400);
    expect(rate).toBeGreaterThan(0.02);
    expect(rate).toBeLessThan(0.075);
  }, SIMULATION_TIMEOUT);

  it("holds when both are volatile in the same hours and on the same news days, with no link in direction", () => {
    const { rate } = rejectionRate((seed) => simulateHourly({ sessions: 21, seed, sharedVolatility: true }), "hourly", 400);
    expect(rate).toBeGreaterThan(0.02);
    expect(rate).toBeLessThan(0.075);
  }, SIMULATION_TIMEOUT);

  it("holds for daily changes over 90 days, and over 30 days", () => {
    expect(rejectionRate((seed) => simulateDaily({ sessions: 62, seed, sharedVolatility: true }), "daily", 300).rate).toBeLessThan(0.075);
    expect(rejectionRate((seed) => simulateDaily({ sessions: 20, seed, sharedVolatility: true }), "daily", 300).rate).toBeLessThan(0.075);
  }, SIMULATION_TIMEOUT);

  it("keeps the chance of any false positive across the 7 lags near 5% after Holm", () => {
    let anyRaw = 0;
    let anyHolm = 0;
    const reps = 200;
    for (let s = 0; s < reps; s++) {
      const lags = crossCorrelation(simulateHourly({ sessions: 21, seed: 4000 + s, sharedVolatility: true }), 3, "hourly", { draws: DRAWS });
      if (lags.some((l) => l.test.p !== null && l.test.p < 0.05)) anyRaw++;
      if (lags.some((l) => l.test.holm !== null && l.test.holm < 0.05)) anyHolm++;
    }
    // Uncorrected, some lag crosses 5% far more often than 5% of the time.
    expect(anyRaw / reps).toBeGreaterThan(0.12);
    expect(anyHolm / reps).toBeLessThan(0.075);
  }, SIMULATION_TIMEOUT);
});

describe("simulations: detecting a built-in relationship", () => {
  it("finds a same-hour relationship in most samples of 30 days", () => {
    const { rate } = rejectionRate((seed) => simulateHourly({ sessions: 21, seed, beta: 0.6 }), "hourly", 100);
    expect(rate).toBeGreaterThan(0.8);
  }, SIMULATION_TIMEOUT);

  it("finds a relationship two hours later at lag +2, after Holm", () => {
    let found = 0;
    const reps = 100;
    for (let s = 0; s < reps; s++) {
      const lags = crossCorrelation(simulateHourly({ sessions: 62, seed: 6000 + s, beta: 0.6, lag: 2 }), 3, "hourly", { draws: DRAWS });
      if (lags.find((l) => l.lag === 2)!.test.holm! < 0.05) found++;
    }
    expect(found / reps).toBeGreaterThan(0.8);
  }, SIMULATION_TIMEOUT);

  it("covers the true slope about 95% of the time", () => {
    let covered = 0;
    const reps = 200;
    const beta = 0.3;
    for (let s = 0; s < reps; s++) {
      const changes = simulateHourly({ sessions: 62, seed: 7000 + s, beta, sharedVolatility: true });
      const [{ test }] = lagCorrelationTests(changes, [0], "hourly", { draws: DRAWS });
      // The interval is shown as a correlation, slope × sx/sy; undo that to compare with the slope.
      const sd = (v: number[]) => Math.sqrt(v.reduce((a, b) => a + b * b, 0) - v.reduce((a, b) => a + b, 0) ** 2 / v.length);
      const scale = sd(changes.map((c) => c.probChangePp)) / sd(changes.map((c) => c.logReturn));
      if (test.ci![0] / scale <= beta / 100 && test.ci![1] / scale >= beta / 100) covered++;
    }
    expect(covered / reps).toBeGreaterThan(0.92);
    expect(covered / reps).toBeLessThan(0.985);
  }, SIMULATION_TIMEOUT);
});

describe("hourly steps", () => {
  it("are hours since the epoch, as in research rows", () => {
    const [first] = simulateHourly({ sessions: 1, seed: 1 });
    expect(first.step * HOUR_MS).toBe(first.t);
  });
});
