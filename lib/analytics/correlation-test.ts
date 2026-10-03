import { DISPLAY_TIME_ZONE } from "@/lib/format";
// Imported directly: the lib/market-data index also loads the server-only Twelve Data client.
import { timeZoneOffsetMs } from "@/lib/market-data/session";
import type { ChangePoint } from "./changes";
import { pearson } from "./correlation";
import { ALPHA, type Resampling, type TestResult, type TestRole } from "./inference";
import { HOUR_MS } from "./probability";
import { seededRng, type Rng } from "./random";
import { neweyWestLags } from "./regression";
import type { Resolution } from "./research";
import { MIN_PAIRS, MIN_BOOTSTRAP_BLOCKS } from "./sample";

/**
 * Significance for correlations of Kalshi changes (x) with stock returns (y), allowing for
 * what the data looks like: Kalshi is zero in most intervals and reprices over several
 * hours, and stock volatility changes with news, often in the same hours Kalshi moves.
 *
 * The test is a wild cluster bootstrap (Cameron, Gelbach & Miller 2008) with the null
 * imposed: Kalshi's changes stay exactly as observed, and the stock's returns are rebuilt
 * as their mean plus each residual times one random weight per session (hourly) or run of
 * trading days (daily), from Webb's six-point distribution. That keeps Kalshi's zeros and
 * autocorrelation, the stock's volatility in each hour (including the hours Kalshi moved),
 * and any dependence within a session, and removes only a link in direction. The statistic
 * is the slope's t with the Newey–West + HC3 errors that `ols` uses.
 *
 * The 95% interval is every slope the same test wouldn't reject (MacKinnon 2023), shown on
 * the correlation scale, so the interval excludes zero exactly when p < 0.05.
 *
 * A block shuffle of Kalshi's changes was tried first and dropped: it rejected too often when
 * both series were volatile on the same news days (development runs, not in the test suite).
 * correlation-test.test.ts checks the wild bootstrap's false-positive rate, coverage, and power.
 */

export const WILD_DRAWS = 999;

const DAY_MS = 24 * HOUR_MS;

// Webb's six-point weights: mean 0, variance 1, and 6^G sign patterns rather than 2^G,
// which matters with few clusters.
const WEBB = [-Math.sqrt(1.5), -1, -Math.sqrt(0.5), Math.sqrt(0.5), 1, Math.sqrt(1.5)];

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
  const ids = new Map<number, number>();
  const block = Int32Array.from(changes, (c) => {
    const key =
      days === null ? Math.floor((c.t + timeZoneOffsetMs(c.t, DISPLAY_TIME_ZONE)) / DAY_MS) : Math.floor((c.step - first) / days);
    if (!ids.has(key)) ids.set(key, ids.size);
    return ids.get(key)!;
  });
  return { unit: days === null ? "session" : "day_run", block, blocks: ids.size, runDays: days };
}

/** Distinct values of |t| the wild bootstrap can produce: 6^G / 2, or null once it's past any draw count. */
export function weightPatterns(blocks: number): number | null {
  const count = 6 ** blocks / 2;
  return count > 1e9 ? null : count;
}

/** One lag's pairs, prepared for the bootstrap. */
interface Frame {
  m: number;
  /** x − x̄ and y − ȳ over the pairs. */
  dx: Float64Array;
  dy: Float64Array;
  sxx: number;
  syy: number;
  slope: number;
  /** (x − x̄)/(1 − leverage): the HC3-scaled score is this times the residual. */
  c: Float64Array;
  /** Block of each pair's stock return. */
  block: Int32Array;
  /** Newey–West neighbors: the pair j grid slots earlier, or −1. */
  back: Int32Array[];
  weights: number[];
  /** Observed Σ of the Newey–West score products: the slope's variance is this / sxx². */
  s: number;
}

/**
 * Σ c²·a·b plus the Newey–West cross terms, for the pairs (a, a), (a, g), and (g, g) at
 * once: the score variance S as a quadratic in a null slope.
 */
function scoreSums(f: Frame, a: Float64Array, g: Float64Array): [number, number, number] {
  let saa = 0;
  let sag = 0;
  let sgg = 0;
  for (let p = 0; p < f.m; p++) {
    const ca = f.c[p] * a[p];
    const cg = f.c[p] * g[p];
    saa += ca * ca;
    sag += ca * cg;
    sgg += cg * cg;
  }
  for (let j = 0; j < f.back.length; j++) {
    const w = f.weights[j];
    const prev = f.back[j];
    for (let p = 0; p < f.m; p++) {
      const q = prev[p];
      if (q < 0) continue;
      const cp = f.c[p];
      const cq = f.c[q];
      saa += 2 * w * cp * a[p] * cq * a[q];
      sag += w * cp * cq * (a[p] * g[q] + g[p] * a[q]);
      sgg += 2 * w * cp * g[p] * cq * g[q];
    }
  }
  return [saa, sag, sgg];
}

