import { computeChanges, type ChangePoint } from "./changes";
import { correlationStats, type CorrelationStats } from "./correlation";
import { lagCorrelationTests } from "./correlation-test";
import { eventStudy, eventWindowRows, type EventStudy, type EventStudyOptions, type LogChange } from "./event-study";
import type { TestResult } from "./inference";
import { confidenceInterval95, neweyWestLags, ols } from "./regression";
import type { ResearchRow, Resolution } from "./research";
import { MIN_KALSHI_MOVES, MIN_PAIRS, sampleFlag, type SampleFlag } from "./sample";

/**
 * Market adjustment: the stock's return minus what a benchmark (e.g. SPY) explains. The
 * benchmark is read at exactly the stock's observation times, and every return is a log
 * return over the same interval as the stock's.
 */

/** A stock log return r is adjusted to r − alpha − beta·r_benchmark. */
export interface ReturnAdjustment {
  /** Intercept per interval, as a log return. */
  alpha: number;
  beta: number;
}

/** The simple excess return: the stock's return minus the benchmark's. */
export const SIMPLE_EXCESS: ReturnAdjustment = { alpha: 0, beta: 1 };

/** The market model r = alpha + beta·r_benchmark + ε, fitted by OLS. */
export interface MarketModel extends ReturnAdjustment {
  /** 95% confidence interval for beta, from Newey–West standard errors; null if they can't be computed. */
  betaCi: [number, number] | null;
  r2: number;
  /** Intervals the model was fitted on. */
  n: number;
  flag: SampleFlag;
}

/** Benchmark close at each row's exact time, or null where the benchmark has no bar then. */
export function benchmarkCloses(rows: ResearchRow[], closesByT: ReadonlyMap<number, number>): (number | null)[] {
  return rows.map((r) => closesByT.get(r.t) ?? null);
}

/**
 * Benchmark log return over the interval ending at each row, by row time, wherever both
 * ends have a benchmark close. Like the stock's, it's filled in even across gaps; the
 * analyses only use intervals one grid slot apart.
 */
export function benchmarkReturnsByT(rows: ResearchRow[], closesByT: ReadonlyMap<number, number>): Map<number, number> {
  const closes = benchmarkCloses(rows, closesByT);
  const returns = new Map<number, number>();
  rows.forEach((row, i) => {
    const [b0, b1] = [closes[i - 1], closes[i]];
    if (i > 0 && b0 != null && b1 !== null && b0 > 0 && b1 > 0) returns.set(row.t, Math.log(b1 / b0));
  });
  return returns;
}

/**
 * Fits the market model on every interval in `rows` one grid slot apart where both the
 * stock and the benchmark have prices. Kalshi isn't needed, so intervals left out of the
 * Kalshi analyses for a Kalshi reason still count. `excludeRow` leaves out the intervals
 * ending at chosen rows (e.g. around Kalshi jumps). Null with fewer than MIN_PAIRS
 * intervals or a benchmark that never moved.
 */
export function fitMarketModel(
  rows: ResearchRow[],
  closesByT: ReadonlyMap<number, number>,
  excludeRow: (index: number) => boolean = () => false,
): MarketModel | null {
  const bench = benchmarkReturnsByT(rows, closesByT);
  const X: number[][] = [];
  const y: number[] = [];
  const steps: number[] = [];
  computeChanges(rows).intervals.forEach((interval, i) => {
    const rm = bench.get(interval.t);
    if (interval.exclusion === "first_row" || interval.exclusion === "non_trading") return;
    if (interval.logReturn === null || rm === undefined || excludeRow(i)) return;
    // In percent, so the intercept is in % per interval and the numbers stay well scaled.
    X.push([1, rm * 100]);
    y.push(interval.logReturn * 100);
    steps.push(interval.step);
  });
  const n = y.length;
  if (n < MIN_PAIRS) return null;
  const fit = ols(X, y, { steps, lags: neweyWestLags(n) });
  if (!fit) return null;
  return {
    alpha: fit.coef[0] / 100,
    beta: fit.coef[1],
    betaCi: confidenceInterval95(fit, 1),
    r2: fit.r2,
    n,
    flag: sampleFlag(n),
  };
}

