import { describe, expect, it } from "vitest";
import { computeChanges } from "./changes";
import { lagCorrelationTests } from "./correlation-test";
import { crossCorrelation } from "./lead-lag";
import {
  adjustedChanges,
  adjustedLogChange,
  benchmarkReturnsByT,
  fitMarketModel,
  kalshiBenchmarkCorrelation,
  kalshiRegression,
  marketAdjustment,
  primaryTest,
  SIMPLE_EXCESS,
} from "./market-model";
import type { ResearchRow } from "./research";
import { lastSessions, simulateMarketRows, type MarketSimOptions } from "./test-helpers";

const HOUR = 3_600_000;

// Two runs of 8 hourly observations with a gap between them (e.g. a night). Kalshi has no
// price yet at the first two, and the benchmark has no bar at row 5. Expected values come
// from numpy (OLS; Newey–West with the HC3-style correction, lags by step, zero-padded).
const steps = [1, 2, 3, 4, 5, 6, 7, 8, 20, 21, 22, 23, 24, 25, 26, 27];
const S = [100, 101.07, 101.75, 101.47, 101.56, 101.04, 100.96, 101.1, 101.36, 99.8, 100.48, 100.33, 100.41, 99.93, 99.78, 100.36];
const B = [400.05, 402.24, 404.21, 403.39, 402.91, 402.06, 402.98, 402.89, 404.09, 401.12, 403.64, 403.48, 404.58, 404.36, 403.75, 404.5];
const P = [null, null, 0.4, 0.42, 0.42, 0.42, 0.45, 0.45, 0.45, 0.5, 0.5, 0.47, 0.47, 0.47, 0.52, 0.52];

function makeRows(closes: number[] = S): ResearchRow[] {
  return steps.map((step, i) => ({
    t: step * HOUR,
    step,
    stockClose: closes[i],
    probability: P[i],
    kalshiSource: P[i] === null ? null : "midpoint",
    kalshiAsOf: P[i] === null ? null : step * HOUR,
    exclusion: P[i] === null ? "before_kalshi" : null,
  }));
}

const rows = makeRows();
const closesByT = new Map(steps.flatMap((step, i) => (i === 5 ? [] : [[step * HOUR, B[i]] as [number, number]])));
const changes = computeChanges(rows).changes;
const benchReturns = benchmarkReturnsByT(rows, closesByT);

describe("benchmarkReturnsByT", () => {
  it("has a log return wherever both ends have a benchmark close", () => {
    expect(benchReturns.get(2 * HOUR)).toBeCloseTo(Math.log(B[1] / B[0]), 15);
    expect(benchReturns.has(1 * HOUR)).toBe(false); // first row
    expect(benchReturns.has(6 * HOUR)).toBe(false); // row 5 has no bar
    expect(benchReturns.has(7 * HOUR)).toBe(false);
    // Filled in across the gap like the stock's return; the analyses skip it.
    expect(benchReturns.get(20 * HOUR)).toBeCloseTo(Math.log(B[8] / B[7]), 15);
  });
});

describe("fitMarketModel", () => {
  it("fits one-slot intervals with both prices, Kalshi or not", () => {
    const model = fitMarketModel(rows, closesByT)!;
    expect(model.n).toBe(12);
    expect(model.beta).toBeCloseTo(1.6484257643345017, 12);
    expect(model.alpha).toBeCloseTo(-0.000507987883691595, 14);
    expect(model.r2).toBeCloseTo(0.8544727913996474, 12);
    expect(model.betaCi![0]).toBeCloseTo(1.1113480761837944, 8);
    expect(model.betaCi![1]).toBeCloseTo(2.185503452485209, 8);
    expect(model.flag).toBe("small");
    // The intervals it was fitted on, for the tests that refit it.
    expect(model.sample.t).toHaveLength(12);
    expect(model.sample.r[0]).toBeCloseTo(Math.log(S[1] / S[0]), 15);
    expect(model.sample.m[0]).toBeCloseTo(Math.log(B[1] / B[0]), 15);
  });

  it("recovers an exact relationship", () => {
    const closes = B.map((b) => 50 * Math.exp(1.5 * Math.log(b / B[0])));
    for (let i = 1; i < closes.length; i++) closes[i] = closes[i - 1] * Math.exp(0.0002 + 1.5 * Math.log(B[i] / B[i - 1]));
    const model = fitMarketModel(makeRows(closes), closesByT)!;
    expect(model.beta).toBeCloseTo(1.5, 10);
    expect(model.alpha).toBeCloseTo(0.0002, 12);
    expect(model.r2).toBeCloseTo(1, 10);
  });

  it("gives beta 1 when the stock is its own benchmark", () => {
    const model = fitMarketModel(rows, new Map(rows.map((r) => [r.t, r.stockClose])))!;
    expect(model.beta).toBeCloseTo(1, 10);
    expect(model.r2).toBeCloseTo(1, 10);
  });

  it("leaves out the rows it's told to, and needs at least 10 intervals", () => {
    expect(fitMarketModel(rows, closesByT, (i) => i === 15)!.n).toBe(11);
    expect(fitMarketModel(rows, closesByT, (i) => i >= 14)!.n).toBe(10);
    expect(fitMarketModel(rows, closesByT, (i) => i >= 13)).toBeNull();
  });
});

