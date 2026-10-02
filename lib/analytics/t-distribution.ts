// Student's t distribution, for regression p-values and confidence intervals.

// Lanczos approximation (g = 7, n = 9), accurate to about 15 significant digits.
const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
  12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

/** ln Γ(x) for x > 0. */
function logGamma(x: number): number {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const z = x - 1;
  let sum = LANCZOS[0];
  for (let i = 1; i < LANCZOS.length; i++) sum += LANCZOS[i] / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(sum);
}

/** Continued fraction for the incomplete beta function (modified Lentz's method). */
function betaContinuedFraction(x: number, a: number, b: number): number {
  const TINY = 1e-300;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-15) break;
  }
  return h;
}

/** Regularized incomplete beta function I_x(a, b), for 0 ≤ x ≤ 1. */
export function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  // The continued fraction converges fastest on this side of the mean.
  return x < (a + 1) / (a + b + 2)
    ? (front * betaContinuedFraction(x, a, b)) / a
    : 1 - (front * betaContinuedFraction(1 - x, b, a)) / b;
}

/** Two-sided p-value of a t statistic with `df` degrees of freedom: P(|T| ≥ |t|). */
export function tTwoSidedP(t: number, df: number): number | null {
  if (!Number.isFinite(t) || !(df > 0)) return null;
  return incompleteBeta(df / (df + t * t), df / 2, 0.5);
}

/** The t value with P(T ≤ t) = p, for 0.5 ≤ p < 1, e.g. p = 0.975 for a 95% interval. */
export function tQuantile(p: number, df: number): number | null {
  if (!(p >= 0.5 && p < 1) || !(df > 0)) return null;
  const tail = 2 * (1 - p);
  let lo = 0;
  let hi = 1;
  // P(|T| ≥ t) falls as t grows; widen until it's below the target, then bisect.
  while (tTwoSidedP(hi, df)! > tail) hi *= 2;
  for (let i = 0; i < 200 && hi - lo > 1e-12 * hi; i++) {
    const mid = (lo + hi) / 2;
    if (tTwoSidedP(mid, df)! > tail) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}
