import { tQuantile, tTwoSidedP } from "./t-distribution";

export interface OlsOptions {
  /**
   * Grid position of each observation (e.g. the interval's step). Lag j pairs only
   * observations exactly j steps apart, so lags never reach across a gap such as a night.
   * Defaults to 0, 1, 2, …: consecutive observations.
   */
  steps?: number[];
  /** Newey–West lags (Bartlett weights). 0 gives heteroskedasticity-robust errors only. */
  lags?: number;
  /**
   * Divide each residual by (1 − leverage), as HC3 does. OLS fits high-leverage points
   * (here: the few intervals where Kalshi moved) closely, so their raw residuals understate
   * the noise and make the standard errors too small.
   */
  leverageAdjust?: boolean;
}

export interface OlsFit {
  coef: number[];
  /** Robust standard errors; all null if one observation alone determines a coefficient (leverage 1), where HC3 is undefined. */
  se: (number | null)[];
  t: (number | null)[];
  /** Two-sided p-values from Student's t with `df` degrees of freedom. */
  p: (number | null)[];
  n: number;
  /** n − k */
  df: number;
  /** Share of the variance of y explained (the first column must be the intercept). */
  r2: number;
  lags: number;
}

/** Newey–West (1994) rule-of-thumb bandwidth: ⌊4 (n / 100)^(2/9)⌋. */
export function neweyWestLags(n: number): number {
  return n > 0 ? Math.floor(4 * (n / 100) ** (2 / 9)) : 0;
}

function multiply(a: number[][], b: number[][]): number[][] {
  return a.map((row) => b[0].map((_, j) => row.reduce((s, v, i) => s + v * b[i][j], 0)));
}

/** Inverse of a small symmetric positive-definite matrix (Gauss–Jordan with pivoting), or null if it's singular. */
function invert(m: number[][]): number[][] | null {
  const k = m.length;
  const a = m.map((row, i) => [...row, ...Array.from({ length: k }, (_, j) => (i === j ? 1 : 0))]);
  const scale = Math.max(...m.map((row, i) => Math.abs(row[i])));
  if (!(scale > 0)) return null;
  for (let col = 0; col < k; col++) {
    let pivot = col;
    for (let r = col + 1; r < k; r++) if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    if (Math.abs(a[pivot][col]) <= 1e-12 * scale) return null;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    const p = a[col][col];
    for (let j = 0; j < 2 * k; j++) a[col][j] /= p;
    for (let r = 0; r < k; r++) {
      if (r === col || a[r][col] === 0) continue;
      const f = a[r][col];
      for (let j = 0; j < 2 * k; j++) a[r][j] -= f * a[col][j];
    }
  }
  return a.map((row) => row.slice(k));
}

/**
 * Ordinary least squares of y on the columns of X (include a column of 1s for an
 * intercept), with Newey–West HAC standard errors. With `lags` 0 and `leverageAdjust`
 * these are HC3 errors; with `leverageAdjust` off they match the textbook Newey–West
 * estimator without a small-sample factor. Null with too few observations or when the
 * columns are collinear (e.g. a regressor that never varies).
 */
export function ols(X: number[][], y: number[], { steps, lags = 0, leverageAdjust = true }: OlsOptions = {}): OlsFit | null {
  const n = y.length;
  const k = X[0]?.length ?? 0;
  if (k === 0 || X.length !== n || n <= k) return null;
  const pos = steps ?? X.map((_, i) => i);

  const xtx = Array.from({ length: k }, (_, a) =>
    Array.from({ length: k }, (_, b) => X.reduce((s, row) => s + row[a] * row[b], 0)),
  );
  const inv = invert(xtx);
  if (!inv) return null;
  const xty = Array.from({ length: k }, (_, a) => X.reduce((s, row, i) => s + row[a] * y[i], 0));
  const coef = inv.map((row) => row.reduce((s, v, b) => s + v * xty[b], 0));

  const fitted = X.map((row) => row.reduce((s, v, a) => s + v * coef[a], 0));
  const resid = y.map((v, i) => v - fitted[i]);
  const meanY = y.reduce((s, v) => s + v, 0) / n;
  const sst = y.reduce((s, v) => s + (v - meanY) ** 2, 0);
  const ssr = resid.reduce((s, v) => s + v * v, 0);

  // Scores x_t·e_t, each residual scaled up by its leverage if asked.
  let exact = false;
  const scores = X.map((row, i) => {
    let e = resid[i];
    if (leverageAdjust) {
      const h = row.reduce((s, v, a) => s + v * inv[a].reduce((t, w, b) => t + w * row[b], 0), 0);
      if (h >= 1 - 1e-10) exact = true;
      e /= 1 - h;
    }
    return row.map((v) => v * e);
  });

  // S = Σ u_t u_t' + Σ_j w_j Σ_{steps j apart} (u_t u_s' + u_s u_t'), Bartlett w_j = 1 − j/(L+1).
  const S = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const addOuter = (u: number[], v: number[], w: number) => {
    for (let a = 0; a < k; a++) for (let b = 0; b < k; b++) S[a][b] += w * (u[a] * v[b] + v[a] * u[b]);
  };
  scores.forEach((u) => addOuter(u, u, 0.5));
  if (lags > 0) {
    const byStep = new Map(pos.map((s, i) => [s, i]));
    for (let j = 1; j <= lags; j++) {
      const w = 1 - j / (lags + 1);
      pos.forEach((s, i) => {
        const earlier = byStep.get(s - j);
        if (earlier !== undefined) addOuter(scores[i], scores[earlier], w);
      });
    }
  }
  const V = multiply(multiply(inv, S), inv);

  const df = n - k;
  const se = coef.map((_, a) => (exact || !(V[a][a] >= 0) ? null : Math.sqrt(V[a][a])));
  const t = coef.map((c, a) => (se[a] ? c / se[a]! : null));
  return {
    coef,
    se,
    t,
    p: t.map((v) => (v === null ? null : tTwoSidedP(v, df))),
    n,
    df,
    r2: sst > 0 ? 1 - ssr / sst : 0,
    lags,
  };
}

/** 95% confidence interval for coefficient `a` of a fit, or null without a standard error. */
export function confidenceInterval95(fit: OlsFit, a: number): [number, number] | null {
  const se = fit.se[a];
  const q = tQuantile(0.975, fit.df);
  if (se === null || q === null) return null;
  return [fit.coef[a] - q * se, fit.coef[a] + q * se];
}