describe("adjustedChanges", () => {
  it("subtracts alpha and beta times the benchmark's return, dropping changes without one", () => {
    const adjusted = adjustedChanges(changes, benchReturns, { alpha: 0.001, beta: 2 });
    expect(changes).toHaveLength(12);
    expect(adjusted).toHaveLength(10);
    const at = (c: { t: number }[], step: number) => c.find((x) => x.t === step * HOUR)!;
    const raw = at(changes, 4) as (typeof changes)[number];
    expect(at(adjusted, 4)).toEqual({ ...raw, logReturn: expect.closeTo(raw.logReturn - 0.001 - 2 * Math.log(B[3] / B[2]), 15) });
    expect(adjustedChanges(changes, benchReturns, SIMPLE_EXCESS).map((c) => c.logReturn)).toEqual(
      adjusted.map((c) => expect.closeTo(changes.find((x) => x.t === c.t)!.logReturn - benchReturns.get(c.t)!, 15)),
    );
  });
});

describe("adjustedLogChange", () => {
  it("is the stock's log change net of beta times the benchmark's and alpha per bar", () => {
    const change = adjustedLogChange(rows, closesByT, { alpha: 0.001, beta: 2 });
    expect(change(2, 4)).toBeCloseTo(Math.log(S[4] / S[2]) - 2 * Math.log(B[4] / B[2]) - 0.002, 15);
    expect(change(4, 2)).toBeCloseTo(-change(2, 4)!, 15);
    expect(change(3, 3)).toBe(0);
    expect(change(4, 5)).toBeNull();
  });
});

describe("kalshiRegression", () => {
  it("matches numpy's coefficient, and its Newey–West cross-check", () => {
    const fit = kalshiRegression(changes, benchReturns, "hourly")!;
    expect(fit).toMatchObject({ n: 10, kalshiMoves: 4, lags: 2, flag: "small", fewKalshiMoves: true });
    expect(fit.coef).toBeCloseTo(-0.015126464315895653, 12);
    expect(fit.marketCoef).toBeCloseTo(1.516677209438722, 12);
    expect(fit.neweyWest.se!).toBeCloseTo(0.06054505933854022, 12);
    expect(fit.neweyWest.p!).toBeCloseTo(0.8098858731277612, 10);
    // The bootstrap needs at least 8 sessions; these rows have 2.
    expect(fit.test).toMatchObject({ estimate: fit.coef, p: null, ci: null, pUnavailable: "too_few_blocks", method: "wild_bootstrap", family: null });
    expect(fit.test.resampling).toMatchObject({ unit: "session", units: 2, draws: 0, refit: "regression" });
  });

  it("tests the coefficient with the wild bootstrap, refitting every coefficient, given enough sessions", () => {
    const { rows, closesByT } = simulateMarketRows({ sessions: 21, resolution: "hourly", seed: 4, effect: 0.6 });
    const fit = kalshiRegression(computeChanges(rows).changes, benchmarkReturnsByT(rows, closesByT), "hourly", { draws: 199 })!;
    expect(fit.n).toBe(126);
    expect(fit.coef).toBeGreaterThan(0.3);
    expect(fit.test).toMatchObject({ method: "wild_bootstrap", pUnavailable: null, ciUnavailable: null });
    expect(fit.test.resampling).toMatchObject({ units: 21, draws: 199, refit: "regression" });
    expect(fit.test.p).toBeLessThan(0.05);
    expect(fit.test.ci![0]).toBeGreaterThan(0);
    expect(fit.test.ci![0]).toBeLessThan(fit.coef);
    expect(fit.test.ci![1]).toBeGreaterThan(fit.coef);
  });

  it("is null when Kalshi never moved", () => {
    expect(kalshiRegression(changes.map((c) => ({ ...c, probChangePp: 0 })), benchReturns, "hourly")).toBeNull();
  });
});

