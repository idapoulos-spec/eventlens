import { DISPLAY_TIME_ZONE } from "@/lib/format";
// Imported directly: the lib/market-data index also loads the server-only Twelve Data client.
import { timeZoneOffsetMs } from "@/lib/market-data/session";
import type { ChangePoint } from "./changes";
import { pearson } from "./correlation";
import type { Resampling, TestResult, TestRole } from "./inference";
import { detectableEffect, DETECTABLE_POWER, MAX_DETECTABLE, POWER_SAMPLES, SCALE_RESAMPLES, scoreVarianceRatios, simulatePower } from "./power";
import { HOUR_MS } from "./probability";
import { seededRng } from "./random";
import { neweyWestLags } from "./regression";
import type { Resolution } from "./research";
import { MIN_PAIRS, MIN_BOOTSTRAP_BLOCKS } from "./sample";
import { drawWeights, frame, wildTest, type Frame, type StageOne } from "./wild-bootstrap";

/**
 * Significance for correlations of Kalshi changes (x) with stock returns (y), allowing for
 * what the data looks like: Kalshi is zero in most intervals and reprices over several
 * hours, and stock volatility changes with news, often in the same hours Kalshi moves.
 *
 * The test is a wild cluster bootstrap (Cameron, Gelbach & Miller 2008) with the null
 * imposed: Kalshi's changes stay exactly as observed, and the stock's returns are rebuilt
 * as their fit plus each residual times one random weight per session (hourly) or run of
 * trading days (daily), from Webb's six-point distribution. That keeps Kalshi's zeros and
 * autocorrelation, the stock's volatility in each hour (including the hours Kalshi moved),
 * and any dependence within a session, and removes only a link in direction. The statistic
 * is the slope's t with the Newey–West + HC3 errors that `ols` uses.
 *
 * On market-adjusted returns, alpha and beta are refitted in every draw over the market
 * model's whole sample (the loaded 90 days, every one of its sessions weighted), so the
 * test allows for beta being estimated (wild-bootstrap.ts).
 *
 * The 95% interval is every slope the same test wouldn't reject (MacKinnon 2023), shown on
 * the correlation scale, so the interval excludes zero exactly when p < 0.05.
 *
 * A block shuffle of Kalshi's changes was tried first and dropped: it rejected too often when
 * both series were volatile on the same news days (development runs, not in the test suite).
 * correlation-test.test.ts and market-model.test.ts check the false-positive rate, coverage,
 * and power.
 */

export const WILD_DRAWS = 999;

const DAY_MS = 24 * HOUR_MS;

export interface BlockLayout {
  unit: "session" | "day_run";
  /** Block of each change, numbered 0…blocks − 1 in time order. */
  block: Int32Array;
  blocks: number;
  /** Trading days per run, for day runs. */
  runDays: number | null;
}

/** Trading days per run for daily blocks: the Newey–West lag rule, at least 2. */
export function runDays(n: number): number {
  return Math.max(2, neweyWestLags(n));
}

/**
 * Hourly: one block per New York trading date. Daily: runs of `runDays(n)` consecutive
 * trading days. `changes` must be sorted by step; blocks without a change are left out.
 */
export function blockLayout(changes: ChangePoint[], resolution: Resolution): BlockLayout {
  const n = changes.length;
  const days = resolution === "daily" ? runDays(n) : null;
  const first = n > 0 ? changes[0].step : 0;
  const { block, blocks } = numberBlocks(changes, (c) => blockKey(c.t, c.step, first, days));
  return { unit: days === null ? "session" : "day_run", block, blocks, runDays: days };
}

/** The New York trading date (hourly), or the run of `days` trading days counted from `first` (daily). */
function blockKey(t: number, step: number, first: number, days: number | null): number {
  return days === null ? Math.floor((t + timeZoneOffsetMs(t, DISPLAY_TIME_ZONE)) / DAY_MS) : Math.floor((step - first) / days);
}

/** Blocks numbered 0, 1, … in the order they first appear. */
function numberBlocks<T>(items: ArrayLike<T>, key: (item: T, i: number) => number): { block: Int32Array; blocks: number } {
  const ids = new Map<number, number>();
  const block = Int32Array.from(items, (item, i) => {
    const k = key(item, i);
    if (!ids.has(k)) ids.set(k, ids.size);
    return ids.get(k)!;
  });
  return { block, blocks: ids.size };
}

/** Distinct values of |t| the wild bootstrap can produce: 6^G / 2, or null once it's past any draw count. */
export function weightPatterns(blocks: number): number | null {
  const count = 6 ** blocks / 2;
  return count > 1e9 ? null : count;
}

/** The plain wild bootstrap of one lag: stage 1 is just a mean over the lag's own pairs. */
function rawFrame(x: ArrayLike<number>, y: ArrayLike<number>, block: Int32Array, steps: number[]): Frame | null {
  return frame({ r: y, m: null, block }, { index: Int32Array.from(steps, (_, p) => p), x, steps, market: false });
}

