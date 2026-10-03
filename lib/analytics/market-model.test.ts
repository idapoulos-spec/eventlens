import { describe, expect, it } from "vitest";
import { computeChanges } from "./changes";
import {
  adjustedChanges,
  adjustedLogChange,
  benchmarkReturnsByT,
  fitMarketModel,
  kalshiBenchmarkCorrelation,
  kalshiRegression,
  marketAdjustment,
  SIMPLE_EXCESS,
} from "./market-model";
import type { ResearchRow } from "./research";

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
  it("matches numpy's coefficient, standard error, and p-value", () => {
    const fit = kalshiRegression(changes, benchReturns)!;
    expect(fit).toMatchObject({ n: 10, kalshiMoves: 4, lags: 2, flag: "small", fewKalshiMoves: true });
    expect(fit.coef).toBeCloseTo(-0.015126464315895653, 12);
    expect(fit.marketCoef).toBeCloseTo(1.516677209438722, 12);
    expect(fit.se!).toBeCloseTo(0.06054505933854022, 12);
    expect(fit.p!).toBeCloseTo(0.8098858731277612, 10);
    // As a test result, its p-value is withheld: Kalshi moved in only 4 intervals.
    expect(fit.test).toMatchObject({ estimate: fit.coef, p: null, pUnavailable: "few_kalshi_moves", method: "newey_west", family: null });
    expect(fit.test.ci).toEqual(fit.ci);
  });

  it("is null when Kalshi never moved", () => {
    expect(kalshiRegression(changes.map((c) => ({ ...c, probChangePp: 0 })), benchReturns)).toBeNull();
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

  it("runs the primary test on the abnormal returns, at lag 0", () => {
    expect(result.primary).toMatchObject({ role: "primary", family: null, n: 10, method: "wild_bootstrap" });
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