/** Null when the slope's robust error is undefined: no variation, or a pair with leverage 1. */
function frame(x: number[], y: number[], block: number[], steps: number[]): Frame | null {
  const m = x.length;
  const mx = x.reduce((s, v) => s + v, 0) / m;
  const my = y.reduce((s, v) => s + v, 0) / m;
  const dx = Float64Array.from(x, (v) => v - mx);
  const dy = Float64Array.from(y, (v) => v - my);
  const sxx = dx.reduce((s, v) => s + v * v, 0);
  const syy = dy.reduce((s, v) => s + v * v, 0);
  if (!(sxx > 0) || !(syy > 0)) return null;
  const slope = dx.reduce((s, v, p) => s + v * dy[p], 0) / sxx;
  const c = new Float64Array(m);
  for (let p = 0; p < m; p++) {
    const h = 1 / m + (dx[p] * dx[p]) / sxx;
    if (h >= 1 - 1e-10) return null;
    c[p] = dx[p] / (1 - h);
  }
  const lags = neweyWestLags(m);
  const index = new Map(steps.map((s, p) => [s, p]));
  const back = Array.from({ length: lags }, (_, j) => Int32Array.from(steps, (s) => index.get(s - j - 1) ?? -1));
  const weights = Array.from({ length: lags }, (_, j) => 1 - (j + 1) / (lags + 1));
  const f: Frame = { m, dx, dy, sxx, syy, slope, c, block: Int32Array.from(block), back, weights, s: 0 };
  const resid = Float64Array.from(dy, (v, p) => v - slope * dx[p]);
  f.s = scoreSums(f, resid, resid)[0];
  return f.s > 0 ? f : null;
}

/**
 * The slope's t statistic for y on x with Newey–West + HC3 errors, lags pairing slots by
 * `steps`: what `ols` computes, without the matrix algebra. Null when it's undefined.
 */
export function robustSlopeT(x: number[], y: number[], steps: number[]): number | null {
  const f = frame(x, y, x.map(() => 0), steps);
  return f && (f.slope * f.sxx) / Math.sqrt(f.s);
}

/**
 * Per draw: the bootstrap t at any null slope β₀ is (D₀ − β₀·D₁) / √(S₀ − 2β₀·S₁ + β₀²·S₂),
 * so each draw is stored as those five numbers and any β₀ is tested without redrawing.
 */
function wildDraws(f: Frame, weights: Float64Array[]): Float64Array {
  const out = new Float64Array(weights.length * 5);
  const P = new Float64Array(f.m);
  const Q = new Float64Array(f.m);
  weights.forEach((w, d) => {
    let dp = 0;
    let dq = 0;
    let pBar = 0;
    let qBar = 0;
    for (let p = 0; p < f.m; p++) {
      const wp = w[f.block[p]];
      P[p] = f.dy[p] * wp;
      Q[p] = f.dx[p] * wp;
      dp += f.dx[p] * P[p];
      dq += f.dx[p] * Q[p];
      pBar += P[p];
      qBar += Q[p];
    }
    pBar /= f.m;
    qBar /= f.m;
    // Residuals of the bootstrap sample's own fit: α − β₀·γ.
    for (let p = 0; p < f.m; p++) {
      P[p] -= pBar + (dp / f.sxx) * f.dx[p];
      Q[p] -= qBar + (dq / f.sxx) * f.dx[p];
    }
    const [s0, s1, s2] = scoreSums(f, P, Q);
    out.set([dp, dq, s0, s1, s2], d * 5);
  });
  return out;
}

/** Wild bootstrap p-value for slope = β₀: the share of draws at least as extreme as the data. */
function wildP(f: Frame, draws: Float64Array, beta0: number): number {
  const observed = (Math.abs(f.slope - beta0) * f.sxx) / Math.sqrt(f.s);
  let exceed = 0;
  let valid = 0;
  for (let d = 0; d < draws.length; d += 5) {
    const v = draws[d + 2] - 2 * beta0 * draws[d + 3] + beta0 * beta0 * draws[d + 4];
    if (!(v > 0)) continue;
    valid++;
    // A hair of tolerance, so a draw that reproduces the data counts as at least as extreme.
    if (Math.abs(draws[d] - beta0 * draws[d + 1]) / Math.sqrt(v) >= observed * (1 - 1e-12)) exceed++;
  }
  return (1 + exceed) / (1 + valid);
}