/** The changes with each stock return adjusted for the benchmark; changes without a benchmark return are dropped. */
export function adjustedChanges(
  changes: ChangePoint[],
  benchReturnByT: ReadonlyMap<number, number>,
  { alpha, beta }: ReturnAdjustment,
): ChangePoint[] {
  return changes.flatMap((c) => {
    const rm = benchReturnByT.get(c.t);
    return rm === undefined ? [] : [{ ...c, logReturn: c.logReturn - alpha - beta * rm }];
  });
}

/** Cumulative adjusted log return between two rows: ln(S₁/S₀) − beta·ln(B₁/B₀) − alpha·(bars between them). */
export function adjustedLogChange(
  rows: ResearchRow[],
  closesByT: ReadonlyMap<number, number>,
  { alpha, beta }: ReturnAdjustment,
): LogChange {
  const closes = benchmarkCloses(rows, closesByT);
  return (from, to) => {
    const [b0, b1] = [closes[from], closes[to]];
    if (b0 === null || b1 === null) return null;
    return Math.log(rows[to].stockClose / rows[from].stockClose) - beta * Math.log(b1 / b0) - alpha * (to - from);
  };
}

export interface KalshiRegression {
  /** Stock return (%) per 1 pp Kalshi change in the same interval, with the benchmark's return held fixed. */
  coef: number;
  se: number | null;
  ci: [number, number] | null;
  /** Two-sided p-value for coef = 0. */
  p: number | null;
  /** The benchmark's coefficient in the same regression. */
  marketCoef: number;
  n: number;
  /** Newey–West lags used. */
  lags: number;
  kalshiMoves: number;
  flag: SampleFlag;
  /** Fewer than MIN_KALSHI_MOVES non-zero Kalshi changes: too few to judge significance. */
  fewKalshiMoves: boolean;
  /** The Kalshi coefficient as a test result: a cross-check of the primary test, not corrected. */
  test: TestResult;
}

/**
 * OLS of the stock's return (%) on the benchmark's return (%) and the Kalshi change (pp),
 * over the usable intervals that have a benchmark return. Standard errors are Newey–West
 * (Bartlett, lags in grid slots) with an HC3-style leverage correction, since Kalshi is
 * zero in most intervals and the coefficient rests on the few where it moved. Null with
 * fewer than MIN_PAIRS intervals, or if Kalshi or the benchmark never moved.
 */
export function kalshiRegression(changes: ChangePoint[], benchReturnByT: ReadonlyMap<number, number>): KalshiRegression | null {
  const used = changes.filter((c) => benchReturnByT.has(c.t));
  const n = used.length;
  if (n < MIN_PAIRS) return null;
  const fit = ols(
    used.map((c) => [1, benchReturnByT.get(c.t)! * 100, c.probChangePp]),
    used.map((c) => c.logReturn * 100),
    { steps: used.map((c) => c.step), lags: neweyWestLags(n) },
  );
  if (!fit) return null;
  const kalshiMoves = used.filter((c) => c.probChangePp !== 0).length;
  const fewKalshiMoves = kalshiMoves < MIN_KALSHI_MOVES;
  const ci = confidenceInterval95(fit, 2);
  const p = fewKalshiMoves ? null : fit.p[2];
  return {
    coef: fit.coef[2],
    se: fit.se[2],
    ci,
    p: fit.p[2],
    marketCoef: fit.coef[1],
    n,
    lags: fit.lags,
    kalshiMoves,
    flag: sampleFlag(n),
    fewKalshiMoves,
    test: {
      estimate: fit.coef[2],
      ci,
      p,
      holm: null,
      bh: null,
      role: "exploratory",
      family: null,
      method: "newey_west",
      interval: "newey_west",
      resampling: null,
      n,
      nEffective: null,
      pUnavailable: fewKalshiMoves ? "few_kalshi_moves" : p === null ? "unstable" : null,
      ciUnavailable: ci === null ? "unstable" : null,
    },
  };
}

