import { benjaminiHochberg, holm } from "./multiple-testing";

/** Significance level for every test and correction in the Research section. */
export const ALPHA = 0.05;

/**
 * The primary test is the one question the page is set up to answer (same-period,
 * market-adjusted); it's judged on its own p-value. Everything else is exploratory.
 */
export type TestRole = "primary" | "exploratory";

/** Tests corrected together for multiple testing. */
export type TestFamily =
  /** Every exploratory lag on the lead-lag chart. */
  | "lead_lag"
  /** Every event-study bar except the reference bar, rises and falls together. */
  | "event_horizons"
  /** The whole-path tests for rises and falls. */
  | "event_paths";

export type TestMethod =
  /**
   * Wild cluster bootstrap with the null imposed: the stock's residuals get one random weight
   * per session (hourly) or run of trading days (daily); Kalshi's changes stay as observed.
   */
  | "wild_bootstrap"
  /** Each event's deviation from the baseline flipped in sign at random; t statistic. */
  | "sign_flip";

export type IntervalMethod =
  /** Every value the wild bootstrap test wouldn't reject at 5%. */
  | "wild_bootstrap"
  /** Events resampled with replacement; bootstrap-t interval. */
  | "event_bootstrap";

/** Why a p-value or interval isn't reported. */
export type Unavailable =
  | "too_few_pairs"
  | "no_variation"
  /** Too few sessions or runs of days for the bootstrap to be reliable. */
  | "too_few_blocks"
  | "too_few_events"
  /** Too many resamples had no variation, or one observation alone decides the estimate. */
  | "unstable";

export interface Resampling {
  /** What the random draws work on: sessions or runs of days (one weight each), or events. */
  unit: "session" | "day_run" | "event";
  /** How many: sessions, runs of days, or events. */
  units: number;
  /** Trading days in each run, for day runs. */
  runDays: number | null;
  /** Random draws behind the p-value; 0 when the test wasn't run. */
  draws: number;
  /** Distinct results the draws can produce, when few enough to limit the p-value; null otherwise. */
  arrangements: number | null;
  /** Smallest p-value the test can give: 1/(draws + 1), or 1/arrangements when that's larger. */
  minP: number;
  /**
   * What else is re-estimated in every draw, so its uncertainty is in the p-value and
   * interval: the market model's alpha and beta (over its own sample), or the regression's
   * other coefficients. Null when only the test's own fit is.
   */
  refit: "market_model" | "regression" | null;
}

/** The result of one hypothesis test, in the same shape for every test on the page. */
export interface TestResult {
  /** What's estimated, in the test's own units (a correlation, a return in %, a coefficient). */
  estimate: number | null;
  /** 95% confidence interval for the estimate. */
  ci: [number, number] | null;
  /** Two-sided p-value for "no relationship". */
  p: number | null;
  /** Holm-adjusted p within the family; null outside a family. */
  holm: number | null;
  /** Benjamini–Hochberg-adjusted p within the family; null outside a family. */
  bh: number | null;
  role: TestRole;
  family: TestFamily | null;
  method: TestMethod;
  interval: IntervalMethod | null;
  /** Null for analytic tests. */
  resampling: Resampling | null;
  n: number;
  /** Independent observations the sample is worth, allowing for autocorrelation, where that applies. */
  nEffective: number | null;
  pUnavailable: Unavailable | null;
  ciUnavailable: Unavailable | null;
}

/** Whether a result is below ALPHA after a correction (or, for "raw", before any). */
export function passes(test: TestResult, by: "raw" | "holm" | "bh"): boolean {
  const p = by === "raw" ? test.p : test[by];
  return p !== null && p < ALPHA;
}

/** Sets Holm and Benjamini–Hochberg adjusted p-values across one family of exploratory tests. */
export function adjustFamily(tests: TestResult[], family: TestFamily): TestResult[] {
  const ps = tests.map((t) => t.p);
  const h = holm(ps);
  const bh = benjaminiHochberg(ps);
  return tests.map((t, i) => ({ ...t, family, holm: h[i], bh: bh[i] }));
}

/** The q-quantile of sorted values, interpolating linearly between order statistics (numpy's default). */
export function quantileSorted(sorted: ArrayLike<number>, q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.min(lo + 1, sorted.length - 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** 95% percentile interval from resampled estimates (unsorted; NaN for undefined resamples). */
export function percentileInterval(values: Float64Array, minDefinedShare = 0.9): [number, number] | null {
  const defined = values.filter((v) => !Number.isNaN(v)).sort();
  if (defined.length === 0 || defined.length < minDefinedShare * values.length) return null;
  return [quantileSorted(defined, 0.025), quantileSorted(defined, 0.975)];
}
