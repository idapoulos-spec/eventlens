import { ALPHA } from "./inference";
import type { Rng } from "./random";
import { neweyWestLags } from "./regression";

/**
 * The wild cluster bootstrap behind every correlation and regression test in the Research
 * section, with the null imposed and everything that's estimated refitted in every draw.
 *
 * The tests run in two stages, as the page computes them:
 * 1. OLS of the stock's return on a mean and, optionally, the benchmark's return, over a
 *    sample F of intervals: the market model over the loaded 90 days, or just a mean.
 * 2. OLS of stage 1's residual on controls (a mean, and optionally the benchmark's return)
 *    plus the Kalshi change, over pairs whose stock returns are in F. The test is on the
 *    Kalshi coefficient θ, studentized with Newey–West + HC3 errors as `ols` computes them.
 *
 * Under "θ = θ₀" the stock's returns are rebuilt as the restricted fit (stage 1's model plus
 * an effect γ₀ along the Kalshi changes) plus each restricted residual times one Webb weight
 * per block, and both stages are refitted. γ₀ = θ₀/κ, where κ is the share of the Kalshi
 * changes' variation that stage 1 leaves in place: the market model absorbs part of any
 * effect that lines up with the benchmark, so stage 2 sees θ = κγ. Every quantity is affine
 * in γ₀, so each draw is stored as five numbers and any θ₀ is tested without redrawing.
 *
 * With stage 1 just a mean over stage 2's own pairs, this is the plain wild bootstrap of a
 * correlation: stage 1 does nothing beyond what stage 2 already does, and κ = 1.
 */

// Webb's six-point weights: mean 0, variance 1, and 6^G sign patterns rather than 2^G,
// which matters with few clusters.
const WEBB = [-Math.sqrt(1.5), -1, -Math.sqrt(0.5), Math.sqrt(0.5), 1, Math.sqrt(1.5)];

/** Webb weights for each draw, one per block. */
export function drawWeights(blocks: number, draws: number, rng: Rng): Float64Array[] {
  return Array.from({ length: draws }, () => Float64Array.from({ length: blocks }, () => WEBB[Math.floor(rng() * 6)]));
}

/** Stage 1's sample F. */
export interface StageOne {
  /** Stock return in each interval. */
  r: ArrayLike<number>;
  /** Benchmark return in each interval, or null to fit only a mean. */
  m: ArrayLike<number> | null;
  /** Block (session or run of days) of each interval, numbered from 0. */
  block: Int32Array;
}

/** Stage 2's pairs. */
export interface StageTwo {
  /** Position in F of each pair's stock return. */
  index: Int32Array;
  /** Kalshi change of each pair. */
  x: ArrayLike<number>;
  /** Grid position of each pair, for Newey–West lags (the Kalshi change's step). */
  steps: number[];
  /** Also hold the benchmark's return fixed in stage 2 (the regression), not only a mean. */
  market: boolean;
}

/** Residualizes on [1, m − m̄] (or [1]) over a sample, without matrices. */
export interface Projector {
  n: number;
  /** m − m̄, or null for a mean only. */
  mc: Float64Array | null;
  smm: number;
}

export function projector(n: number, m: ArrayLike<number> | null): Projector | null {
  if (m === null) return { n, mc: null, smm: 0 };
  let mean = 0;
  for (let i = 0; i < n; i++) mean += m[i];
  mean /= n;
  const mc = Float64Array.from({ length: n }, (_, i) => m[i] - mean);
  const smm = mc.reduce((s, v) => s + v * v, 0);
  return smm > 0 ? { n, mc, smm } : null;
}

/** v minus its fit on the projector's columns, into `out` (which may be v). */
export function residualize(p: Projector, v: ArrayLike<number>, out: Float64Array = new Float64Array(p.n)): Float64Array {
  let mean = 0;
  let cross = 0;
  for (let i = 0; i < p.n; i++) {
    mean += v[i];
    if (p.mc) cross += p.mc[i] * v[i];
  }
  mean /= p.n;
  const b = p.mc ? cross / p.smm : 0;
  for (let i = 0; i < p.n; i++) out[i] = v[i] - mean - (p.mc ? b * p.mc[i] : 0);
  return out;
}

