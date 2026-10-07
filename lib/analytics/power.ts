import { ALPHA } from "./inference";
import type { Rng } from "./random";
import { drawWeights, residualize, scoreSums, stageOneAtPairs, type Frame } from "./wild-bootstrap";

/**
 * Power of the wild bootstrap test for one sample, by simulation: how large an effect along
 * Kalshi's changes it detects at 5% in a given share of samples like this one.
 *
 * Each simulated sample keeps everything observed but the stock's direction: Kalshi's
 * changes, the benchmark's returns, the blocks, and the stock's residual volatility (stage
 * 1's residuals times one fresh Webb weight per block), plus a built-in effect γ times the
 * Kalshi change. Both stages are refitted, as the test does. Rerunning the bootstrap inside
 * every simulated sample would cost 999 × 999 draws, so critical values come from the
 * warp-speed method (Giacomini, Politis & White 2013): each simulated sample gets one inner
 * bootstrap draw from its own restricted residuals, which carry the effect, and the 999
 * inner draws together stand in for the test's null distribution. Every simulated t and
 * inner t is a closed-form function of γ, so any γ is evaluated without redrawing.
 *
 * That alone is optimistic: it takes this sample's volatility as known, but with heavy-tailed
 * returns the volatility in the few hours Kalshi moved rests on a handful of intervals, and
 * effects of the size it reported were detected only about 71–77% of the time in fresh
 * samples (development runs, not in the test suite). So the power is averaged over how uncertain that volatility is: the
 * statistic's score variance is resampled by session (or run of days), and since the test
 * is scale-free, noise k times larger is the same as an effect k times smaller. Few sessions
 * or heavy tails then widen the spread and raise the detectable size. power.test.ts checks
 * the result against the full test, with its own bootstrap, on fresh samples.
 */

/** Power the detectable effect is defined at. */
export const DETECTABLE_POWER = 0.8;
/** Simulated samples behind each power estimate. */
export const POWER_SAMPLES = 999;
/** Resamples of the score variance the power is averaged over. */
export const SCALE_RESAMPLES = 200;
/**
 * Largest detectable |ρ| reported as a number. Above it the power curve flattens (the effect
 * swamps the noise the test resamples) and the simulation stops being a reliable guide: with
 * 20 daily intervals, effects of the reported size (median 0.95) were detected only about
 * 60% of the time (development runs).
 */
export const MAX_DETECTABLE = 0.8;

// Per simulated sample: D, S00, S0Δ for its own t, and qH, qG, sHH, sHG, sGG for its inner draw.
const STRIDE = 8;

/** Simulated samples for a frame: each one's t and inner bootstrap t as functions of γ. */
export interface PowerSimulation {
  f: Frame;
  stats: Float64Array;
  /** s(Δ, Δ): the part of a simulated sample's score variance that grows with γ². */
  sdd: number;
  samples: number;
}

/** `blocks` is how many blocks stage 1's sample has; every one gets a weight. */
export function simulatePower(f: Frame, blocks: number, samples: number, rng: Rng): PowerSimulation {
  // What an effect γ·x̌ leaves in stage 2's residuals once both stages are refitted: γ·Δ.
  const delta = Float64Array.from(f.qc, (v, p) => v - f.kappa * f.xc[p]);
  const sdd = scoreSums(f, delta, delta)[0];
  const stats = new Float64Array(samples * STRIDE);
  const A = new Float64Array(f.n);
  const MAfull = new Float64Array(f.n);
  const H = new Float64Array(f.n);
  const G = new Float64Array(f.n);
  const E0 = new Float64Array(f.m);
  const RH = new Float64Array(f.m);
  const RG = new Float64Array(f.m);
  for (let s = 0; s < samples; s++) {
    const [w, v] = drawWeights(blocks, 2, rng);
    // The simulated sample's stage-1 residuals, without the effect: M₁(a∘w).
    for (let t = 0; t < f.n; t++) A[t] = f.a[t] * w[f.block[t]];
    let d = 0;
    for (let t = 0; t < f.n; t++) d += f.q[t] * A[t];
    residualize(f.one, A, MAfull);
    for (let p = 0; p < f.m; p++) E0[p] = MAfull[f.index[p]];
    residualize(f.two, E0, E0);
    for (let p = 0; p < f.m; p++) E0[p] -= (d / f.sxx) * f.xc[p];
    const [s00, s0d] = scoreSums(f, E0, delta);

    // Its inner draw: restricted residuals γ·q + M₁(a∘w), times fresh weights v.
    let qh = 0;
    let qg = 0;
    for (let t = 0; t < f.n; t++) {
      const vt = v[f.block[t]];
      H[t] = MAfull[t] * vt;
      G[t] = f.q[t] * vt;
      qh += f.q[t] * H[t];
      qg += f.q[t] * G[t];
    }
    stageOneAtPairs(f, H, RH);
    stageOneAtPairs(f, G, RG);
    residualize(f.two, RH, RH);
    residualize(f.two, RG, RG);
    for (let p = 0; p < f.m; p++) {
      RH[p] -= (qh / f.sxx) * f.xc[p];
      RG[p] -= (qg / f.sxx) * f.xc[p];
    }
    const [shh, shg, sgg] = scoreSums(f, RH, RG);
    stats.set([d, s00, s0d, qh, qg, shh, shg, sgg], s * STRIDE);
  }
  return { f, stats, sdd, samples };
}