/**
 * The slope's t statistic for y on x with Newey–West + HC3 errors, lags pairing slots by
 * `steps`: what `ols` computes, without the matrix algebra. Null when it's undefined.
 */
export function robustSlopeT(x: number[], y: number[], steps: number[]): number | null {
  const f = rawFrame(x, y, new Int32Array(x.length), steps);
  return f && (f.slope * f.sxx) / Math.sqrt(f.s);
}

/**
 * Bartlett's effective sample size for a correlation between two autocorrelated series:
 * n / (1 + 2 Σ ρₓ(j)·ρᵧ(j)), over j = 1…Newey–West lags, autocorrelations pairing slots
 * exactly j apart. Never more than n.
 */
export function effectiveN(n: number, x: Float64Array, y: Float64Array, steps: number[]): number {
  const index = new Map(steps.map((s, i) => [s, i]));
  const acf = (v: Float64Array, j: number) => {
    const mean = v.reduce((a, b) => a + b, 0) / v.length;
    let num = 0;
    let den = 0;
    for (let i = 0; i < v.length; i++) {
      den += (v[i] - mean) ** 2;
      const prev = index.get(steps[i] - j);
      if (prev !== undefined) num += (v[i] - mean) * (v[prev] - mean);
    }
    return den > 0 ? num / den : 0;
  };
  let sum = 0;
  for (let j = 1; j <= neweyWestLags(steps.length); j++) sum += acf(x, j) * acf(y, j);
  const factor = 1 + 2 * sum;
  return factor > 1 ? n / factor : n;
}


/**
 * The market model's sample, for tests that refit it in every draw: every interval it was
 * fitted on, in time order, with the stock's and the benchmark's log returns.
 */
export interface RefitSample {
  t: number[];
  step: number[];
  r: number[];
  m: number[];
}

export interface CorrelationTestOptions {
  /** Lags that are the primary test; the rest are exploratory. */
  primaryLags?: number[];
  draws?: number;
  /**
   * When `changes` hold market-adjusted returns: the market model's sample, so alpha and
   * beta are refitted in every draw.
   */
  refit?: RefitSample;
}

export interface LagTest {
  lag: number;
  r: number | null;
  n: number;
  kalshiMoves: number;
  test: TestResult;
}

/** The changes, their blocks, and with a refit, stage 1 over the market model's sample. */
interface Setup {
  sorted: ChangePoint[];
  x: Float64Array;
  y: Float64Array;
  steps: number[];
  byStep: Map<number, number>;
  /** Blocks of the changes: what the reported sessions and the minimum count. */
  layout: BlockLayout;
  refit: { one: StageOne; indexByT: Map<number, number>; blocks: number } | null;
}

function setup(changes: ChangePoint[], resolution: Resolution, refit?: RefitSample): Setup {
  const sorted = [...changes].sort((a, b) => a.step - b.step);
  const steps = sorted.map((c) => c.step);
  const layout = blockLayout(sorted, resolution);
  let stageOne: Setup["refit"] = null;
  if (refit) {
    // Every session (or run of days) of the sample gets a weight; the window's runs of days
    // are the same as without a refit, extended back from the window's first change.
    const first = sorted.length > 0 ? sorted[0].step : 0;
    const { block, blocks } = numberBlocks(refit.t, (t, i) => blockKey(t, refit.step[i], first, layout.runDays));
    stageOne = { one: { r: refit.r, m: refit.m, block }, indexByT: new Map(refit.t.map((t, i) => [t, i])), blocks };
  }
  return {
    sorted,
    x: Float64Array.from(sorted, (c) => c.probChangePp),
    y: Float64Array.from(sorted, (c) => c.logReturn),
    steps,
    byStep: new Map(steps.map((s, i) => [s, i])),
    layout,
    refit: stageOne,
  };
}

/**
 * One lag's pairs, r, and frame: the Kalshi change in slot s against the stock return in
 * slot s + lag. With a refit, stage 1 is the market model over its whole sample; without,
 * just a mean over the lag's own pairs. A pair whose stock return isn't in the sample
 * can't happen (the changes come from the same rows), but would make the test unavailable.
 */
function lagFrame({ sorted, x, y, steps, byStep, layout, refit }: Setup, lag: number) {
  const pairs = sorted.flatMap((_, i) => {
    const j = byStep.get(steps[i] + lag);
    return j === undefined ? [] : [[i, j]];
  });
  const px = pairs.map(([i]) => x[i]);
  const py = pairs.map(([, j]) => y[j]);
  const r = pairs.length >= MIN_PAIRS ? pearson(px, py) : null;
  let f: Frame | null = null;
  if (r !== null) {
    const pairSteps = pairs.map(([i]) => steps[i]);
    if (refit) {
      const index = Int32Array.from(pairs, ([, j]) => refit.indexByT.get(sorted[j].t) ?? -1);
      f = index.includes(-1) ? null : frame(refit.one, { index, x: px, steps: pairSteps, market: false });
    } else {
      const block = Int32Array.from(pairs, ([, j]) => layout.block[j]);
      f = frame({ r: py, m: null, block }, { index: Int32Array.from(pairs, (_, p) => p), x: px, steps: pairSteps, market: false });
    }
  }
  return { n: pairs.length, px, r, f };
}