describe("kalshiBenchmarkCorrelation", () => {
  it("pairs each Kalshi change with the benchmark's return over the same interval", () => {
    const result = kalshiBenchmarkCorrelation(changes, benchReturns, "hourly");
    expect(result).toMatchObject({ n: 10, kalshiMoves: 4 });
    // Two sessions are too few for the wild bootstrap, so the test reports no p-value.
    expect(result.test).toMatchObject({ n: 10, p: null, pUnavailable: "too_few_blocks" });
    expect(result.test.estimate).toBeCloseTo(result.r!, 12);
  });
});

describe("marketAdjustment", () => {
  const result = marketAdjustment({ full: rows, rows, changes, closesByT, event: { thresholdPp: 3, before: 1, after: 1 }, resolution: "hourly" });

  it("fits the model on all rows and adjusts the window's changes", () => {
    expect(result.model!.n).toBe(12);
    expect(result.abnormal).toHaveLength(10);
    expect(result.excess).toHaveLength(10);
    expect(result.missingBenchmark).toBe(2);
    expect(result.kalshi!.n).toBe(10);
  });

  it("runs the primary test on the abnormal returns, at lag 0, refitting the market model", () => {
    expect(result.primary).toMatchObject({ role: "primary", family: null, n: 10, method: "wild_bootstrap" });
    expect(result.primary!.resampling).toMatchObject({ refit: "market_model" });
  });

  it("fits the event-study model outside every jump window, and skips it with too few intervals left", () => {
    // Jumps of ≥ 3 pp end at rows 6, 9, 11, and 14, so only intervals ending at rows 1–4 remain.
    expect(result.eventModel).toBeNull();
    expect(result.studies.abnormal).toBeNull();
    const narrow = marketAdjustment({ full: rows, rows, changes, closesByT, event: { thresholdPp: 5, before: 0, after: 0 }, resolution: "hourly" });
    // Jumps of ≥ 5 pp end at rows 9 and 14, and the windows are just those bars.
    expect(narrow.eventModel!.n).toBe(12 - 2);
    expect(narrow.eventModel!.beta).not.toBeCloseTo(narrow.model!.beta, 3);
    expect(narrow.studies.abnormal!.rises.n).toBe(2);
  });

  it("runs the event study on simple excess returns", () => {
    const study = result.studies.excess;
    // The jump at row 6 needs row 5, which has no benchmark bar.
    expect(study.skippedMissing).toBe(1);
    const rise = study.rises.events.find((e) => e.t === 21 * HOUR)!;
    expect(rise.probChangePp).toBeCloseTo(5, 10);
    // Kept: rises at rows 9 and 14, and the fall at row 11; each is more than a bar after the last kept jump.
    expect(study.rises.events.map((e) => e.t)).toEqual([21 * HOUR, 26 * HOUR]);
    const path = (i: number) => [-1, 0, 1].map((k) => (Math.log(S[i + k] / S[i - 1]) - Math.log(B[i + k] / B[i - 1])) * 100);
    study.rises.mean!.forEach((v, k) => expect(v).toBeCloseTo((path(9)[k] + path(14)[k]) / 2, 12));
  });
});

