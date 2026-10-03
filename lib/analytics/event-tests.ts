import type { EventGroup, EventStudy } from "./event-study";
import { adjustFamily, quantileSorted, type Resampling, type TestResult } from "./inference";
import { seededRng } from "./random";
import { MIN_TEST_EVENTS } from "./sample";

/**
 * Tests for the event study, per bar and for the whole path, comparing the paths after
 * Kalshi jumps with the baseline (the stock's average path over every window this long).
 *
 * p-values come from a sign-flip test: each event's deviation from the baseline is flipped
 * at random, all bars together, and the t statistic recomputed. If jumps had nothing to do
 * with the stock's direction, a deviation would be as likely up as down, however volatile
 * the stock was around the jump. With up to 14 events every pattern is enumerated, so the
 * p-value is exact; the smallest possible is 2/2ⁿ, so 5 events can never get below 0.0625.
 *
 * Intervals are a bootstrap-t over events: events resampled with replacement, the t
 * statistic's percentiles turned into an interval. event-tests.test.ts checks its coverage.
 *
 * A placebo test (comparing with randomly placed windows) and plain percentile intervals were
 * tried first and dropped: the placebo test rejected too often when the stock was more volatile
 * around jumps, and percentile intervals covered too little. Those were development runs, not in
 * the test suite.
 */

export const SIGN_FLIP_DRAWS = 4999;
export const EVENT_BOOTSTRAP_DRAWS = 1999;
/** With at most this many events, every sign pattern is enumerated (2¹⁴ = 16,384). */
const EXACT_EVENTS = 14;

/** Index of the reference bar (offset −1), where every path is zero by construction. */
export const REFERENCE_OFFSET = -1;

export interface GroupTests {
  /** One test per offset; null at the reference bar. Estimates are mean − baseline, in %. */
  bars: (TestResult | null)[];
  /** The whole path against the baseline: the largest |t| over the bars. */
  path: TestResult;
}

export interface EventStudyTests {
  rises: GroupTests;
  falls: GroupTests;
}

/** t statistics of the mean deviation at each tested bar, with each event's deviations multiplied by its sign. */
function tStats(dev: number[][], signs: Float64Array | null, bars: number[], out: Float64Array): void {
  const n = dev.length;
  bars.forEach((k, b) => {
    let sum = 0;
    let sq = 0;
    for (let e = 0; e < n; e++) {
      const v = signs ? signs[e] * dev[e][k] : dev[e][k];
      sum += v;
      sq += v * v;
    }
    const mean = sum / n;
    const variance = (sq - n * mean * mean) / (n - 1);
    out[b] = variance > 1e-24 ? mean / Math.sqrt(variance / n) : NaN;
  });
}

/** Largest |t| over the bars where it's defined; NaN if none is. */
function maxAbs(t: Float64Array): number {
  let m = NaN;
  for (const v of t) {
    if (Number.isNaN(v)) continue;
    if (Number.isNaN(m) || Math.abs(v) > m) m = Math.abs(v);
  }
  return m;
}

function unavailableResult(estimate: number | null, n: number, resampling: Resampling): TestResult {
  return {
    estimate,
    ci: null,
    p: null,
    holm: null,
    bh: null,
    role: "exploratory",
    family: null,
    method: "sign_flip",
    interval: "event_bootstrap",
    resampling,
    n,
    nEffective: null,
    pUnavailable: "too_few_events",
    ciUnavailable: "too_few_events",
  };
}