/**
 * Correlation of Kalshi changes with the benchmark's returns in the same interval: how much
 * of what Kalshi tracks the market shares. Tested like the lead-lag correlations; a
 * cross-check, not corrected.
 */
export function kalshiBenchmarkCorrelation(
  changes: ChangePoint[],
  benchReturnByT: ReadonlyMap<number, number>,
  resolution: Resolution,
): CorrelationStats & { test: TestResult } {
  const withBench = changes.flatMap((c) => {
    const rm = benchReturnByT.get(c.t);
    return rm === undefined ? [] : [{ ...c, logReturn: rm }];
  });
  const [{ test }] = lagCorrelationTests(withBench, [0], resolution);
  return { ...correlationStats(withBench.map((c) => ({ x: c.probChangePp, y: c.logReturn }))), test };
}

export interface MarketAdjustmentInput {
  /** Every loaded row at the selected resolution (the last 90 days): the models are fitted on these. */
  full: ResearchRow[];
  /** Rows in the selected window. */
  rows: ResearchRow[];
  /** Usable changes in the selected window (computeChanges(rows).changes). */
  changes: ChangePoint[];
  /** Benchmark closes by observation time. */
  closesByT: ReadonlyMap<number, number>;
  event: EventStudyOptions;
  resolution: Resolution;
}

export interface MarketAdjustment {
  /** Market model over all loaded rows; abnormal returns use it. */
  model: MarketModel | null;
  /** Market model over all loaded rows outside every jump window, for the event study. */
  eventModel: MarketModel | null;
  /** Window changes with beta-adjusted (abnormal) returns; null without a model. */
  abnormal: ChangePoint[] | null;
  /** Window changes with simple excess returns. */
  excess: ChangePoint[];
  /** Usable window intervals left out because the benchmark has no price at one end. */
  missingBenchmark: number;
  /**
   * The primary test: same-interval correlation of Kalshi changes with abnormal returns, in
   * the selected window. Null without a market model.
   */
  primary: TestResult | null;
  kalshi: KalshiRegression | null;
  kalshiVsBenchmark: CorrelationStats & { test: TestResult };
  /** Event studies on abnormal returns (beta from outside the jump windows) and on simple excess returns. */
  studies: { abnormal: EventStudy | null; excess: EventStudy };
}

/**
 * The primary test: same-interval (lag 0) correlation of Kalshi changes with market-adjusted
 * returns. It uses the same draws as lag 0 of the market-adjusted lead-lag chart, so the two
 * always agree.
 */
export function primaryTest(abnormal: ChangePoint[], resolution: Resolution): TestResult {
  return lagCorrelationTests(abnormal, [0], resolution, { primaryLags: [0] })[0].test;
}

/** Every market-adjusted result for one window, resolution, and jump size. */
export function marketAdjustment({ full, rows, changes, closesByT, event, resolution }: MarketAdjustmentInput): MarketAdjustment {
  const benchReturns = benchmarkReturnsByT(full, closesByT);
  const model = fitMarketModel(full, closesByT);
  // Fitted only outside the jump windows, so the jumps being studied don't shape beta.
  const windows = eventWindowRows(full, computeChanges(full).changes, event);
  const eventModel = fitMarketModel(full, closesByT, (i) => windows.has(i));
  const excess = adjustedChanges(changes, benchReturns, SIMPLE_EXCESS);
  const abnormal = model && adjustedChanges(changes, benchReturns, model);
  return {
    model,
    eventModel,
    abnormal,
    excess,
    missingBenchmark: changes.length - excess.length,
    primary: abnormal && primaryTest(abnormal, resolution),
    kalshi: kalshiRegression(changes, benchReturns),
    kalshiVsBenchmark: kalshiBenchmarkCorrelation(changes, benchReturns, resolution),
    studies: {
      abnormal: eventModel && eventStudy(rows, changes, event, adjustedLogChange(rows, closesByT, eventModel)),
      excess: eventStudy(rows, changes, event, adjustedLogChange(rows, closesByT, SIMPLE_EXCESS)),
    },
  };
}