describe("the primary test with alpha and beta refitted", () => {
  const { rows: full, closesByT } = simulateMarketRows({ sessions: 62, resolution: "hourly", seed: 21, kalshiInMarket: 0.1, sharedVolatility: true });
  const rows = lastSessions(full, 21, "hourly");
  const model = fitMarketModel(full, closesByT)!;
  const abnormal = adjustedChanges(computeChanges(rows).changes, benchmarkReturnsByT(full, closesByT), model);

  it("agrees with lag 0 of the market-adjusted lead-lag chart, and counts the window's sessions", () => {
    const primary = primaryTest(abnormal, model, "hourly", { draws: 199 });
    const lags = crossCorrelation(abnormal, 3, "hourly", { primaryLag: 0, refit: model.sample, draws: 199 });
    expect(lags.find((l) => l.lag === 0)!.test).toEqual(primary);
    expect(primary.resampling).toMatchObject({ unit: "session", units: 21, draws: 199, refit: "market_model" });
    expect(model.n).toBe(62 * 6);
    expect(primary.n).toBe(126);
  });

  it("differs from treating beta as known, and only through the p-value and interval", () => {
    const primary = primaryTest(abnormal, model, "hourly", { draws: 199 });
    const fixed = lagCorrelationTests(abnormal, [0], "hourly", { draws: 199 })[0].test;
    expect(primary.estimate).toBe(fixed.estimate);
    expect(primary.nEffective).toBe(fixed.nEffective);
    expect(primary.p).not.toBe(fixed.p);
  });

  it("marks a lag unavailable if a pair's stock return isn't in the model's sample", () => {
    const shifted = { ...model.sample, t: model.sample.t.map((t) => t + 1) };
    const [{ test }] = lagCorrelationTests(abnormal, [0], "hourly", { refit: shifted, draws: 19 });
    expect(test).toMatchObject({ p: null, pUnavailable: "unstable" });
  });
});

// Simulations run hundreds of analyses; allow for slow CI machines.
const SIMULATION_TIMEOUT = 300_000;
const DRAWS = 199;

interface Setting extends Omit<MarketSimOptions, "seed"> {
  /** Sessions (hourly) or daily intervals in the selected window. */
  window: number;
}

/** Every result of one simulated data set, computed as the page does. */
function analyze({ window, ...options }: Setting, seed: number) {
  const { rows: full, closesByT } = simulateMarketRows({ ...options, seed });
  const rows = lastSessions(full, window, options.resolution);
  const model = fitMarketModel(full, closesByT)!;
  const bench = benchmarkReturnsByT(full, closesByT);
  const changes = computeChanges(rows).changes;
  const abnormal = adjustedChanges(changes, bench, model);
  return {
    primary: primaryTest(abnormal, model, options.resolution, { draws: DRAWS }),
    fixedBeta: lagCorrelationTests(abnormal, [0], options.resolution, { draws: DRAWS })[0].test,
    regression: kalshiRegression(changes, bench, options.resolution, { draws: DRAWS }),
  };
}

/**
 * Rejection rates at 5% over the data sets seeded `first`…`first + count − 1` for each range:
 * the primary test, beta treated as known, and the regression's bootstrap and Newey–West t.
 */
function rates(setting: Setting, ranges: [first: number, count: number][]) {
  const count = { primary: 0, fixedBeta: 0, bootstrap: 0, neweyWest: 0 };
  const tested = { primary: 0, fixedBeta: 0, bootstrap: 0, neweyWest: 0 };
  const add = (key: keyof typeof count, p: number | null | undefined) => {
    if (p === null || p === undefined) return;
    tested[key]++;
    if (p < 0.05) count[key]++;
  };
  const seeds = ranges.flatMap(([first, n]) => Array.from({ length: n }, (_, i) => first + i));
  for (const seed of seeds) {
    const { primary, fixedBeta, regression } = analyze(setting, seed);
    add("primary", primary.p);
    add("fixedBeta", fixedBeta.p);
    add("bootstrap", regression?.test.p);
    add("neweyWest", regression && !regression.fewKalshiMoves ? regression.neweyWest.p : null);
  }
  const rate = (key: keyof typeof count) => count[key] / tested[key];
  return { primary: rate("primary"), fixedBeta: rate("fixedBeta"), bootstrap: rate("bootstrap"), neweyWest: rate("neweyWest"), tested };
}

