import type { ChangePoint } from "./changes";
import { correlationStats, type CorrelationStats } from "./correlation";
import { lagCorrelationTests, type CorrelationTestOptions } from "./correlation-test";
import { adjustFamily, type TestResult } from "./inference";
import type { Resolution } from "./research";

export interface LagCorrelation extends CorrelationStats {
  /**
   * Grid slots between the Kalshi change and the stock return it's paired with.
   * Positive: the Kalshi change came first. Negative: the stock return came first.
   */
  lag: number;
  /** Significance, with Holm and Benjamini–Hochberg adjustment across the exploratory lags. */
  test: TestResult;
}

/**
 * Cross-correlation of Kalshi changes with stock returns, for lags −maxLag…maxLag.
 * At lag k, the Kalshi change in slot s is paired with the stock return in slot s + k,
 * so a pair is only formed when both slots are usable; lags never reach across a gap.
 * `primaryLag` marks the lag that is the primary test: it's left out of the family the
 * others are corrected in.
 */
export function crossCorrelation(
  changes: ChangePoint[],
  maxLag: number,
  resolution: Resolution,
  { primaryLag, ...options }: Omit<CorrelationTestOptions, "primaryLags"> & { primaryLag?: number } = {},
): LagCorrelation[] {
  const byStep = new Map(changes.map((c) => [c.step, c]));
  const lags = Array.from({ length: 2 * maxLag + 1 }, (_, i) => i - maxLag);
  const tests = lagCorrelationTests(changes, lags, resolution, { ...options, primaryLags: primaryLag === undefined ? [] : [primaryLag] });
  const exploratory = adjustFamily(
    tests.filter((t) => t.test.role === "exploratory").map((t) => t.test),
    "lead_lag",
  );
  let next = 0;
  return lags.map((lag, k) => {
    const pairs = [];
    for (const c of changes) {
      const later = byStep.get(c.step + lag);
      if (later) pairs.push({ x: c.probChangePp, y: later.logReturn });
    }
    const test = tests[k].test.role === "exploratory" ? exploratory[next++] : tests[k].test;
    return { lag, ...correlationStats(pairs), test };
  });
}