/** Share of simulated samples in which the test rejects at ALPHA when the built-in effect is γ. */
export function powerAt({ f, stats, sdd, samples }: PowerSimulation, gamma: number): number {
  const observed = new Float64Array(samples);
  const inner = new Float64Array(samples);
  let valid = 0;
  for (let s = 0; s < samples; s++) {
    const o = s * STRIDE;
    const v = stats[o + 1] + 2 * gamma * stats[o + 2] + gamma * gamma * sdd;
    observed[s] = v > 0 ? Math.abs(gamma * f.kappa * f.sxx + stats[o]) / Math.sqrt(v) : NaN;
    // (qH + γ·qG) / √(sHH + 2γ·sHG + γ²·sGG): the residuals are R_H + γ·R_G.
    const vi = stats[o + 5] + 2 * gamma * stats[o + 6] + gamma * gamma * stats[o + 7];
    if (vi > 0) inner[valid++] = Math.abs(stats[o + 3] + gamma * stats[o + 4]) / Math.sqrt(vi);
  }
  const sorted = inner.subarray(0, valid).sort();
  let rejected = 0;
  for (const t of observed) {
    if (Number.isNaN(t)) continue;
    // Inner draws at least as extreme (the same tolerance as the test), by binary search.
    const cut = t * (1 - 1e-12);
    let lo = 0;
    let hi = valid;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] < cut) lo = mid + 1;
      else hi = mid;
    }
    if ((1 + valid - lo) / (1 + valid) < ALPHA) rejected++;
  }
  return rejected / samples;
}

/** The effect γ that gives a correlation ρ between the Kalshi changes and stage 1's residuals. */
export function effectForCorrelation(f: Frame, rho: number): number {
  const theta = (rho * Math.sqrt(f.syy)) / (Math.sqrt(f.sxx) * Math.sqrt(1 - rho * rho));
  return theta / f.kappa;
}

/**
 * The statistic's score variance resampled by block, as ratios to the observed: blocks of the
 * pairs drawn with replacement, each carrying its own score terms (Newey–West pairs go with
 * the later pair's block).
 */
export function scoreVarianceRatios(f: Frame, resamples: number, rng: Rng): Float64Array {
  const ac = residualize(f.two, Float64Array.from(f.index, (j) => f.a[j]));
  const e = Float64Array.from(ac, (v, p) => (v - f.slope * f.xc[p]) * f.c[p]);
  const byBlock = new Map<number, number>();
  const add = (b: number, v: number) => byBlock.set(b, (byBlock.get(b) ?? 0) + v);
  for (let p = 0; p < f.m; p++) add(f.block[f.index[p]], e[p] * e[p]);
  f.back.forEach((prev, j) => {
    for (let p = 0; p < f.m; p++) if (prev[p] >= 0) add(f.block[f.index[p]], 2 * f.weights[j] * e[p] * e[prev[p]]);
  });
  const terms = [...byBlock.values()];
  return Float64Array.from({ length: resamples }, () => {
    let total = 0;
    for (let k = 0; k < terms.length; k++) total += terms[Math.floor(rng() * terms.length)];
    return Math.max(total, 0) / f.s;
  });
}

// Points on each direction's power curve, from γ = 0 to the γ of ρ = CURVE_RHO.
const CURVE_POINTS = 160;
const CURVE_RHO = 0.95;

/**
 * The smallest |ρ| up to MAX_DETECTABLE whose power, averaged over the volatility ratios, is
 * at least `target` in both directions, and the effect γ that gives it; null if none is. The
 * scenario with ratio R has the observed noise times 1/√R, the same as the effect times √R.
 */
export function detectableEffect(
  sim: PowerSimulation,
  ratios: Float64Array,
  target = DETECTABLE_POWER,
): { rho: number; gamma: number } | null {
  let worst: { rho: number; gamma: number } | null = null;
  const top = effectForCorrelation(sim.f, CURVE_RHO);
  for (const sign of [1, -1]) {
    const curve = Float64Array.from({ length: CURVE_POINTS + 1 }, (_, k) => powerAt(sim, (sign * top * k) / CURVE_POINTS));
    const powerOf = (gamma: number) => {
      const x = Math.min(CURVE_POINTS, (gamma / top) * CURVE_POINTS);
      const lo = Math.floor(x);
      const hi = Math.min(CURVE_POINTS, lo + 1);
      return curve[lo] + (curve[hi] - curve[lo]) * (x - lo);
    };
    const at = (rho: number) => {
      const gamma = effectForCorrelation(sim.f, rho);
      let sum = 0;
      for (const r of ratios) sum += powerOf(gamma * Math.sqrt(r));
      return sum / ratios.length >= target;
    };
    // A grid of 0.01, then bisection to 0.0005.
    let hi = 0.01;
    while (hi <= MAX_DETECTABLE + 1e-9 && !at(hi)) hi += 0.01;
    if (hi > MAX_DETECTABLE + 1e-9) return null;
    let lo = hi - 0.01;
    while (hi - lo > 0.0005) {
      const mid = (lo + hi) / 2;
      if (at(mid)) hi = mid;
      else lo = mid;
    }
    if (worst === null || hi > worst.rho) worst = { rho: hi, gamma: sign * effectForCorrelation(sim.f, hi) };
  }
  return worst;
}