describe("simulations: false positives for the primary test and the regression", () => {
  // The stock moves 1.1× with its benchmark; Kalshi has no link to the stock beyond that.
  // 62 sessions (or trading days) are loaded, as in the page's 90 days, and the market
  // model is fitted on all of them. Seeds are fixed, so these results are the same on every run.
  const hourly21 = { sessions: 62, resolution: "hourly", window: 21, sharedVolatility: true } as const;

  it("stays near 5% with 21 sessions in the window, Kalshi unrelated to the benchmark", () => {
    const r = rates(hourly21, [[30_000, 400]]);
    expect(r.tested.primary).toBe(400);
    expect(r.tested.bootstrap).toBe(400);
    for (const rate of [r.primary, r.bootstrap]) {
      expect(rate).toBeGreaterThan(0.02);
      expect(rate).toBeLessThan(0.075);
    }
    // The regression's Newey–West t rejects too often here.
    expect(r.neweyWest).toBeGreaterThan(r.bootstrap);
  }, SIMULATION_TIMEOUT);

  it("stays near 5% when Kalshi tracks the benchmark, so beta's uncertainty reaches the test", () => {
    // Every data set ever run in this setting, pooled: the first 400 put the regression's
    // bootstrap at 8.0%, above the bar, and later runs of 1,000 (development) and 1,400 were
    // added to measure it more precisely. Reporting only the later runs would be selective.
    const r = rates({ ...hourly21, kalshiInMarket: 0.1 }, [
      [31_000, 400],
      [41_000, 1000],
      [70_000, 1400],
    ]);
    for (const rate of [r.primary, r.bootstrap]) {
      expect(rate).toBeGreaterThan(0.02);
      expect(rate).toBeLessThan(0.075);
    }
    // Treating beta as known is conservative here: the 90 days' beta absorbs part of the noise.
    expect(r.fixedBeta).toBeLessThan(r.primary);
  }, SIMULATION_TIMEOUT);

  it("stays near 5% over the whole 90 days, hourly, Kalshi tracking the benchmark", () => {
    const r = rates({ ...hourly21, window: 62, kalshiInMarket: 0.1 }, [[32_000, 300]]);
    for (const rate of [r.primary, r.bootstrap]) {
      expect(rate).toBeGreaterThan(0.02);
      expect(rate).toBeLessThan(0.075);
    }
    expect(r.fixedBeta).toBeLessThan(r.primary);
  }, SIMULATION_TIMEOUT);

  it("stays below 7.5% daily, over 62 and 20 trading days", () => {
    const daily = { sessions: 62, resolution: "daily", sharedVolatility: true, kalshiInMarket: 0.3 } as const;
    // 62 days: every data set run, pooled, as above (the first 300 put the regression's bootstrap at 7.7%).
    const long = rates({ ...daily, window: 62 }, [
      [33_000, 300],
      [72_000, 1000],
    ]);
    const short = rates({ ...daily, window: 20 }, [[34_000, 300]]);
    for (const rate of [long.primary, long.bootstrap, short.primary, short.bootstrap]) expect(rate).toBeLessThan(0.075);
  }, SIMULATION_TIMEOUT);
});

describe("simulations: intervals and detection", () => {
  it("covers the true effect about 95% of the time, for the primary test and the regression", () => {
    let primary = 0;
    let regression = 0;
    const reps = 200;
    const effect = 0.3;
    for (let s = 0; s < reps; s++) {
      const { rows: full, closesByT } = simulateMarketRows({ sessions: 62, resolution: "hourly", seed: 35_000 + s, effect, sharedVolatility: true });
      const model = fitMarketModel(full, closesByT)!;
      const bench = benchmarkReturnsByT(full, closesByT);
      const changes = computeChanges(full).changes;
      const abnormal = adjustedChanges(changes, bench, model);
      const test = primaryTest(abnormal, model, "hourly", { draws: DRAWS });
      // The primary interval is shown as a correlation, slope × sx/sy; undo that to compare with the slope.
      const sd = (v: number[]) => Math.sqrt(v.reduce((a, b) => a + b * b, 0) - v.reduce((a, b) => a + b, 0) ** 2 / v.length);
      const scale = sd(abnormal.map((c) => c.probChangePp)) / sd(abnormal.map((c) => c.logReturn));
      if (test.ci![0] / scale <= effect / 100 && test.ci![1] / scale >= effect / 100) primary++;
      const fit = kalshiRegression(changes, bench, "hourly", { draws: DRAWS })!;
      if (fit.test.ci![0] <= effect && fit.test.ci![1] >= effect) regression++;
    }
    for (const covered of [primary, regression]) {
      expect(covered / reps).toBeGreaterThan(0.92);
      expect(covered / reps).toBeLessThan(0.985);
    }
  }, SIMULATION_TIMEOUT);

  it("detects a strong same-hour effect in most 30-day samples", () => {
    let found = 0;
    const reps = 100;
    for (let s = 0; s < reps; s++) {
      const { primary } = analyze({ sessions: 62, resolution: "hourly", window: 21, effect: 0.6, kalshiInMarket: 0.1 }, 36_000 + s);
      if (primary.p !== null && primary.p < 0.05) found++;
    }
    expect(found / reps).toBeGreaterThan(0.8);
  }, SIMULATION_TIMEOUT);
});