function groupTests(group: EventGroup, baseline: number[] | null, offsets: number[], label: string): GroupTests {
  const n = group.n;
  const bars = offsets.map((_, k) => k).filter((k) => offsets[k] !== REFERENCE_OFFSET);
  const exact = n <= EXACT_EVENTS;
  const patterns = n <= 30 ? 2 ** (n - 1) : null;
  const draws = exact ? 2 ** n : SIGN_FLIP_DRAWS;
  const resampling: Resampling = {
    unit: "event",
    units: n,
    runDays: null,
    draws: n >= MIN_TEST_EVENTS ? draws : 0,
    arrangements: patterns,
    minP: Math.max(exact ? 0 : 1 / (draws + 1), patterns === null ? 0 : 1 / patterns),
  };
  const estimateAt = (k: number) => (group.mean && baseline ? group.mean[k] - baseline[k] : null);

  if (n < MIN_TEST_EVENTS || baseline === null) {
    return {
      bars: offsets.map((o, k) => (o === REFERENCE_OFFSET ? null : unavailableResult(estimateAt(k), n, resampling))),
      path: unavailableResult(null, n, resampling),
    };
  }

  const dev = group.paths.map((p) => p.map((v, k) => v - baseline[k]));
  const observed = new Float64Array(bars.length);
  tStats(dev, null, bars, observed);
  const observedMax = maxAbs(observed);

  // Sign flips: every pattern when there are few events, else random ones.
  const exceed = new Int32Array(bars.length);
  let exceedMax = 0;
  const signs = new Float64Array(n);
  const t = new Float64Array(bars.length);
  const flipRng = seededRng(`sign-flip:${label}`);
  for (let d = 0; d < draws; d++) {
    for (let e = 0; e < n; e++) signs[e] = exact ? ((d >> e) & 1 ? -1 : 1) : flipRng() < 0.5 ? -1 : 1;
    tStats(dev, signs, bars, t);
    // A hair of tolerance, so the observed pattern (all +1) counts as at least as extreme.
    t.forEach((v, b) => {
      if (Math.abs(v) >= Math.abs(observed[b]) * (1 - 1e-12)) exceed[b]++;
    });
    if (maxAbs(t) >= observedMax * (1 - 1e-12)) exceedMax++;
  }
  const pOf = (count: number) => (exact ? count / draws : (1 + count) / (1 + draws));

  // Bootstrap-t over events.
  const bootRng = seededRng(`event-bootstrap:${label}`);
  const tBoot = bars.map(() => [] as number[]);
  const resampled = new Array<number[]>(n);
  const mean = new Float64Array(bars.length);
  const sd = new Float64Array(bars.length);
  bars.forEach((k, b) => {
    const m = dev.reduce((s, p) => s + p[k], 0) / n;
    mean[b] = m;
    sd[b] = Math.sqrt(dev.reduce((s, p) => s + (p[k] - m) ** 2, 0) / (n - 1));
  });
  for (let d = 0; d < EVENT_BOOTSTRAP_DRAWS; d++) {
    for (let e = 0; e < n; e++) resampled[e] = dev[Math.floor(bootRng() * n)];
    bars.forEach((k, b) => {
      let sum = 0;
      let sq = 0;
      for (const p of resampled) {
        sum += p[k];
        sq += p[k] * p[k];
      }
      const m = sum / n;
      const v = (sq - n * m * m) / (n - 1);
      if (v > 1e-24) tBoot[b].push((m - mean[b]) / Math.sqrt(v / n));
    });
  }

  const barTests = bars.map((k, b): TestResult => {
    const ts = tBoot[b].sort((x, y) => x - y);
    const se = sd[b] / Math.sqrt(n);
    const stable = se > 0 && ts.length >= 0.9 * EVENT_BOOTSTRAP_DRAWS;
    return {
      ...unavailableResult(mean[b], n, resampling),
      ci: stable ? [mean[b] - quantileSorted(ts, 0.975) * se, mean[b] - quantileSorted(ts, 0.025) * se] : null,
      p: Number.isNaN(observed[b]) ? null : pOf(exceed[b]),
      pUnavailable: Number.isNaN(observed[b]) ? "no_variation" : null,
      ciUnavailable: stable ? null : "unstable",
    };
  });
  const byOffset = offsets.map((o, k) => (o === REFERENCE_OFFSET ? null : barTests[bars.indexOf(k)]));
  return {
    bars: byOffset,
    path: {
      ...unavailableResult(null, n, resampling),
      p: Number.isNaN(observedMax) ? null : pOf(exceedMax),
      pUnavailable: Number.isNaN(observedMax) ? "no_variation" : null,
      ciUnavailable: null,
      interval: null,
    },
  };
}

/** Exploratory tests for both groups, corrected within the bar family and the path family. */
export function eventStudyTests(study: EventStudy): EventStudyTests {
  const base = study.baseline.mean;
  const rises = groupTests(study.rises, base, study.offsets, "rises");
  const falls = groupTests(study.falls, base, study.offsets, "falls");

  const barList = [...rises.bars, ...falls.bars].filter((t): t is TestResult => t !== null);
  const adjusted = adjustFamily(barList, "event_horizons");
  let next = 0;
  const reattach = (bars: (TestResult | null)[]) => bars.map((t) => (t === null ? null : adjusted[next++]));
  const [risePath, fallPath] = adjustFamily([rises.path, falls.path], "event_paths");
  return {
    rises: { bars: reattach(rises.bars), path: risePath },
    falls: { bars: reattach(falls.bars), path: fallPath },
  };
}