/** Both stages for the observed data, prepared for the bootstrap. */
export interface Frame {
  /** Intervals in F, and pairs. */
  n: number;
  m: number;
  index: Int32Array;
  block: Int32Array;
  one: Projector;
  two: Projector;
  /** Stage 1's residuals over F. */
  a: Float64Array;
  /** The Kalshi changes residualized on stage 2's controls (x̌), by pair. */
  xc: Float64Array;
  sxx: number;
  /** Σ of stage 1's residuals squared over the pairs, after stage 2's controls. */
  syy: number;
  /** θ̂. */
  slope: number;
  /** x̌ placed at each pair's interval in F, then residualized on stage 1 (q = M₁u). */
  q: Float64Array;
  /** ‖q‖² / ‖x̌‖². */
  kappa: number;
  /** q at the pairs, residualized on stage 2's controls. */
  qc: Float64Array;
  /** x̌/(1 − leverage): the HC3-scaled score is this times the residual. */
  c: Float64Array;
  /** Newey–West neighbors: the pair j grid slots earlier, or −1. */
  back: Int32Array[];
  weights: number[];
  /** Observed Σ of the Newey–West score products: θ̂'s variance is this / sxx². */
  s: number;
}

/**
 * Σ c²·a·b plus the Newey–West cross terms, for the pairs (a, a), (a, g), and (g, g) at
 * once: the score variance as a quadratic in γ when the residuals are a − γ·g.
 */