/** Where the p-value falls to α on one side of the estimate (bisection), or null if it never does. */
function bound(f: Frame, draws: Float64Array, side: 1 | -1): number | null {
  const se = Math.sqrt(f.s) / f.sxx;
  let inside = f.slope;
  let outside = f.slope + side * 2 * se;
  for (let k = 0; wildP(f, draws, outside) > ALPHA; k++) {
    if (k === 30) return null;
    inside = outside;
    outside = f.slope + side * 2 ** (k + 2) * se;
  }
  for (let k = 0; k < 50 && Math.abs(outside - inside) > 1e-7 * se; k++) {
    const mid = (inside + outside) / 2;
    if (wildP(f, draws, mid) > ALPHA) inside = mid;
    else outside = mid;
  }
  return (inside + outside) / 2;
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

export interface CorrelationTestOptions {
  /** Lags that are the primary test; the rest are exploratory. */
  primaryLags?: number[];
  draws?: number;
}

export interface LagTest {
  lag: number;
  r: number | null;
  n: number;
  kalshiMoves: number;
  test: TestResult;
}

/** Webb weights for each draw, one per block; the same for every lag. */
function drawWeights(blocks: number, draws: number, rng: Rng): Float64Array[] {
  return Array.from({ length: draws }, () => Float64Array.from({ length: blocks }, () => WEBB[Math.floor(rng() * 6)]));
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
  { primaryLags = [], draws = WILD_DRAWS }: CorrelationTestOptions = {},
): LagTest[] {
  const sorted = [...changes].sort((a, b) => a.step - b.step);
  const x = Float64Array.from(sorted, (c) => c.probChangePp);
  const y = Float64Array.from(sorted, (c) => c.logReturn);
  const steps = sorted.map((c) => c.step);
  const byStep = new Map(steps.map((s, i) => [s, i]));
  const layout = blockLayout(sorted, resolution);
  const enough = layout.blocks >= MIN_BOOTSTRAP_BLOCKS;
  const patterns = weightPatterns(layout.blocks);
  const weights = enough ? drawWeights(layout.blocks, draws, seededRng("wild-bootstrap")) : [];

  return lags.map((lag) => {
    const pairs = sorted.flatMap((_, i) => {
      const j = byStep.get(steps[i] + lag);
      return j === undefined ? [] : [[i, j]];
    });
    const n = pairs.length;
    const px = pairs.map(([i]) => x[i]);
    const py = pairs.map(([, j]) => y[j]);
    const r = n >= MIN_PAIRS ? pearson(px, py) : null;
    const f = r === null ? null : frame(px, py, pairs.map(([, j]) => layout.block[j]), pairs.map(([i]) => steps[i]));

    let unavailable: TestResult["pUnavailable"] = null;
    if (n < MIN_PAIRS) unavailable = "too_few_pairs";
    else if (r === null) unavailable = "no_variation";
    else if (!enough) unavailable = "too_few_blocks";
    else if (f === null) unavailable = "unstable";

    let p: number | null = null;
    let ci: [number, number] | null = null;
    if (unavailable === null) {
      const d = wildDraws(f!, weights);
      p = wildP(f!, d, 0);
      const lo = bound(f!, d, -1);
      const hi = bound(f!, d, 1);
      // On the correlation scale: r = slope · sx / sy.
      const scale = Math.sqrt(f!.sxx / f!.syy);
      if (lo !== null && hi !== null) ci = [Math.max(-1, lo * scale), Math.min(1, hi * scale)];
    }
    const resampling: Resampling = {
      unit: layout.unit,
      units: layout.blocks,
      runDays: layout.runDays,
      draws: unavailable === null ? draws : 0,
      arrangements: patterns,
      minP: Math.max(unavailable === null ? 1 / (draws + 1) : 0, patterns === null ? 0 : 1 / patterns),
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
      nEffective: r === null ? null : effectiveN(n, x, y, steps),
      pUnavailable: unavailable,
      ciUnavailable: unavailable ?? (ci === null ? "unstable" : null),
    };
    return { lag, r, n, kalshiMoves: px.filter((v) => v !== 0).length, test };
  });
}