/**
 * Correlation tests at each lag: the Kalshi change in slot s against the stock return in
 * slot s + lag, pairing only slots that both exist, so no lag reaches across a gap. Every
 * lag uses the same weights, so a lag's result doesn't depend on which others are tested.
 */
export function lagCorrelationTests(
  changes: ChangePoint[],
  lags: number[],
  resolution: Resolution,
  { primaryLags = [], draws = WILD_DRAWS, refit }: CorrelationTestOptions = {},
): LagTest[] {
  const s = setup(changes, resolution, refit);
  const { layout } = s;
  const enough = layout.blocks >= MIN_BOOTSTRAP_BLOCKS;
  // Counted over the window's blocks: with a refit, the sample's other blocks add a little
  // variety through beta, so this understates the patterns slightly (and never matters
  // above MIN_BOOTSTRAP_BLOCKS, where there are far more patterns than draws).
  const patterns = weightPatterns(layout.blocks);
  const weights = enough ? drawWeights(s.refit ? s.refit.blocks : layout.blocks, draws, seededRng("wild-bootstrap")) : [];

  return lags.map((lag) => {
    const { n, px, r, f } = lagFrame(s, lag);

    let unavailable: TestResult["pUnavailable"] = null;
    if (n < MIN_PAIRS) unavailable = "too_few_pairs";
    else if (r === null) unavailable = "no_variation";
    else if (!enough) unavailable = "too_few_blocks";
    else if (f === null) unavailable = "unstable";

    let p: number | null = null;
    let ci: [number, number] | null = null;
    if (unavailable === null) {
      const result = wildTest(f!, weights);
      p = result.p;
      // On the correlation scale: r = slope · sx / sy.
      const scale = Math.sqrt(f!.sxx / f!.syy);
      if (result.ci) ci = [Math.max(-1, result.ci[0] * scale), Math.min(1, result.ci[1] * scale)];
    }
    const resampling: Resampling = {
      unit: layout.unit,
      units: layout.blocks,
      runDays: layout.runDays,
      draws: unavailable === null ? draws : 0,
      arrangements: patterns,
      minP: Math.max(unavailable === null ? 1 / (draws + 1) : 0, patterns === null ? 0 : 1 / patterns),
      refit: s.refit ? "market_model" : null,
    };
    const role: TestRole = primaryLags.includes(lag) ? "primary" : "exploratory";
    const test: TestResult = {
      estimate: r,
      ci,
      p,
      holm: null,
      bh: null,
      role,
      family: null,
      method: "wild_bootstrap",
      interval: "wild_bootstrap",
      resampling,
      n,
      nEffective: r === null ? null : effectiveN(n, s.x, s.y, s.steps),
      pUnavailable: unavailable,
      ciUnavailable: unavailable ?? (ci === null ? "unstable" : null),
    };
    return { lag, r, n, kalshiMoves: px.filter((v) => v !== 0).length, test };
  });
}

/** The smallest correlation the same-interval test detects with DETECTABLE_POWER, for one sample. */
export interface DetectableCorrelation {
  /** Smallest |r| detected at 5% with probability `power`, in both directions; null if it's above `max`. */
  r: number | null;
  /** Largest r reported as a number. */
  max: number;
  /** The effect that gives it: stock log return per 1 pp Kalshi change, built into the simulated samples. */
  slope: number | null;
  power: number;
  /** Simulated samples. */
  samples: number;
  /** The window's sessions or runs of days, as the test counts them. */
  unit: BlockLayout["unit"];
  units: number;
}

/**
 * How large a same-interval correlation this sample could detect: simulated samples with
 * Kalshi's changes, the blocks, and the stock's residual volatility as observed, and an
 * effect built in, with the power averaged over how uncertain that volatility is (power.ts).
 * With a refit, alpha and beta are refitted in each, as in the test. Null when the test
 * itself can't run.
 */
export function detectableCorrelation(
  changes: ChangePoint[],
  resolution: Resolution,
  { refit, samples = POWER_SAMPLES, target = DETECTABLE_POWER }: { refit?: RefitSample; samples?: number; target?: number } = {},
): DetectableCorrelation | null {
  const s = setup(changes, resolution, refit);
  if (s.layout.blocks < MIN_BOOTSTRAP_BLOCKS) return null;
  const { f } = lagFrame(s, 0);
  if (!f) return null;
  const sim = simulatePower(f, s.refit ? s.refit.blocks : s.layout.blocks, samples, seededRng("detectable"));
  const found = detectableEffect(sim, scoreVarianceRatios(f, SCALE_RESAMPLES, seededRng("detectable-scale")), target);
  return {
    r: found && found.rho,
    max: MAX_DETECTABLE,
    slope: found && found.gamma,
    power: target,
    samples,
    unit: s.layout.unit,
    units: s.layout.blocks,
  };
}