export function scoreSums(f: Frame, a: Float64Array, g: Float64Array): [number, number, number] {
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

/**
 * Null when the test is undefined: the benchmark or the Kalshi changes don't vary once the
 * controls are taken out, the stock's residuals don't vary, a pair has leverage 1, stage 1
 * absorbs the Kalshi changes entirely, or two pairs share a stock return.
 */
export function frame(one: StageOne, two: StageTwo): Frame | null {
  const n = one.r.length;
  const m = two.x.length;
  const p1 = projector(n, one.m);
  const mAtPairs = two.market && one.m ? Float64Array.from(two.index, (j) => one.m![j]) : null;
  const p2 = projector(m, two.market ? mAtPairs : null);
  if (!p1 || !p2 || (two.market && !one.m)) return null;

  const a = residualize(p1, one.r);
  const xc = residualize(p2, two.x);
  const sxx = xc.reduce((s, v) => s + v * v, 0);
  let sx = 0;
  for (let p = 0; p < m; p++) sx += two.x[p] * two.x[p];
  if (!(sxx > 1e-12 * sx)) return null;
  const ac = residualize(p2, Float64Array.from(two.index, (j) => a[j]));
  const syy = ac.reduce((s, v) => s + v * v, 0);
  if (!(syy > 0)) return null;
  const slope = xc.reduce((s, v, p) => s + v * ac[p], 0) / sxx;

  const u = new Float64Array(n);
  const used = new Uint8Array(n);
  for (let p = 0; p < m; p++) {
    const j = two.index[p];
    if (used[j]) return null;
    used[j] = 1;
    u[j] = xc[p];
  }
  const q = residualize(p1, u);
  const kappa = q.reduce((s, v) => s + v * v, 0) / sxx;
  if (!(kappa > 1e-9)) return null;
  const qc = residualize(p2, Float64Array.from(two.index, (j) => q[j]));

  const c = new Float64Array(m);
  for (let p = 0; p < m; p++) {
    const h = 1 / m + (p2.mc ? (p2.mc[p] * p2.mc[p]) / p2.smm : 0) + (xc[p] * xc[p]) / sxx;
    if (h >= 1 - 1e-10) return null;
    c[p] = xc[p] / (1 - h);
  }
  const lags = neweyWestLags(m);
  const position = new Map(two.steps.map((s, p) => [s, p]));
  const back = Array.from({ length: lags }, (_, j) => Int32Array.from(two.steps, (s) => position.get(s - j - 1) ?? -1));
  const weights = Array.from({ length: lags }, (_, j) => 1 - (j + 1) / (lags + 1));
  const f: Frame = { n, m, index: two.index, block: one.block, one: p1, two: p2, a, xc, sxx, syy, slope, q, kappa, qc, c, back, weights, s: 0 };
  const resid = Float64Array.from(ac, (v, p) => v - slope * xc[p]);
  f.s = scoreSums(f, resid, resid)[0];
  return f.s > 0 ? f : null;
}

/** Stage 1's residuals of v over F, at the pairs only, into `out`. */
export function stageOneAtPairs(f: Frame, v: Float64Array, out: Float64Array): Float64Array {
  const { one } = f;
  let mean = 0;
  let cross = 0;
  for (let t = 0; t < f.n; t++) {
    mean += v[t];
    if (one.mc) cross += one.mc[t] * v[t];
  }
  mean /= f.n;
  const b = one.mc ? cross / one.smm : 0;
  for (let p = 0; p < f.m; p++) {
    const j = f.index[p];
    out[p] = v[j] - mean - (one.mc ? b * one.mc[j] : 0);
  }
  return out;
}

/** Working arrays for one frame's draws. */
function scratch(f: Frame) {
  return {
    A: new Float64Array(f.n),
    B: new Float64Array(f.n),
    MA: new Float64Array(f.m),
    MB: new Float64Array(f.m),
    E0: new Float64Array(f.m),
    E1: new Float64Array(f.m),
  };
}

/**
 * Per draw, the bootstrap t at any null θ₀ is (D₀ − γ₀·D₁) / √(S₀ − 2γ₀·S₁ + γ₀²·S₂),
 * with γ₀ = θ₀/κ, so each draw is stored as those five numbers.
 */
export function wildDraws(f: Frame, weights: Float64Array[]): Float64Array {
  const out = new Float64Array(weights.length * 5);
  const { A, B, MA, MB, E0, E1 } = scratch(f);
  weights.forEach((w, d) => {
    // The restricted residuals at γ₀ = 0 and their slope in γ₀ (a − γ₀·q), times the weights.
    let d0 = 0;
    let d1 = 0;
    for (let t = 0; t < f.n; t++) {
      const wt = w[f.block[t]];
      A[t] = f.a[t] * wt;
      B[t] = f.q[t] * wt;
      d0 += f.q[t] * A[t];
      d1 += f.q[t] * B[t];
    }
    // Refit stage 1, then stage 2's controls; the effect γ₀·q comes back in through MB.
    stageOneAtPairs(f, A, MA);
    stageOneAtPairs(f, B, MB);
    for (let p = 0; p < f.m; p++) MB[p] -= f.q[f.index[p]];
    residualize(f.two, MA, MA);
    residualize(f.two, MB, MB);
    // Stage 2's residuals, E₀ − γ₀·E₁.
    for (let p = 0; p < f.m; p++) {
      E0[p] = MA[p] - (d0 / f.sxx) * f.xc[p];
      E1[p] = MB[p] + (f.kappa - d1 / f.sxx) * f.xc[p];
    }
    const [s0, s1, s2] = scoreSums(f, E0, E1);
    out.set([d0, d1, s0, s1, s2], d * 5);
  });
  return out;
}

/** Wild bootstrap p-value for θ = θ₀: the share of draws at least as extreme as the data. */
export function wildP(f: Frame, draws: Float64Array, theta0: number): number {
  const observed = (Math.abs(f.slope - theta0) * f.sxx) / Math.sqrt(f.s);
  const g = theta0 / f.kappa;
  let exceed = 0;
  let valid = 0;
  for (let d = 0; d < draws.length; d += 5) {
    const v = draws[d + 2] - 2 * g * draws[d + 3] + g * g * draws[d + 4];
    if (!(v > 0)) continue;
    valid++;
    // A hair of tolerance, so a draw that reproduces the data counts as at least as extreme.
    if (Math.abs(draws[d] - g * draws[d + 1]) / Math.sqrt(v) >= observed * (1 - 1e-12)) exceed++;
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

/** p-value for θ = 0 and the 95% interval (every θ₀ the test wouldn't reject), on θ's scale. */
export function wildTest(f: Frame, weights: Float64Array[]): { p: number; ci: [number, number] | null } {
  const draws = wildDraws(f, weights);
  const lo = bound(f, draws, -1);
  const hi = bound(f, draws, 1);
  return { p: wildP(f, draws, 0), ci: lo !== null && hi !== null ? [lo, hi] : null };
}

/**
 * The observed t for θ = θ₀ and each draw's bootstrap t, for checking the closed form
 * against refitting by brute force.
 */
export function bootstrapTs(f: Frame, weights: Float64Array[], theta0: number): { observed: number; draws: number[] } {
  const draws = wildDraws(f, weights);
  const g = theta0 / f.kappa;
  const out: number[] = [];
  for (let d = 0; d < draws.length; d += 5) {
    out.push((draws[d] - g * draws[d + 1]) / Math.sqrt(draws[d + 2] - 2 * g * draws[d + 3] + g * g * draws[d + 4]));
  }
  return { observed: ((f.slope - theta0) * f.sxx) / Math.sqrt(f.s), draws: out };
}

